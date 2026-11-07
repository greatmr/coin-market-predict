import { describe, expect, it } from 'vitest';

import { assertTrustedWrite } from './write-guard.js';

const req = (headers: Record<string, string> = {}, json = true) =>
  ({
    is: (t: string) => (json && t === 'application/json' ? 'application/json' : false),
    headers: { host: '127.0.0.1:3000', ...headers },
  }) as never;

describe('dashboard write guard', () => {
  it('accepts same-origin JSON, with or without an Origin header', () => {
    expect(() => assertTrustedWrite(req())).not.toThrow();
    expect(() => assertTrustedWrite(req({ origin: 'http://127.0.0.1:3000' }))).not.toThrow();
    expect(() => assertTrustedWrite(req({ 'sec-fetch-site': 'same-origin' }))).not.toThrow();
  });

  it('refuses cross-site, malformed and null origins', () => {
    for (const origin of ['https://evil.example', 'http://127.0.0.1:9999', 'null', 'not a url']) {
      expect(() => assertTrustedWrite(req({ origin }))).toThrow(/Cross-origin/);
    }
  });

  it('refuses requests the browser marks as cross-site', () => {
    expect(() => assertTrustedWrite(req({ 'sec-fetch-site': 'cross-site' }))).toThrow(/Cross-site/);
  });

  it('refuses non-JSON bodies (form posts are CORS-simple)', () => {
    expect(() => assertTrustedWrite(req({}, false))).toThrow(/JSON/);
  });
});
