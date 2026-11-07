import { describe, expect, it } from 'vitest';

import { redact, registerSecrets } from './redact.js';

describe('redaction', () => {
  it('masks registered secrets and known credential shapes', () => {
    registerSecrets(['super-secret-value-123']);
    expect(redact('error: super-secret-value-123 failed')).not.toMatch(/super-secret/);
    expect(
      redact('POST https://api.telegram.org/bot123456789:AAAbbbCCCdddEEEfffGGGhhh/sendMessage'),
    ).not.toMatch(/AAAbbb/);
    expect(redact('Authorization: Bearer abcdefghijklmnop')).not.toMatch(/abcdefghijklmnop/);
    expect(redact(`token ${'sk-ant-'}oat01-abcdefghijklmnopqrstuvwxyz`)).not.toMatch(
      /abcdefghijklmnop/,
    );
    expect(redact('postgresql://u:pw@h/db')).toBe('postgresql://u:***@h/db');
  });

  it('never throws on undefined, null or non-JSON values (Nest passes undefined stacks)', () => {
    expect(redact(undefined)).toBe('undefined');
    expect(redact(null)).toBe('null');
    expect(redact(() => 1)).toMatch(/=>/);
  });

  it("shows the network cause behind Node's generic 'fetch failed', still masking secrets", () => {
    const timeout = Object.assign(
      new Error(
        'Connect Timeout Error (attempted address: api.telegram.org:443, timeout: 10000ms)',
      ),
      { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' },
    );
    expect(redact(new TypeError('fetch failed', { cause: timeout }))).toBe(
      'TypeError: fetch failed (cause: ConnectTimeoutError: Connect Timeout Error (attempted address: api.telegram.org:443, timeout: 10000ms) [UND_ERR_CONNECT_TIMEOUT])',
    );
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND api.telegram.org'), {
      code: 'ENOTFOUND',
    });
    expect(redact(new TypeError('fetch failed', { cause: dns }))).toBe(
      'TypeError: fetch failed (cause: Error: getaddrinfo ENOTFOUND api.telegram.org)',
    );
    const leaky = new TypeError('fetch failed', {
      cause: new Error(
        'socket closed for https://api.telegram.org/bot123456789:AAAbbbCCCdddEEEfffGGGhhh/getUpdates',
      ),
    });
    expect(redact(leaky)).not.toMatch(/AAAbbb/);
  });
});
