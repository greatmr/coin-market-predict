import "reflect-metadata";
import { ConsoleLogger, type LogLevel } from "@nestjs/common";
import { ConfigError, loadConfig, type AppConfig } from "./config/config.js";
import { redact, registerSecretsFromEnv } from "./config/redact.js";

/** Logger that masks registered secrets and known credential shapes in every line. */
export class RedactingLogger extends ConsoleLogger {
  constructor(private readonly toStderr = false) {
    super();
  }
  // Extra args are Nest's optional (stack, context) positions: keep undefined/null as-is so
  // Nest's own argument handling works, and mask strings (stack traces can contain secrets).
  override log(message: unknown, ...rest: unknown[]) {
    super.log(redact(message), ...rest);
  }
  override warn(message: unknown, ...rest: unknown[]) {
    super.warn(redact(message), ...rest);
  }
  override error(message: unknown, ...rest: unknown[]) {
    super.error(redact(message), ...rest.map((r) => (typeof r === "string" ? redact(r) : r)));
  }
  override debug(message: unknown, ...rest: unknown[]) {
    super.debug(redact(message), ...rest);
  }
  protected override printMessages(messages: unknown[], context?: string, logLevel?: LogLevel, writeStreamType?: "stdout" | "stderr") {
    super.printMessages(messages, context, logLevel, this.toStderr ? "stderr" : writeStreamType);
  }
}

export function loadConfigOrExit(env: NodeJS.ProcessEnv = process.env): AppConfig {
  try {
    const cfg = loadConfig(env);
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
