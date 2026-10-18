// Phase 4 — loopback HTTP listener that receives Claude Code hook events.
// One server per profile; a stable per-profile port (hash of userData into
// 49152–65535, probed +1 on EADDRINUSE) and a random bearer token are persisted
// in userData/claude-hooks.json. Replies `{}` immediately and forwards the
// parsed event; logs never carry cwd/tool input/response text.

import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOOK_EVENTS, HOOK_PATH_PREFIX } from '../../core/claudeHooks';
import type { ClaudeHookEvent } from '../../core/claudeActivity';
import { log } from '../log';

const PORT_MIN = 49_152;
const PORT_SPAN = 65_535 - PORT_MIN;
const PORT_PROBES = 20;
const MAX_BODY = 256 * 1024;

interface HookConfig {
  version: number;
  port: number;
  token: string;
}

export class ClaudeHookServer {
  private server: Server | null = null;
  private config: HookConfig | null = null;

  constructor(
    private readonly opts: {
      userData: string;
      onEvent: (e: ClaudeHookEvent) => void;
    },
  ) {}

  private get file(): string {
    return join(this.opts.userData, 'claude-hooks.json');
  }

  private loadOrCreateConfig(): HookConfig {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<HookConfig>;
        if (
          typeof parsed?.port === 'number' &&
          Number.isInteger(parsed.port) &&
          typeof parsed?.token === 'string' &&
          parsed.token.length > 0
        ) {
          return { version: 1, port: parsed.port, token: parsed.token };
        }
      } catch {
        /* fall through to create */
      }
    }
    const hash = createHash('sha256').update(this.opts.userData).digest();
    const port = PORT_MIN + (hash.readUInt32BE(0) % PORT_SPAN);
    return { version: 1, port, token: randomBytes(32).toString('hex') };
  }

  private persist(config: HookConfig): void {
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(config), { mode: 0o600 });
      renameSync(tmp, this.file);
      try {
        chmodSync(this.file, 0o600);
      } catch {
        /* windows chmod is advisory */
      }
    } catch (error) {
      log('claude', 'claude-hooks-error', {
        detail: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  info(): { port: number; token: string } | null {
    return this.config ? { port: this.config.port, token: this.config.token } : null;
  }

  start(): Promise<{ port: number } | { error: string }> {
    try {
      const config = this.loadOrCreateConfig();
      this.server = createServer((request, response) => this.handle(request, response));
      return new Promise((resolve) => {
        let port = config.port;
        const tryBind = (probed: number) => {
          this.server!.once('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'EADDRINUSE' && probed < PORT_PROBES) {
              port += 1;
              tryBind(probed + 1);
            } else {
              log('claude', 'claude-hooks-error', {
                detail: { message: error.message, code: error.code },
              });
              resolve({ error: error.message });
            }
          });
          this.server!.once('listening', () => {
            this.config = { ...config, port };
            this.persist(this.config);
            log('claude', 'claude-hooks-listen', {
              detail: { port, probed },
            });
            resolve({ port });
          });
          this.server!.listen(port, '127.0.0.1');
        };
        tryBind(0);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('claude', 'claude-hooks-error', { detail: { message } });
      return Promise.resolve({ error: message });
    }
  }

  private handle(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): void {
    const match = new RegExp(`^${HOOK_PATH_PREFIX}([A-Za-z]+)$`).exec(request.url ?? '');
    if (!match) {
      response.writeHead(404).end();
      return;
    }
    const event = match[1]!;
    const expected = `Bearer ${this.config?.token}`;
    const given = request.headers.authorization ?? '';
    const authOk =
      given.length === expected.length &&
      timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!authOk) {
      log('claude', 'claude-hook-rejected', { detail: { reason: 'auth' } });
      response.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        log('claude', 'claude-hook-rejected', { detail: { reason: 'size' } });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      if (!HOOK_EVENTS.includes(event as (typeof HOOK_EVENTS)[number])) {
        log('claude', 'claude-hook-ignored', { detail: { event, reason: 'event' } });
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        log('claude', 'claude-hook-rejected', { detail: { reason: 'json' } });
        return;
      }
      if (typeof parsed.session_id !== 'string' || parsed.session_id.length === 0) {
        log('claude', 'claude-hook-ignored', { detail: { event, reason: 'no-session' } });
        return;
      }
      log('claude', 'claude-hook', {
        detail: { event, hasSession: true },
      });
      this.opts.onEvent({ ...parsed, event, receivedAt: Date.now() } as ClaudeHookEvent);
    });
    request.on('error', () => {
      try {
        response.destroy();
      } catch {
        /* best effort */
      }
    });
  }

  dispose(): void {
    try {
      this.server?.close();
    } catch {
      /* best effort */
    }
    this.server = null;
  }
}
