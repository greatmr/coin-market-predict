/** DI token of the validated, typed configuration (`AppConfig`). */
export const APP_CONFIG = Symbol('APP_CONFIG');

/** DI token of what the configuration was built from (`ConfigInputs`). */
export const CONFIG_INPUTS = Symbol('CONFIG_INPUTS');

/**
 * What one process's configuration was built from, so a saved dashboard setting is validated and
 * applied against the same environment. Never re-read from `process.env` inside the application:
 * tests pass their own environment.
 */
export interface ConfigInputs {
  env: NodeJS.ProcessEnv;
  /** Values this process forces over every source (the CLI and MCP stdio: no scheduler). */
  forced: Record<string, string>;
}
