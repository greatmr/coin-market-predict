import { resolve } from 'node:path';

/** Non-secret variables the agent's process may inherit (locale, time zone, TLS trust, proxies). */
const PASSTHROUGH = [
  'LANG',
  'LC_ALL',
  'TZ',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
] as const;

/**
 * The complete environment of the agent's Claude Code process, built from an allowlist (the SDK
 * replaces the subprocess environment with it). The server's own variables — DATABASE_URL, the
 * Telegram token, MCP tokens, passwords — are never forwarded, and ANTHROPIC_API_KEY /
 * ANTHROPIC_AUTH_TOKEN are deliberately absent so the process cannot fall back to paid API-key
 * authentication: the subscription OAuth token is its only credential. HOME and the Claude
 * configuration live under the agent's own state directory, so no developer settings, memory or
 * MCP servers of the machine are picked up.
 */
export function buildAgentEnv(
  token: string | undefined,
  stateDir: string,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: source.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: resolve(stateDir, 'home'),
    CLAUDE_CONFIG_DIR: resolve(stateDir, 'claude-config'),
    TMPDIR: resolve(stateDir, 'tmp'),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'coins-predicts/0.1.0',
  };
  for (const key of PASSTHROUGH) {
    const value = source[key];
    if (value) env[key] = value;
  }
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

/** Directories the agent's process uses, created on demand (0700). */
export const AGENT_STATE_SUBDIRS = ['home', 'claude-config', 'tmp', 'workspace'] as const;
