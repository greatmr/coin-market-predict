import { readFileSync } from "node:fs";
import { z } from "zod";

/** Environment variables that hold secrets. Values are never logged or exposed. */
export const SECRET_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "CMC_API_KEY",
  "COINGECKO_API_KEY",
  "MCP_READ_TOKEN",
  "MCP_WRITE_TOKEN",
  "DASHBOARD_BASIC_AUTH",
] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    DISPLAY_TIMEZONE: z.string().default("Asia/Tehran"),

    DATA_SOURCE: z.enum(["fixture", "coinmarketcap", "coinmarketcap_web", "coingecko"]).default("fixture"),
    CMC_API_KEY: optionalSecret,
    COINGECKO_API_KEY: optionalSecret,
    SOURCE_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(500).default(10),
    SOURCE_MONTHLY_REQUEST_BUDGET: z.coerce.number().int().min(1).default(9000),
    SOURCE_MAX_MARKET_PAGES_PER_RUN: z.coerce.number().int().min(1).max(200).default(10),
    SOURCE_HISTORY_BOOTSTRAP_MAX_ASSETS: z.coerce.number().int().min(0).max(100).default(8),
    DISCOVERY_INTERVAL_HOURS: z.coerce.number().int().min(1).default(24),
    CMC_WEB_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(60).default(6),
    CMC_WEB_MONTHLY_REQUEST_BUDGET: z.coerce.number().int().min(1).default(9000),
    CMC_WEB_MAX_RETRIES: z.coerce.number().int().min(0).max(6).default(2),
    CMC_WEB_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(60),

    SCHEDULER_ENABLED: bool.default(true),
    PIPELINE_CRON: z.string().default("7 * * * *"),
    MISSED_RUN_POLICY: z.enum(["current_slot", "skip"]).default("current_slot"),
    SNAPSHOT_WINDOW: z.coerce.number().int().min(2).max(48).default(3),
    STALE_AFTER_MINUTES: z.coerce.number().int().min(5).default(90),
    SHORTLIST_SIZE: z.coerce.number().int().min(0).max(25).default(6),
    MIN_VOLUME_24H_USD: z.coerce.number().min(0).default(250_000),
    MIN_MARKET_CAP_USD: z.coerce.number().min(0).default(5_000_000),
    /** Consecutive hourly snapshots required before a signal may be "candidate". */
    CANDIDATE_MIN_HISTORY: z.coerce.number().int().min(2).default(25),
    RETENTION_SNAPSHOT_DAYS: z.coerce.number().int().min(0).default(0),

    AGENT_PROVIDER: z.enum(["fixture", "claude", "off"]).default("fixture"),
    CLAUDE_CODE_OAUTH_TOKEN: optionalSecret,
    AGENT_MODEL_ANALYST: z.string().default("claude-sonnet-5-5"),
    AGENT_MODEL_REVIEWER: z.string().default("claude-sonnet-5-5"),
    AGENT_MODEL_ESCALATION: z.string().default("claude-opus-5-5"),
    AGENT_MODEL_COORDINATOR: z.string().default("claude-haiku-5-5"),
    AGENT_RUN_BUDGET_USD: z.coerce.number().min(0).default(1.5),
    AGENT_DAILY_BUDGET_USD: z.coerce.number().min(0).default(20),
    AGENT_TIMEOUT_SECONDS: z.coerce.number().int().min(10).default(240),

    TELEGRAM_MODE: z.enum(["disabled", "dry_run", "live"]).default("dry_run"),
    TELEGRAM_BOT_TOKEN: optionalSecret,
    TELEGRAM_CHAT_ID: z.string().trim().optional(),
    /** Answer /report, /status, /vmc, /run, /help from TELEGRAM_CHAT_ID (web server only). */
    TELEGRAM_COMMANDS_ENABLED: bool.default(true),

    MCP_HTTP_ENABLED: bool.default(true),
    MCP_READ_TOKEN: optionalSecret,
    MCP_WRITE_TOKEN: optionalSecret,
    DASHBOARD_BASIC_AUTH: optionalSecret,

    // --- Volume / Market Cap baseline collection (CMC brief) ---------------------------
    /** Explicit CoinMarketCap numeric ids. Empty = nothing is monitored (no implicit universe). */
    VMC_ASSET_IDS: z
      .string()
      .optional()
      .transform((v, ctx) => {
        const ids = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        for (const id of ids) if (!/^[1-9]\d{0,9}$/.test(id)) ctx.addIssue({ code: "custom", message: `VMC_ASSET_IDS: "${id}" is not a CoinMarketCap numeric id` });
        return [...new Set(ids.map(Number))];
      }),
    /** cmc_web = coin pages + their public website data endpoints, no Pro API key. */
    VMC_SOURCE: z.enum(["fixture", "cmc", "cmc_web"]).default("fixture"),
    /** Plan the operator says the key is on; verified at runtime with /v1/key/info + probes. */
    CMC_PLAN: z.enum(["basic", "builder", "startup", "growth", "professional", "enterprise"]).default("basic"),
    /** eod_quote = /v3 quotes/historical interval=daily; ohlcv = /v2 ohlcv/historical daily. Never mixed. */
    VMC_DAILY_CONVENTION: z.enum(["eod_quote", "ohlcv"]).default("eod_quote"),
    VMC_BASELINE_MONTHS: z.coerce.number().int().min(1).max(24).default(6),
    VMC_MIN_BASELINE_COVERAGE: z.coerce.number().min(0).max(1).default(0.95),
    VMC_DAILY_REFRESH_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(60).default(14),
    VMC_EOD_MAX_OFFSET_MINUTES: z.coerce.number().int().min(1).max(720).default(60),
    VMC_RECENT_WINDOW_HOURS: z.coerce.number().int().min(1).max(720).default(72),
    VMC_STALE_AFTER_MINUTES: z.coerce.number().int().min(5).default(90),
    VMC_SCHEDULER_ENABLED: bool.default(false),
    VMC_HOURLY_CRON: z.string().default("5 * * * *"),
    VMC_BASELINE_CRON: z.string().default("30 1 * * 1"),
    VMC_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(1600).default(20),
    VMC_MAX_RETRIES: z.coerce.number().int().min(0).max(6).default(3),
    VMC_LATEST_BATCH_SIZE: z.coerce.number().int().min(1).max(250).default(100),
    VMC_MONTHLY_CREDIT_BUDGET: z.coerce.number().int().min(1).default(10_000),
    VMC_OUTPUT_FORMAT: z.enum(["table", "json"]).default("table"),
    /** Optional file the comparison is written to after each hourly run (in addition to API/CLI). */
    VMC_OUTPUT_FILE: z.string().optional(),

    PAPER_FEE_BPS: z.coerce.number().int().min(0).max(500).default(10),
    PAPER_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(1000).default(30),
  })
  .superRefine((c, ctx) => {
    if (c.VMC_SOURCE === "cmc_web" && c.VMC_DAILY_CONVENTION !== "ohlcv") {
      ctx.addIssue({ code: "custom", path: ["VMC_DAILY_CONVENTION"], message: "VMC_SOURCE=cmc_web requires VMC_DAILY_CONVENTION=ohlcv (website daily history semantics)" });
    }
    if (c.TELEGRAM_MODE === "live" && (!c.TELEGRAM_BOT_TOKEN || !c.TELEGRAM_CHAT_ID)) {
      ctx.addIssue({
        code: "custom",
        path: ["TELEGRAM_MODE"],
        message: "TELEGRAM_MODE=live requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID",
      });
    }
    if (c.DATA_SOURCE === "coingecko" && !c.COINGECKO_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["DATA_SOURCE"],
        message: "DATA_SOURCE=coingecko requires COINGECKO_API_KEY (free Demo key from CoinGecko)",
      });
    }
    if (c.VMC_SOURCE === "cmc" && !c.CMC_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["VMC_SOURCE"], message: "VMC_SOURCE=cmc requires CMC_API_KEY (a CoinMarketCap API key, not the Claude token)" });
    }
    if (c.DATA_SOURCE === "coinmarketcap" && !c.CMC_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["DATA_SOURCE"],
        message: "DATA_SOURCE=coinmarketcap requires CMC_API_KEY (free Basic key from CoinMarketCap)",
      });
    }
    if (!isLoopback(c.HOST) && !c.DASHBOARD_BASIC_AUTH) {
      ctx.addIssue({
        code: "custom",
        path: ["DASHBOARD_BASIC_AUTH"],
        message: "Binding to a non-loopback HOST requires DASHBOARD_BASIC_AUTH",
      });
    }
    if (c.MCP_READ_TOKEN && c.MCP_READ_TOKEN.length < 24) {
      ctx.addIssue({ code: "custom", path: ["MCP_READ_TOKEN"], message: "must be at least 24 characters" });
    }
    if (c.MCP_WRITE_TOKEN && c.MCP_WRITE_TOKEN.length < 24) {
      ctx.addIssue({ code: "custom", path: ["MCP_WRITE_TOKEN"], message: "must be at least 24 characters" });
    }
  });

export type AppConfig = z.infer<typeof schema>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Resolve `<NAME>_FILE` indirections (Docker secrets). The file contents replace the variable;
 * an empty file means "not configured".
 */
export function resolveFileSecrets(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of SECRET_KEYS) {
    const fileVar = env[`${key}_FILE`];
    if (fileVar && !env[key]) {
      try {
        out[key] = readFileSync(fileVar, "utf8").trim();
      } catch {
        // Missing secret file: treat as not configured rather than leaking the path contents.
        out[key] = undefined;
      }
    }
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const resolved = resolveFileSecrets(env);
  const parsed = schema.safeParse(resolved);
  if (!parsed.success) {
    // Zod issue messages never include the offending value, so secrets cannot leak here.
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  return parsed.data;
}

/** Non-secret view of configuration for diagnostics. Secrets show only set/unset. */
export function describeConfig(c: AppConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if ((SECRET_KEYS as readonly string[]).includes(k)) out[k] = v ? "<set>" : "<not set>";
    else if (k === "DATABASE_URL") out[k] = redactUrlCredentials(String(v));
    else out[k] = v;
  }
  return out;
}

export function redactUrlCredentials(url: string): string {
  return url.replace(/\/\/([^:/@]+):([^@]+)@/, "//$1:***@");
}

export const APP_CONFIG = Symbol("APP_CONFIG");
