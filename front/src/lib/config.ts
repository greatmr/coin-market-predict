// Runtime configuration, read once at start from /app-config.json (written by the web container from
// its environment, so one image works on the same origin or with the API on another host).
//   apiBase: ''                                  -> same origin: /api/... (the default)
//   apiBase: 'https://api.predict.example.com'   -> that host: https://api.../api/...

export interface RuntimeConfig {
  apiBase: string;
}

const runtime: RuntimeConfig = { apiBase: '' };

export async function loadRuntimeConfig(): Promise<void> {
  try {
    const r = await fetch('/app-config.json', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!r.ok) return;
    const j: unknown = await r.json();
    if (j && typeof j === 'object' && typeof (j as RuntimeConfig).apiBase === 'string')
      runtime.apiBase = (j as RuntimeConfig).apiBase.trim().replace(/\/+$/, '');
  } catch {
    /* no runtime config: same origin */
  }
}

/** Absolute or same-origin URL of an API path, e.g. apiUrl('exports/…/file.csv'). */
export const apiUrl = (path: string): string =>
  `${runtime.apiBase}/api/${path.replace(/^\/+/, '')}`;

/** True when the API is on another origin (cookies then need credentials: 'include'). */
export const apiIsCrossOrigin = (): boolean => runtime.apiBase !== '';
