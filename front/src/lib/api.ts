// REST client for the NestJS API. Every response is an envelope:
// `{ data, errors: null }` or `{ data: null, errors: [{ message, code }] }`.
import { apiUrl } from './config';

interface Envelope<T> {
  data: T | null;
  errors: { message?: string; code?: string }[] | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly detail: string;
  constructor(message: string, status: number, code: string | null, detail: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export type AuthLostMode = 'login' | 'change';
let onAuthLost: ((mode: AuthLostMode, notice?: string) => void) | null = null;
/** Set by the session provider: a lost session goes to sign-in, a pending password change to that form. */
export function setAuthLostHandler(fn: typeof onAuthLost): void {
  onAuthLost = fn;
}

async function readEnvelope<T>(r: Response): Promise<Envelope<T> | null> {
  const text = await r.text();
  try {
    return text ? (JSON.parse(text) as Envelope<T>) : null;
  } catch {
    return null;
  }
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const init: RequestInit = { method, headers, credentials: 'include' };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let r: Response;
  try {
    r = await fetch(apiUrl(path), init);
  } catch (e) {
    throw new ApiError(
      `The API is unreachable (${e instanceof Error ? e.message : String(e)})`,
      0,
      'NETWORK',
      '',
    );
  }
  const res = await readEnvelope<T>(r);
  if (!r.ok) {
    const errors = res && Array.isArray(res.errors) ? res.errors : [];
    const code = errors[0]?.code ?? null;
    const detail = errors
      .map((e) => e?.message)
      .filter(Boolean)
      .join(', ');
    const err = new ApiError(detail || `HTTP ${r.status}`, r.status, code, detail);
    if (!path.startsWith('auth/') && onAuthLost) {
      if (code === 'AUTH_REQUIRED') onAuthLost('login', 'Your session ended. Sign in again.');
      else if (code === 'PASSWORD_CHANGE_REQUIRED') onAuthLost('change');
    }
    throw err;
  }
  return (res ? res.data : null) as T;
}

export const api = <T>(path: string) => request<T>('GET', path);
export const apiPost = <T>(path: string, body?: unknown) => request<T>('POST', path, body);
export const apiPatch = <T>(path: string, body?: unknown) => request<T>('PATCH', path, body);
export const apiDelete = <T>(path: string) => request<T>('DELETE', path, {});

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
