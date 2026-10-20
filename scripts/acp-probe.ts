import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type InitializeRequest,
} from '@agentclientprotocol/sdk';

const timeoutMs = 30_000;
const cloudOnly = process.argv.includes('--cloud');
const evidenceDir = resolve(process.env.AGENT_WORKSPACE_EVIDENCE_DIR ?? 'docs/evidence');
const initializePath = join(evidenceDir, cloudOnly ? 'acp-initialize-cloud.json' : 'acp-initialize.json');
const roundtripPath = join(evidenceDir, 'acp-roundtrip.jsonl');
const executable = process.env.DEVIN_CLI ?? join(process.env.HOME ?? '', '.local', 'bin', 'devin');
let workspace = '';

let stderrText = '';
let logStream: Awaited<ReturnType<typeof openLog>> | null = null;

async function openLog() {
  return createWriteStream(roundtripPath, { flags: cloudOnly ? 'a' : 'w' });
}

function writeRecord(record: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
  process.stdout.write(`${line}\n`);
  logStream?.write(`${line}\n`);
}

function withTimeout<T>(promise: Promise<T>, operation: string, milliseconds = timeoutMs): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${operation} timed out after ${milliseconds}ms`)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function unauthenticated(error: unknown): boolean {
  return /auth[_ -]?required|unauthenticated|not authenticated|not logged in|authentication required|please log in|sign in|unauthorized|(?:http|status(?: code)?)\s*401/i.test(
    `${errorMessage(error)}\n${stderrText}`,
  );
}

function executableCandidates(): string[] {
  const pathEntries = (process.env.PATH ?? '').split(delimiter);
  return [
    executable,
    ...pathEntries.map((entry) => join(entry, 'devin')),
  ];
}

async function resolveExecutable(): Promise<string> {
  for (const candidate of executableCandidates()) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`Could not find the Devin CLI (checked ${executable} and PATH)`);
}

async function startAgent(args: string[]): Promise<ChildProcessWithoutNullStreams> {
  const binary = await resolveExecutable();
  const processRef = spawn(binary, args, {
    cwd: workspace,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  processRef.stderr.setEncoding('utf8');
  processRef.stderr.on('data', (chunk: string) => {
    stderrText += chunk;
    writeRecord({ kind: 'stderr', text: chunk });
  });
  processRef.on('error', (error) => writeRecord({ kind: 'process-error', error: errorMessage(error) }));
  return processRef;
}

async function stopAgent(processRef: ChildProcessWithoutNullStreams): Promise<void> {
  if (processRef.exitCode !== null || processRef.signalCode !== null) return;
  await new Promise<void>((resolveExit) => {
    let settled = false;
    let fallbackTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(terminateTimer);
      clearTimeout(forceTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      resolveExit();
    };
    const terminateTimer = setTimeout(() => processRef.kill('SIGTERM'), 700);
    const forceTimer = setTimeout(() => {
      processRef.kill('SIGKILL');
      fallbackTimer = setTimeout(finish, 1000);
    }, 2200);
    processRef.once('exit', finish);
    processRef.stdin.end();
  });
}

async function settleProcessOutput(processRef: ChildProcessWithoutNullStreams): Promise<void> {
  if (processRef.stdout.closed && processRef.stderr.closed) return;
  await new Promise<void>((resolveOutput) => {
    const onClose = () => {
      clearTimeout(timer);
      resolveOutput();
    };
    const timer = setTimeout(() => {
      processRef.off('close', onClose);
      resolveOutput();
    }, 500);
    processRef.once('close', onClose);
  });
}

async function run(): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  workspace = await mkdtemp(join(tmpdir(), 'agent-workspace-acp-'));
  logStream = await openLog();
  let processRef: ChildProcessWithoutNullStreams | null = null;
  let status = 'error';
  let initializeRequest: InitializeRequest | null = null;
  let initializeResponse: Awaited<ReturnType<ClientSideConnection['initialize']>> | null = null;
  let connection: ClientSideConnection | null = null;

  try {
    processRef = await startAgent(cloudOnly ? ['acp', '--cloud'] : ['acp']);
    const stream = ndJsonStream(
      Writable.toWeb(processRef.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(processRef.stdout) as ReadableStream<Uint8Array>,
    );
    const client: Client = {
      async sessionUpdate(params) {
        writeRecord({ kind: 'session/update', params });
      },
      async requestPermission(params) {
        writeRecord({ kind: 'session/request_permission', params, decision: 'cancelled' });
        return { outcome: { outcome: 'cancelled' } };
      },
    };
    connection = new ClientSideConnection(() => client, stream);
    initializeRequest = {
      protocolVersion: 1,
      clientInfo: {
        name: 'agent-workspace-p0-probe',
        version: '0.1.0',
      },
      clientCapabilities: {},
    };
    try {
      initializeResponse = await withTimeout(
        connection.initialize(initializeRequest),
        'initialize',
      );
      status = 'initialized';
    } catch (error) {
      await settleProcessOutput(processRef);
      const message = errorMessage(error);
      status = unauthenticated(error) ? 'unauthenticated' : 'initialize-error';
      writeRecord({ kind: 'initialize-error', error: message, stderr: stderrText });
      await writeFile(
        initializePath,
        `${JSON.stringify(
          {
            status,
            command: [executable, ...(cloudOnly ? ['acp', '--cloud'] : ['acp'])],
            request: initializeRequest,
            error: message,
            stderr: stderrText,
          },
          null,
          2,
        )}\n`,
      );
      if (status !== 'unauthenticated') throw error;
      return;
    }

    await writeFile(
      initializePath,
      `${JSON.stringify(
        {
          status,
          command: [executable, ...(cloudOnly ? ['acp', '--cloud'] : ['acp'])],
          request: initializeRequest,
          response: initializeResponse,
          observedCapabilities: {
            loadSession: initializeResponse.agentCapabilities?.loadSession ?? false,
            sessionList: Boolean(initializeResponse.agentCapabilities?.sessionCapabilities?.list),
          },
          authMethods: initializeResponse.authMethods ?? [],
          stderr: stderrText,
        },
        null,
        2,
      )}\n`,
    );
    writeRecord({
      kind: 'initialize',
      request: initializeRequest,
      response: initializeResponse,
      status,
    });
    if (cloudOnly) return;

    let sessionId: string;
    try {
      const request = { cwd: workspace, mcpServers: [] };
      writeRecord({ kind: 'session/new-request', request });
      const response = await withTimeout(connection.newSession(request), 'session/new');
      sessionId = response.sessionId;
      writeRecord({ kind: 'session/new-response', response });
      status = 'roundtrip';
    } catch (error) {
      await settleProcessOutput(processRef);
      const message = errorMessage(error);
      status = unauthenticated(error) ? 'unauthenticated' : 'session-new-error';
      writeRecord({ kind: 'session/new-error', error: message, stderr: stderrText });
      if (status !== 'unauthenticated') throw error;
      return;
    }

    try {
      const request = {
        sessionId,
        prompt: [{ type: 'text' as const, text: 'Reply with exactly: pong' }],
      };
      writeRecord({ kind: 'session/prompt-request', request });
      const response = await withTimeout(connection.prompt(request), 'first session/prompt', 90_000);
      writeRecord({ kind: 'session/prompt-response', response, stopReason: response.stopReason });
    } catch (error) {
      await settleProcessOutput(processRef);
      const message = errorMessage(error);
      status = unauthenticated(error) ? 'unauthenticated' : 'prompt-error';
      writeRecord({ kind: 'session/prompt-error', error: message, stderr: stderrText });
      if (status !== 'unauthenticated') throw error;
      return;
    }

    const secondRequest = {
      sessionId,
      prompt: [{ type: 'text' as const, text: 'Count from 1 to 100 slowly.' }],
    };
    writeRecord({ kind: 'session/prompt-cancel-request', request: secondRequest });
    const secondPrompt = connection.prompt(secondRequest);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));
    await withTimeout(connection.cancel({ sessionId }), 'session/cancel');
    writeRecord({ kind: 'session/cancel', sessionId });
    try {
      const response = await withTimeout(secondPrompt, 'cancelled session/prompt', 60_000);
      writeRecord({ kind: 'session/prompt-cancel-response', response, stopReason: response.stopReason });
    } catch (error) {
      writeRecord({ kind: 'session/prompt-cancel-error', error: errorMessage(error) });
    }

    const capabilities = initializeResponse.agentCapabilities;
    if (capabilities?.sessionCapabilities?.list) {
      try {
        const request = { cwd: workspace };
        const response = await withTimeout(connection.listSessions(request), 'session/list');
        writeRecord({ kind: 'session/list', request, response });
        const loadTarget = response.sessions[0]?.sessionId ?? sessionId;
        if (capabilities.loadSession) {
          const loadRequest = { sessionId: loadTarget, cwd: workspace, mcpServers: [] };
          const loadResponse = await withTimeout(connection.loadSession(loadRequest), 'session/load');
          writeRecord({ kind: 'session/load', request: loadRequest, response: loadResponse });
        }
      } catch (error) {
        writeRecord({ kind: 'session-list-or-load-error', error: errorMessage(error) });
      }
    } else if (capabilities?.loadSession) {
      try {
        const request = { sessionId, cwd: workspace, mcpServers: [] };
        const response = await withTimeout(connection.loadSession(request), 'session/load');
        writeRecord({ kind: 'session/load', request, response });
      } catch (error) {
        writeRecord({ kind: 'session/load-error', error: errorMessage(error) });
      }
    }
  } catch (error) {
    if (processRef) await settleProcessOutput(processRef);
    status = unauthenticated(error) ? 'unauthenticated' : 'error';
    writeRecord({ kind: 'probe-error', error: errorMessage(error), stderr: stderrText });
    if (!unauthenticated(error)) process.exitCode = 1;
  } finally {
    if (processRef) await stopAgent(processRef);
    writeRecord({ kind: 'probe-finished', status, stderr: stderrText });
    await new Promise<void>((resolveClose) => logStream?.end(resolveClose) ?? resolveClose());
    await rm(workspace, { recursive: true, force: true });
    if (status === 'unauthenticated') process.exitCode = 0;
  }
}

void run();
