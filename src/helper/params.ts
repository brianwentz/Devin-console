// RPC error type and param readers shared by the helper's method modules.

export type RpcErrorCode = 'unknown-method' | 'bad-params' | 'too-large' | 'internal';

export class RpcError extends Error {
  constructor(
    readonly code: RpcErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type Handler = (params: unknown) => unknown;

const MAX_MESSAGE = 200;
// Absolute POSIX or Windows paths, quoted or bare — error text must not carry them.
const PATH_RE = /'[^']*[\\/][^']*'|"[^"]*[\\/][^"]*"|(?:[A-Za-z]:)?[\\/][^\s,'"]+/g;

/** Error text safe to send to the app: no paths, ≤200 chars. */
export function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.replace(PATH_RE, '<path>').replace(/\s+/g, ' ').trim() || 'error';
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

function obj(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  if (typeof params !== 'object' || Array.isArray(params)) throw new RpcError('bad-params', 'params must be an object');
  return params as Record<string, unknown>;
}

export function str(params: unknown, key: string): string {
  const v = obj(params)[key];
  if (typeof v !== 'string' || v === '') throw new RpcError('bad-params', `${key} must be a non-empty string`);
  return v;
}

export function optStr(params: unknown, key: string): string | undefined {
  const v = obj(params)[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new RpcError('bad-params', `${key} must be a string`);
  return v;
}

export function bool(params: unknown, key: string): boolean {
  const v = obj(params)[key];
  if (typeof v !== 'boolean') throw new RpcError('bad-params', `${key} must be a boolean`);
  return v;
}

export function optInt(params: unknown, key: string, min: number, max: number): number | undefined {
  const v = obj(params)[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new RpcError('bad-params', `${key} must be an integer in ${min}..${max}`);
  }
  return v;
}

export function int(params: unknown, key: string, min: number, max: number): number {
  const v = optInt(params, key, min, max);
  if (v === undefined) throw new RpcError('bad-params', `${key} is required`);
  return v;
}
