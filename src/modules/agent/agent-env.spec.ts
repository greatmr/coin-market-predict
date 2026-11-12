import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildAgentEnv } from './agent-env.js';

describe("the agent process's environment (allowlist)", () => {
  const server = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/operator',
    TZ: 'UTC',
    DATABASE_URL: 'postgresql://coins:secret@db/coins',
    POSTGRES_PASSWORD: 'secret',
    TELEGRAM_BOT_TOKEN: '123:abc',
    MCP_READ_TOKEN: 'read-token-value',
    ANTHROPIC_API_KEY: 'sk-ant-api03-paid-key',
    ANTHROPIC_AUTH_TOKEN: 'another-credential',
    CLAUDE_CODE_OAUTH_TOKEN: 'inherited-token-must-not-be-used',
  };

  it("never forwards the server's secrets or any API-key credential", () => {
    const env = buildAgentEnv('sk-ant-oat01-configured', '/srv/agent', server);
    for (const key of [
      'DATABASE_URL',
      'POSTGRES_PASSWORD',
      'TELEGRAM_BOT_TOKEN',
      'MCP_READ_TOKEN',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
    ])
      expect(env).not.toHaveProperty(key);
    expect(JSON.stringify(env)).not.toMatch(/secret|paid-key|another-credential|inherited/);
  });

  it('passes the configured subscription token as the only credential', () => {
    expect(
      buildAgentEnv('sk-ant-oat01-configured', '/srv/agent', server).CLAUDE_CODE_OAUTH_TOKEN,
    ).toBe('sk-ant-oat01-configured');
    expect(buildAgentEnv(undefined, '/srv/agent', server)).not.toHaveProperty(
      'CLAUDE_CODE_OAUTH_TOKEN',
    );
  });

  it("isolates the process from the machine's Claude settings and keeps locale and PATH", () => {
    const env = buildAgentEnv('t', '/srv/agent', server);
    expect(env.HOME).toBe(resolve('/srv/agent', 'home'));
    expect(env.CLAUDE_CONFIG_DIR).toBe(resolve('/srv/agent', 'claude-config'));
    expect(env.TMPDIR).toBe(resolve('/srv/agent', 'tmp'));
    expect([env.PATH, env.TZ, env.DISABLE_AUTOUPDATER]).toEqual(['/usr/bin:/bin', 'UTC', '1']);
  });
});
