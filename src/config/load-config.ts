import { registerSecretsFromEnv } from '../common/security/redact.js';

import { type AppConfig, ConfigError, loadConfig } from './env.validation.js';
import type { SavedSettings } from './settings.catalog.js';

/**
 * Entry-point helper (server, CLI, MCP stdio): validate the environment and the saved dashboard
 * settings before Nest boots and register every secret value for log redaction. Invalid
 * configuration exits with code 2 and a message that names variables, never values.
 */
export function loadConfigOrExit(
  env: NodeJS.ProcessEnv = process.env,
  saved: SavedSettings = {},
): AppConfig {
  try {
    const cfg = loadConfig(env, saved);
    registerSecretsFromEnv({ ...env, ...(cfg as unknown as Record<string, string | undefined>) });
    return cfg;
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
}
