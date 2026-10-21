import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { app } from 'electron';
import { z } from 'zod';
import {
  addObservation,
  inferUserId,
  maskUserId,
  parseAuthStatus,
  type IdentitySource,
  type ParsedAuthStatus,
  type SessionObservation,
} from '../core/identityModel';
import { resolveDevinPath } from './local/acpHost';
import { log } from './log';

const CLI_TIMEOUT_MS = 10_000;
const CLI_OUTPUT_CAP = 64 * 1024;

const PersistedIdentitySchema = z.object({
  userId: z.string(),
  source: z.enum(['cli', 'inferred']),
  resolvedAt: z.number(),
});
type PersistedIdentity = z.infer<typeof PersistedIdentitySchema>;

export interface ResolvedIdentity {
  userId: string;
  source: IdentitySource;
}

function resolveOnPath(name: string): string | null {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const result = spawnSync(lookup, [name], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) return null;
    const first = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

// Resolves the signed-in user for service-user tokens. Order: manual override,
// `devin auth status`, persisted identity.json, inference from observed
// sessions. Sources rejected by the first-poll confirmation are skipped for
// the rest of the notifier generation.
export class IdentityResolver {
  private readonly file: string;
  private readonly testMode: boolean;
  private persisted: PersistedIdentity | null = null;
  private observations: SessionObservation[] = [];
  private rejected = new Set<IdentitySource>();
  private cliRan = false;
  private cliResult: ParsedAuthStatus | null = null;
  private resolvedNow: ResolvedIdentity | null = null;
  private cliOrgMismatch = false;

  constructor(userData: string, testMode: boolean) {
    this.file = join(userData, 'identity.json');
    this.testMode = testMode;
    try {
      const parsed = PersistedIdentitySchema.safeParse(
        JSON.parse(readFileSync(this.file, 'utf8')),
      );
      this.persisted = parsed.success ? parsed.data : null;
    } catch {
      this.persisted = null;
    }
  }

  // The command behind the 'cli' source: the test override splits on
  // whitespace and resolves relative args against the app path, exactly like
  // TerminalHost.resolveCommand; otherwise the real `devin` binary.
  private cliCommand(override: string | null | undefined): { file: string; args: string[] } | null {
    if (this.testMode && process.env.AGENT_WORKSPACE_TEST_AUTH_STATUS_CMD) {
      const [file, ...args] = process.env.AGENT_WORKSPACE_TEST_AUTH_STATUS_CMD
        .split(/\s+/)
        .filter(Boolean);
      if (!file) return null;
      const resolvedFile = existsSync(file) ? file : resolveOnPath(file);
      if (!resolvedFile) return null;
      const resolvedArgs = args.map((arg) => {
        if (isAbsolute(arg)) return arg;
        const candidate = resolve(app.getAppPath(), arg);
        return existsSync(candidate) ? candidate : arg;
      });
      return { file: resolvedFile, args: resolvedArgs };
    }
    const devinPath = resolveDevinPath(override);
    return devinPath ? { file: devinPath, args: ['auth', 'status'] } : null;
  }

  private runCli(override: string | null | undefined): Promise<ParsedAuthStatus | null> {
    const command = this.cliCommand(override);
    const started = Date.now();
    if (!command) {
      log('shell', 'identity-resolve', {
        detail: {
          source: 'cli',
          ok: false,
          exitCode: null,
          hasUserId: false,
          hasOrgId: false,
          durationMs: Date.now() - started,
        },
      });
      return Promise.resolve(null);
    }
    return new Promise<ParsedAuthStatus | null>((resolvePromise) => {
      let stdout = '';
      let settled = false;
      const finish = (exitCode: number | null, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const parsed = exitCode === null && error ? null : parseAuthStatus(stdout);
        log('shell', 'identity-resolve', {
          detail: {
            source: 'cli',
            ok: parsed?.userId != null,
            exitCode,
            hasUserId: parsed?.userId != null,
            hasOrgId: parsed?.orgId != null,
            durationMs: Date.now() - started,
          },
        });
        resolvePromise(parsed);
      };
      const child = spawn(command.file, command.args, { windowsHide: true });
      const timer = setTimeout(() => child.kill(), CLI_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length >= CLI_OUTPUT_CAP) return;
        stdout += chunk.toString('utf8').slice(0, CLI_OUTPUT_CAP - stdout.length);
      });
      child.on('error', (error) => finish(null, error));
      child.on('close', (code) => finish(code));
    });
  }

  async resolve(input: {
    manualUserId: string;
    devinPathOverride: string | null | undefined;
  }): Promise<ResolvedIdentity | null> {
    const started = Date.now();
    const done = (identity: ResolvedIdentity | null): ResolvedIdentity | null => {
      this.resolvedNow = identity ?? this.resolvedNow;
      // The cli source already logged its richer detail inside runCli.
      if (identity && identity.source !== 'cli') {
        log('shell', 'identity-resolve', {
          detail: { source: identity.source, ok: true, durationMs: Date.now() - started },
        });
      }
      return identity;
    };
    const manual = input.manualUserId.trim();
    if (manual && !this.rejected.has('manual')) {
      return done({ userId: manual, source: 'manual' });
    }
    if (!this.rejected.has('cli')) {
      if (!this.cliRan) {
        this.cliRan = true;
        this.cliResult = await this.runCli(input.devinPathOverride);
      }
      if (this.cliResult?.userId) {
        // Persist so a later CLI sign-out doesn't lose the confirmed identity.
        this.persistIdentity({
          userId: this.cliResult.userId,
          source: 'cli',
          resolvedAt: Date.now(),
        });
        return done({ userId: this.cliResult.userId, source: 'cli' });
      }
    }
    if (this.persisted && !this.rejected.has(this.persisted.source)) {
      return done({ userId: this.persisted.userId, source: this.persisted.source });
    }
    const inferred = inferUserId(this.observations);
    if (inferred && !this.rejected.has('inferred')) {
      this.persistIdentity({ userId: inferred.userId, source: 'inferred', resolvedAt: Date.now() });
      return done({ userId: inferred.userId, source: 'inferred' });
    }
    return null;
  }

  // Feeds a fetched session into the observation list; returns (and persists)
  // an identity as soon as the vote logic accepts one.
  observe(
    sessionId: string,
    session: { user_id: string | null; created_at: number },
  ): ResolvedIdentity | null {
    if (!session.user_id) {
      log('shell', 'identity-observe', {
        detail: { accepted: false, observations: this.observations.length },
      });
      return null;
    }
    this.observations = addObservation(this.observations, {
      sessionId,
      userId: session.user_id,
      createdAt: session.created_at,
      observedAt: Date.now(),
    });
    const inferred = inferUserId(this.observations);
    log('shell', 'identity-observe', {
      detail: { accepted: inferred !== null, observations: this.observations.length },
    });
    if (!inferred || this.rejected.has('inferred')) return null;
    this.persistIdentity({ userId: inferred.userId, source: 'inferred', resolvedAt: Date.now() });
    this.resolvedNow = { userId: inferred.userId, source: 'inferred' };
    return this.resolvedNow;
  }

  // The confirmed-first-poll check failed for this source: skip it for the
  // rest of the generation and drop a persisted entry with the same source.
  reject(source: IdentitySource): void {
    this.rejected.add(source);
    if (this.persisted?.source === source) this.clearPersisted();
    if (this.resolvedNow?.source === source) this.resolvedNow = null;
    log('shell', 'identity-rejected', { detail: { source } });
  }

  reset(): void {
    this.clearPersisted();
    this.observations = [];
    this.resetGeneration();
    this.resolvedNow = null;
    this.cliOrgMismatch = false;
    log('shell', 'identity-reset', {});
  }

  // notifier.restart(): the CLI result and rejection set are per-generation;
  // the persisted entry and observations survive.
  resetGeneration(): void {
    this.cliRan = false;
    this.cliResult = null;
    this.rejected.clear();
    this.resolvedNow = null;
    this.cliOrgMismatch = false;
  }

  current(): {
    source: IdentitySource | null;
    maskedUserId: string | null;
    cliOrgMismatch: boolean;
  } {
    return {
      source: this.resolvedNow?.source ?? null,
      maskedUserId: this.resolvedNow ? maskUserId(this.resolvedNow.userId) : null,
      cliOrgMismatch: this.cliOrgMismatch,
    };
  }

  // PAT path: /v3/self returned the token's own user id.
  setSelfIdentity(userId: string): void {
    this.resolvedNow = { userId, source: 'self' };
  }

  // The CLI's "Primary org" vs the token's org — set once per generation by
  // the notifier (it owns the comparison; this just records it for current()).
  setCliOrgMismatch(mismatch: boolean): void {
    this.cliOrgMismatch = mismatch;
  }

  cliOrgId(): string | null {
    return this.cliResult?.orgId ?? null;
  }

  private persistIdentity(entry: PersistedIdentity): void {
    this.persisted = entry;
    try {
      writeFileSync(this.file, JSON.stringify(entry));
    } catch (error) {
      log('shell', 'identity-save-error', { detail: { message: String(error) } });
    }
  }

  private clearPersisted(): void {
    this.persisted = null;
    try {
      rmSync(this.file, { force: true });
    } catch {
      // best effort
    }
  }
}

let resolver: IdentityResolver | null = null;

export function identityResolver(userData?: string, testMode = false): IdentityResolver {
  if (!resolver) {
    if (!userData) throw new Error('identityResolver not initialised');
    resolver = new IdentityResolver(userData, testMode);
  }
  return resolver;
}
