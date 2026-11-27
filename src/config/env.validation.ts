import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** Environment variables that hold secrets. Values are never logged or exposed. */
export const SECRET_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'CMC_API_KEY',
  'COINGECKO_API_KEY',
  'MCP_READ_TOKEN',
  'MCP_WRITE_TOKEN',
  'INITIAL_OWNER_PASSWORD',
  'POSTGRES_PASSWORD',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

/** Connection variables when DATABASE_URL is not used (the standard layout's POSTGRES_* set). */
export const POSTGRES_REQUIRED = [
  'POSTGRES_HOST',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

/** An optional integer setting; an empty value (`NAME=`) means not set, as for secrets. */
const optionalInt = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.coerce.number().int().min(min).max(max).optional(),
  );

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /** Either a full connection URL or the POSTGRES_* variables below (see `database/typeorm-options.ts`). */
    DATABASE_URL: z
      .string()
      .optional()
      .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
    POSTGRES_HOST: z.string().trim().optional(),
    POSTGRES_PORT: optionalInt(1, 65535),
    POSTGRES_USER: z.string().trim().optional(),
    POSTGRES_PASSWORD: optionalSecret,
    POSTGRES_DB: z.string().trim().optional(),
    POSTGRES_SSL: bool.default(false),
    /** Log every SQL statement (development only). */
    DB_LOGGING: bool.default(false),
    DISPLAY_TIMEZONE: z.string().default('Asia/Tehran'),

    DATA_SOURCE: z
      .enum(['fixture', 'coinmarketcap', 'coinmarketcap_web', 'coingecko'])
      .default('fixture'),
    CMC_API_KEY: optionalSecret,
    COINGECKO_API_KEY: optionalSecret,
    SOURCE_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(500).default(10),
    SOURCE_MONTHLY_REQUEST_BUDGET: z.coerce.number().int().min(1).default(9000),
    SOURCE_MAX_MARKET_PAGES_PER_RUN: z.coerce.number().int().min(1).max(200).default(10),
    DISCOVERY_INTERVAL_HOURS: z.coerce.number().int().min(1).default(24),
    CMC_WEB_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(60).default(30),
    /**
     * Local politeness budget for the website collector (all routes). Tier 1 needs about one daily
     * history request per screen candidate per UTC day on top of the hourly listing and LBank pairs.
     */
    CMC_WEB_MONTHLY_REQUEST_BUDGET: z.coerce.number().int().min(1).default(30_000),
    CMC_WEB_MAX_RETRIES: z.coerce.number().int().min(0).max(6).default(2),
    CMC_WEB_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(60),
    /**
     * Website listing page size. 10,000 returns the whole ~8k universe in one request, which also
     * avoids unstable ordering among the thousands of coins tied at zero market cap across pages.
     */
    CMC_WEB_LISTING_PAGE_SIZE: z.coerce.number().int().min(100).max(10_000).default(10_000),

    SCHEDULER_ENABLED: bool.default(true),
    PIPELINE_CRON: z.string().default('7 * * * *'),
    MISSED_RUN_POLICY: z.enum(['current_slot', 'skip']).default('current_slot'),
    /** The crawler's documented batch interval (hourly PIPELINE_CRON), PDF p.12. */
    CRAWL_EXPECTED_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
    /** Quote age beyond which the current observation is stale; default 2 × the crawl interval (p.12). */
    MAX_QUOTE_AGE_MINUTES: optionalInt(1),
    /** > 0: delete snapshots older than N days outright (forward-test snapshots stay). 0 = off. */
    RETENTION_SNAPSHOT_DAYS: z.coerce.number().int().min(0).default(0),
    /**
     * Hourly snapshots (ranks 1–1200) are kept N days for reprocessing, on-request traces and price
     * context; afterwards only the ones a stored Review Queue row used, forward-test snapshots and
     * the BTC/ETH benchmarks stay (D4, ADR-0008). 0 = keep all detail.
     */
    RETENTION_DETAIL_DAYS: z.coerce.number().int().min(0).default(7),

    // --- Two-Tier VMC strategy, Tier 1 (docs/strategy-two-tier-vmc.md) --------------------
    /** Completed UTC days requested per daily-history refresh (≥ 30 needed; extra days catch revisions). */
    TIER1_DAILY_LOOKBACK_DAYS: z.coerce.number().int().min(30).max(120).default(35),
    TIER1_DAILY_MAX_ASSETS_PER_RUN: z.coerce.number().int().min(0).max(20_000).default(1500),
    TIER1_DAILY_MAX_MINUTES: z.coerce.number().min(1).max(50).default(30),
    /** An asset whose latest completed day was not returned is retried after this many hours. */
    TIER1_DAILY_RETRY_HOURS: z.coerce.number().min(0).max(48).default(3),
    /**
     * LBank Spot markets list (CMC exchange page, Markets section): fetched once, then again when
     * the stored list is this many days old, or on demand (dashboard / `lbank:refresh`). D2.
     */
    LBANK_PAIRS_REFRESH_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /** Beyond this age the stored list is stale: LBank status UNKNOWN and the queue is withheld. */
    LBANK_PAIRS_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(400).default(35),
    /**
     * false (operator decision D1): a pair in the LBank list counts as tradable. true: every listed
     * pair also needs a reviewer's "Verified tradable" (the stricter assumption A7).
     */
    LBANK_REQUIRE_MANUAL_VERIFICATION: bool.default(false),
    /**
     * LBank Futures and Bithumb Spot markets lists (listing attributes on the forward-test tab,
     * ADR-0007; never Tier 1 inputs): fetched by the `venues` stage when the stored list is this old.
     */
    EXCHANGE_LISTS_REFRESH_HOURS: z.coerce.number().min(1).max(720).default(24),
    /** Beyond this age such a list verifies nothing: its listing shows Unknown, never No. */
    EXCHANGE_LISTS_MAX_AGE_HOURS: z.coerce.number().min(1).max(2160).default(72),

    /**
     * LBank Spot Price Observation (docs/lbank-spot-observation.md, ADR-0009): its own job and source.
     * `auto` uses LBank's public API with a live data source and the synthetic fixture otherwise.
     */
    LBANK_OBSERVATION_ENABLED: bool.default(true),
    LBANK_OBSERVATION_SOURCE: z.enum(['auto', 'api', 'fixture']).default('auto'),
    /** The observation job's schedule (UTC); each pair is fetched at most every LBANK_SYNC_INTERVAL_MINUTES. */
    LBANK_OBSERVATION_CRON: z.string().default('*/15 * * * *'),
    LBANK_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
    /** Time bound of one run's candle requests (the rest continue next run). */
    LBANK_OBSERVATION_MAX_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
    /** Official public REST hosts (LBank "API Update" notice, 2023-08-07: api.lbkex.com). */
    LBANK_API_BASE_URL: z.string().url().default('https://api.lbkex.com'),
    LBANK_FUTURES_API_BASE_URL: z.string().url().default('https://lbkperp.lbank.com'),
    /**
     * LBank Futures sampled observation (docs/lbank-spot-observation.md § 13): one official
     * `marketData` read per tick (all contracts in one request, ≈ 43 000 a month at one a minute,
     * inside LBANK_MONTHLY_REQUEST_BUDGET). The cadence bounds how tightly a sampled trade is timed.
     */
    LBANK_FUTURES_ENABLED: bool.default(true),
    LBANK_FUTURES_SAMPLE_CRON: z.string().default('* * * * *'),
    /** Our own pace (LBank allows 200 requests / 10 s on public endpoints). */
    LBANK_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(60),
    LBANK_MONTHLY_REQUEST_BUDGET: z.coerce.number().int().min(100).default(400_000),
    /**
     * Shared raw 1-minute candles older than this many days, once no unfinished observation of their
     * pair needs them, are archived per pair and UTC day (gzip CSV + SHA-256, kept) and then deleted.
     * 0 keeps every raw candle (no archive needed).
     */
    LBANK_CANDLE_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(7),
    /** Build metadata stamped into the image (`GIT_COMMIT`, `BUILD_TIME` build args): /healthz. */
    APP_BUILD_COMMIT: z.string().trim().max(64).default('unknown'),
    APP_BUILD_TIME: z.string().trim().max(40).default('unknown'),
    /** CMC Markets venue rows are refreshed at most this often per review candidate. */
    TIER1_VENUE_REFRESH_HOURS: z.coerce.number().min(1).max(168).default(24),
    TIER1_VENUE_MAX_ASSETS_PER_RUN: z.coerce.number().int().min(0).max(2000).default(60),
    TIER1_OVERRIDES_FILE: z.string().default('config/tier1-overrides.json'),
    TIER1_EXPORT_DIR: z.string().default('var/exports'),
    EXPORT_RETENTION_DAYS: z.coerce.number().int().min(0).default(7),

    TELEGRAM_MODE: z.enum(['disabled', 'dry_run', 'live']).default('dry_run'),
    TELEGRAM_BOT_TOKEN: optionalSecret,
    TELEGRAM_CHAT_ID: z.string().trim().optional(),
    /** Answer /report, /status, /vmc, /run, /help (web server only). */
    TELEGRAM_COMMANDS_ENABLED: bool.default(true),
    /** Review Queue rows in the Telegram report. */
    TELEGRAM_QUEUE_ROWS: z.coerce.number().int().min(1).max(30).default(10),

    MCP_HTTP_ENABLED: bool.default(true),
    MCP_READ_TOKEN: optionalSecret,
    MCP_WRITE_TOKEN: optionalSecret,
    /** Dashboard sign-in: a session lasts this long after its last use. */
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
    /** Secure flag of the session cookie: auto = only when the request arrived over HTTPS. */
    COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
    /** Express "trust proxy" behind a reverse proxy (e.g. loopback, 1): correct client IP and HTTPS detection. */
    TRUST_PROXY: z.string().trim().optional(),
    /**
     * Browser origins allowed to call /api from another host, comma-separated exact origins (e.g.
     * https://predict.example.com when the API runs on api-predict.example.com). Empty: same origin
     * only (the web container proxies /api, the default). Credentials (the session cookie) are allowed
     * for these origins, and their writes pass the write guard.
     */
    CORS_ORIGINS: z
      .string()
      .optional()
      .transform((v) =>
        (v ?? '')
          .split(',')
          .map((o) => o.trim().replace(/\/+$/, ''))
          .filter(Boolean),
      ),
    /** Password for the bootstrap owner created on an empty database (default "owner", must be changed at first sign-in). */
    INITIAL_OWNER_PASSWORD: optionalSecret,

    // --- Claude coin agent: owner-only, on demand (docs/adr/0005-coin-agent.md) -------------
    /**
     * Claude subscription OAuth token from `claude setup-token`: the agent's only credential. API
     * keys are refused; the agent's process never sees ANTHROPIC_API_KEY (`buildAgentEnv`).
     */
    CLAUDE_CODE_OAUTH_TOKEN: optionalSecret,
    /** false switches the agent off: every run is refused, even with a token. */
    AGENT_ENABLED: bool.default(true),
    AGENT_MODEL: z.string().trim().min(1).default('claude-opus-5-5'),
    /** Tried when the model is overloaded or declines; empty = no fallback. */
    AGENT_FALLBACK_MODEL: z.string().trim().default('claude-opus-4-8'),
    AGENT_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
    /** At most this many runs, all owners together, in any rolling AGENT_WINDOW_HOURS. */
    AGENT_MAX_RUNS: z.coerce.number().int().min(1).max(100).default(5),
    AGENT_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(12),
    AGENT_MAX_TURNS: z.coerce.number().int().min(2).max(40).default(12),
    AGENT_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(1800).default(300),
    /** Cost cap of one run at list prices (the SDK's estimate; a subscription is not billed per run). */
    AGENT_MAX_BUDGET_USD: z.coerce.number().min(0.1).max(50).default(2),
    /** HOME, configuration and temporary files of the agent's Claude Code process. */
    AGENT_STATE_DIR: z.string().trim().min(1).default('var/agent'),
  })
  .superRefine((c, ctx) => {
    if (!c.DATABASE_URL) {
      const missing = POSTGRES_REQUIRED.filter((k) => !c[k]);
      if (missing.length)
        ctx.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: `set DATABASE_URL or all of ${POSTGRES_REQUIRED.join(', ')} (missing: ${missing.join(', ')})`,
        });
    }
    if (c.TELEGRAM_MODE === 'live' && (!c.TELEGRAM_BOT_TOKEN || !c.TELEGRAM_CHAT_ID)) {
      ctx.addIssue({
        code: 'custom',
        path: ['TELEGRAM_MODE'],
        message: 'TELEGRAM_MODE=live requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID',
      });
    }
    if (c.DATA_SOURCE === 'coingecko' && !c.COINGECKO_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATA_SOURCE'],
        message: 'DATA_SOURCE=coingecko requires COINGECKO_API_KEY (free Demo key from CoinGecko)',
      });
    }
    if (c.DATA_SOURCE === 'coinmarketcap' && !c.CMC_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATA_SOURCE'],
        message:
          'DATA_SOURCE=coinmarketcap requires CMC_API_KEY (free Basic key from CoinMarketCap)',
      });
    }
    if (c.INITIAL_OWNER_PASSWORD && c.INITIAL_OWNER_PASSWORD.length < 8) {
      ctx.addIssue({
        code: 'custom',
        path: ['INITIAL_OWNER_PASSWORD'],
        message:
          'must be at least 8 characters (leave it unset to use the default, which must be changed at first sign-in)',
      });
    }
    if (c.LBANK_PAIRS_MAX_AGE_DAYS < c.LBANK_PAIRS_REFRESH_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['LBANK_PAIRS_MAX_AGE_DAYS'],
        message: 'must be at least LBANK_PAIRS_REFRESH_DAYS',
      });
    }
    if (c.EXCHANGE_LISTS_MAX_AGE_HOURS < c.EXCHANGE_LISTS_REFRESH_HOURS) {
      ctx.addIssue({
        code: 'custom',
        path: ['EXCHANGE_LISTS_MAX_AGE_HOURS'],
        message: 'must be at least EXCHANGE_LISTS_REFRESH_HOURS',
      });
    }
    if (c.MCP_READ_TOKEN && c.MCP_READ_TOKEN.length < 24) {
      ctx.addIssue({
        code: 'custom',
        path: ['MCP_READ_TOKEN'],
        message: 'must be at least 24 characters',
      });
    }
    for (const origin of c.CORS_ORIGINS) {
      let ok: boolean;
      try {
        const u = new URL(origin);
        ok = (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === origin;
      } catch {
        ok = false;
      }
      if (!ok)
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGINS'],
          message: `"${origin}" is not an origin (scheme://host[:port], no path)`,
        });
    }
    if (c.MCP_WRITE_TOKEN && c.MCP_WRITE_TOKEN.length < 24) {
      ctx.addIssue({
        code: 'custom',
        path: ['MCP_WRITE_TOKEN'],
        message: 'must be at least 24 characters',
      });
    }
    if (c.CLAUDE_CODE_OAUTH_TOKEN && /^sk-ant-(api|admin)/i.test(c.CLAUDE_CODE_OAUTH_TOKEN)) {
      ctx.addIssue({
        code: 'custom',
        path: ['CLAUDE_CODE_OAUTH_TOKEN'],
        message:
          'must be a Claude subscription OAuth token from `claude setup-token`, not an API key',
      });
    } else if (c.CLAUDE_CODE_OAUTH_TOKEN && c.CLAUDE_CODE_OAUTH_TOKEN.length < 20) {
      ctx.addIssue({
        code: 'custom',
        path: ['CLAUDE_CODE_OAUTH_TOKEN'],
        message: 'is too short to be a token from `claude setup-token`',
      });
    }
  })
  .transform((c) => ({
    ...c,
    MAX_QUOTE_AGE_MINUTES: c.MAX_QUOTE_AGE_MINUTES ?? 2 * c.CRAWL_EXPECTED_INTERVAL_MINUTES,
  }));

export type AppConfig = z.infer<typeof schema>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
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
        out[key] = readFileSync(fileVar, 'utf8').trim();
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
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return parsed.data;
}

/** Non-secret view of configuration for diagnostics. Secrets show only set/unset. */
export function describeConfig(c: AppConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if ((SECRET_KEYS as readonly string[]).includes(k)) out[k] = v ? '<set>' : '<not set>';
    else if (k === 'DATABASE_URL') out[k] = v ? redactUrlCredentials(String(v)) : '<not set>';
    else out[k] = v;
  }
  return out;
}

export function redactUrlCredentials(url: string): string {
  return url.replace(/\/\/([^:/@]+):([^@]+)@/, '//$1:***@');
}
