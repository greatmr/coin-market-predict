/**
 * Dashboard settings (`docs/adr/0005-dashboard-settings.md`): the operational configuration an owner
 * manages under Settings instead of in `.env`. Credentials, the database connection, the listen
 * address, the reverse-proxy / cookie set-up and file-system paths stay environment-only, so a
 * saved setting can never expose a secret or lock the owner out of the dashboard.
 *
 * Precedence for each key: schema default ← saved setting (database) ← environment variable. A key
 * set in the environment is locked in the dashboard; once it is copied in ("Import from
 * environment", `settings:import-env`) and removed from `.env`, the dashboard owns it.
 *
 * `apply`: `live` settings take effect in the running server as soon as no pipeline run is in
 * progress (a run never mixes two configurations); `restart` settings are read once at start-up,
 * because the data source and its adapters are built then. `min` / `max` / `options` mirror the Zod
 * schema in `env.validation.ts`, which stays the authority (`settings.catalog.spec.ts` checks both
 * agree).
 */

export const SETTING_GROUPS = [
  {
    id: 'source',
    label: 'Market data source',
    description:
      'Where market data comes from and how politely it is read. Keys and tokens stay in the server environment.',
  },
  {
    id: 'schedule',
    label: 'Schedule and freshness',
    description:
      'When the hourly pipeline runs and how old a quote may be before it counts as stale.',
  },
  {
    id: 'tier1',
    label: 'Tier 1 collection',
    description:
      'Bounds for the daily-history and venue stages of each run. Unfinished coins continue in the next run.',
  },
  {
    id: 'lbank',
    label: 'LBank Spot list',
    description:
      'Operator decisions D1 and D2 (strategy document): list refresh, staleness and tradability.',
  },
  {
    id: 'retention',
    label: 'Retention',
    description:
      'How long hourly detail and export files are kept. The database keeps every result.',
  },
  {
    id: 'telegram',
    label: 'Telegram',
    description:
      'The hourly summary and bot commands. The bot token and the owner chat id stay in the server environment.',
  },
  {
    id: 'general',
    label: 'Dashboard and MCP',
    description: 'Display, sign-in sessions and the MCP endpoint.',
  },
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number]['id'];

export type SettingKind = 'int' | 'number' | 'bool' | 'enum' | 'text';
export type SettingApply = 'live' | 'restart';
export type SettingValue = string | number | boolean;

export interface SettingDef {
  group: SettingGroup;
  label: string;
  help: string;
  kind: SettingKind;
  apply: SettingApply;
  min?: number;
  max?: number;
  unit?: string;
  options?: readonly string[];
  /** Extra syntax checked by the schema (a five-field UTC cron, an IANA time zone). */
  format?: 'cron' | 'timezone';
  /** May be left empty: the schema then derives the value (MAX_QUOTE_AGE_MINUTES). */
  optional?: boolean;
}

export const SETTINGS = {
  // --- Market data source ----------------------------------------------------------------
  DATA_SOURCE: {
    group: 'source',
    label: 'Data source',
    help: 'fixture = synthetic test market (ids ≥ 990001). coinmarketcap_web = the CMC website collector, the only live source with daily rows and LBank pairs. coinmarketcap / coingecko = official API listings only; they need CMC_API_KEY / COINGECKO_API_KEY in the server environment.',
    kind: 'enum',
    options: ['fixture', 'coinmarketcap', 'coinmarketcap_web', 'coingecko'],
    apply: 'restart',
  },
  DISCOVERY_INTERVAL_HOURS: {
    group: 'source',
    label: 'Listing discovery interval',
    help: 'How often the full listing is read again to find newly listed coins.',
    kind: 'int',
    min: 1,
    unit: 'hours',
    apply: 'live',
  },
  CMC_WEB_REQUESTS_PER_MINUTE: {
    group: 'source',
    label: 'Website requests per minute',
    help: 'One shared sequential queue for the listing, daily history, LBank pairs and asset market pairs.',
    kind: 'int',
    min: 1,
    max: 60,
    unit: 'per minute',
    apply: 'live',
  },
  CMC_WEB_MONTHLY_REQUEST_BUDGET: {
    group: 'source',
    label: 'Website monthly request budget',
    help: 'Local politeness budget for every website route. Tier 1 needs ~720 listing requests a month plus about one daily-history request per screen candidate per UTC day; each run keeps a reserve for the hourly listing.',
    kind: 'int',
    min: 1,
    unit: 'per month',
    apply: 'live',
  },
  CMC_WEB_MAX_RETRIES: {
    group: 'source',
    label: 'Website retries',
    help: 'Retries of a failed website request (with backoff and Retry-After) before the run records the failure.',
    kind: 'int',
    min: 0,
    max: 6,
    apply: 'live',
  },
  CMC_WEB_CACHE_SECONDS: {
    group: 'source',
    label: 'Website response cache',
    help: 'Identical website requests within this time reuse the previous response. 0 turns the cache off.',
    kind: 'int',
    min: 0,
    max: 300,
    unit: 'seconds',
    apply: 'live',
  },
  CMC_WEB_LISTING_PAGE_SIZE: {
    group: 'source',
    label: 'Website listing page size',
    help: '10,000 returns the whole ~8k listing in one response, which also avoids unstable ordering across pages.',
    kind: 'int',
    min: 100,
    max: 10_000,
    unit: 'coins',
    apply: 'restart',
  },
  SOURCE_REQUESTS_PER_MINUTE: {
    group: 'source',
    label: 'Official API requests per minute',
    help: 'Rate limit for the official API sources (coinmarketcap, coingecko).',
    kind: 'int',
    min: 1,
    max: 500,
    unit: 'per minute',
    apply: 'live',
  },
  SOURCE_MONTHLY_REQUEST_BUDGET: {
    group: 'source',
    label: 'Official API monthly budget',
    help: 'Monthly request (credit) budget for the official API sources.',
    kind: 'int',
    min: 1,
    unit: 'per month',
    apply: 'live',
  },
  SOURCE_MAX_MARKET_PAGES_PER_RUN: {
    group: 'source',
    label: 'Listing pages per run',
    help: 'Upper bound on listing pages read per run.',
    kind: 'int',
    min: 1,
    max: 200,
    unit: 'pages',
    apply: 'restart',
  },

  // --- Schedule and freshness ------------------------------------------------------------
  SCHEDULER_ENABLED: {
    group: 'schedule',
    label: 'Automatic runs',
    help: 'Run the pipeline on the schedule below and retry Telegram deliveries every 5 minutes. Off: runs start only by hand. Turning it back on records the hours it was off as missed and runs the current hour per the missed-run policy.',
    kind: 'bool',
    apply: 'live',
  },
  PIPELINE_CRON: {
    group: 'schedule',
    label: 'Pipeline schedule',
    help: 'Five-field cron expression (minute hour day month weekday), evaluated in UTC. Default: minute 7 of every hour. One crawl batch per UTC hour: a more frequent schedule only re-checks the current hour.',
    kind: 'text',
    format: 'cron',
    apply: 'live',
  },
  MISSED_RUN_POLICY: {
    group: 'schedule',
    label: 'Missed-run policy',
    help: 'On start: current_slot runs the current hour if it has not completed; skip waits for the next scheduled run. Missed hours are always recorded, never backfilled.',
    kind: 'enum',
    options: ['current_slot', 'skip'],
    apply: 'live',
  },
  CRAWL_EXPECTED_INTERVAL_MINUTES: {
    group: 'schedule',
    label: 'Crawl interval',
    help: "The crawler's documented batch interval (PDF p.12). The default maximum quote age is twice this.",
    kind: 'int',
    min: 1,
    max: 1440,
    unit: 'minutes',
    apply: 'live',
  },
  MAX_QUOTE_AGE_MINUTES: {
    group: 'schedule',
    label: 'Maximum quote age',
    help: 'A current quote older than this is STALE and its windows are N/A. Leave empty for twice the crawl interval.',
    kind: 'int',
    min: 1,
    unit: 'minutes',
    optional: true,
    apply: 'live',
  },

  // --- Tier 1 collection -----------------------------------------------------------------
  TIER1_DAILY_LOOKBACK_DAYS: {
    group: 'tier1',
    label: 'Daily-history lookback',
    help: 'Completed UTC days requested per daily-history refresh. At least 30 (the longest window); extra days catch revisions.',
    kind: 'int',
    min: 30,
    max: 120,
    unit: 'days',
    apply: 'live',
  },
  TIER1_DAILY_MAX_ASSETS_PER_RUN: {
    group: 'tier1',
    label: 'Daily-history coins per run',
    help: 'Upper bound on coins whose daily history is fetched in one run.',
    kind: 'int',
    min: 0,
    max: 20_000,
    unit: 'coins',
    apply: 'live',
  },
  TIER1_DAILY_MAX_MINUTES: {
    group: 'tier1',
    label: 'Daily-history time per run',
    help: 'Upper bound on the time the daily-history stage may take in one run.',
    kind: 'number',
    min: 1,
    max: 50,
    unit: 'minutes',
    apply: 'live',
  },
  TIER1_DAILY_RETRY_HOURS: {
    group: 'tier1',
    label: 'Daily-history retry delay',
    help: 'A coin whose latest completed day was not returned is asked again after this long.',
    kind: 'number',
    min: 0,
    max: 48,
    unit: 'hours',
    apply: 'live',
  },
  TIER1_VENUE_REFRESH_HOURS: {
    group: 'tier1',
    label: 'Venue refresh interval',
    help: 'CMC Markets venue rows (Upbit-dominant / single-venue flags) are refreshed at most this often per review candidate; older than twice this they are stale.',
    kind: 'number',
    min: 1,
    max: 168,
    unit: 'hours',
    apply: 'live',
  },
  TIER1_VENUE_MAX_ASSETS_PER_RUN: {
    group: 'tier1',
    label: 'Venue refreshes per run',
    help: 'Upper bound on review candidates whose venue rows are fetched in one run.',
    kind: 'int',
    min: 0,
    max: 2000,
    unit: 'coins',
    apply: 'live',
  },

  // --- LBank Spot list -------------------------------------------------------------------
  LBANK_PAIRS_REFRESH_DAYS: {
    group: 'lbank',
    label: 'List refresh interval',
    help: 'The LBank Spot markets list is fetched once, then again when it is this old, or on demand (D2).',
    kind: 'int',
    min: 1,
    max: 365,
    unit: 'days',
    apply: 'live',
  },
  LBANK_PAIRS_MAX_AGE_DAYS: {
    group: 'lbank',
    label: 'List maximum age',
    help: 'Beyond this age the list is stale: LBank status UNKNOWN and the Review Queue withheld. At least the refresh interval.',
    kind: 'int',
    min: 1,
    max: 400,
    unit: 'days',
    apply: 'live',
  },
  LBANK_REQUIRE_MANUAL_VERIFICATION: {
    group: 'lbank',
    label: 'Require manual verification',
    help: 'Off (decision D1): a pair in the LBank list counts as tradable. On: every listed pair also needs a reviewer\'s "Verified tradable" (assumption A7). Changes the configuration version of later scans.',
    kind: 'bool',
    apply: 'live',
  },

  // --- Retention -------------------------------------------------------------------------
  RETENTION_SNAPSHOT_DAYS: {
    group: 'retention',
    label: 'Snapshot retention',
    help: 'Raw hourly snapshots older than this are deleted. 0 keeps them all.',
    kind: 'int',
    min: 0,
    unit: 'days',
    apply: 'live',
  },
  RETENTION_DETAIL_DAYS: {
    group: 'retention',
    label: 'Hourly detail retention',
    help: 'After this many days, coins outside the Tier 1 rank band keep one snapshot per UTC day and scan rows excluded only by rank / cap keep the first batch of each UTC day. 0 keeps all detail.',
    kind: 'int',
    min: 0,
    unit: 'days',
    apply: 'live',
  },
  EXPORT_RETENTION_DAYS: {
    group: 'retention',
    label: 'Export file retention',
    help: 'Export folders older than this are removed (results stay in the database and can be exported again). 0 keeps every file.',
    kind: 'int',
    min: 0,
    unit: 'days',
    apply: 'live',
  },

  // --- Telegram --------------------------------------------------------------------------
  TELEGRAM_MODE: {
    group: 'telegram',
    label: 'Delivery mode',
    help: 'disabled = no reports; dry_run = reports are built and stored, never sent; live = sent to every approved member. Live needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the server environment.',
    kind: 'enum',
    options: ['disabled', 'dry_run', 'live'],
    apply: 'live',
  },
  TELEGRAM_COMMANDS_ENABLED: {
    group: 'telegram',
    label: 'Bot commands',
    help: 'Answer /report, /status, /vmc, /coin, /run and /help (web server only; needs the bot token and owner chat id).',
    kind: 'bool',
    apply: 'live',
  },
  TELEGRAM_QUEUE_ROWS: {
    group: 'telegram',
    label: 'Queue rows in the summary',
    help: 'Review Queue rows shown in the hourly summary.',
    kind: 'int',
    min: 1,
    max: 30,
    unit: 'rows',
    apply: 'live',
  },
  TELEGRAM_ATTACH_EXPORT: {
    group: 'telegram',
    label: 'Attach the workbook',
    help: "xlsx = attach the batch's Excel workbook (~2 MB) after each summary, except when the queue is withheld; none = text only.",
    kind: 'enum',
    options: ['none', 'xlsx'],
    apply: 'live',
  },

  // --- Dashboard and MCP -----------------------------------------------------------------
  DISPLAY_TIMEZONE: {
    group: 'general',
    label: 'Display time zone',
    help: 'IANA name such as Asia/Tehran or UTC. Storage stays UTC; this changes only how times are shown in the dashboard and Telegram.',
    kind: 'text',
    format: 'timezone',
    apply: 'live',
  },
  SESSION_TTL_HOURS: {
    group: 'general',
    label: 'Session length',
    help: 'A dashboard session ends this long after its last use.',
    kind: 'int',
    min: 1,
    max: 720,
    unit: 'hours',
    apply: 'live',
  },
  MCP_HTTP_ENABLED: {
    group: 'general',
    label: 'MCP over HTTP',
    help: 'Serve the MCP tools at /mcp to holders of MCP_READ_TOKEN / MCP_WRITE_TOKEN (server environment). Without a token it stays off.',
    kind: 'bool',
    apply: 'live',
  },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(SETTINGS, key);
export const settingDef = (key: SettingKey): SettingDef => SETTINGS[key];

/** Keys the running server takes over without a restart. */
export const LIVE_SETTING_KEYS: readonly SettingKey[] = SETTING_KEYS.filter(
  (k) => settingDef(k).apply === 'live',
);

/** Saved dashboard settings, as stored (`app_setting.value`). */
export type SavedSettings = Partial<Record<SettingKey, SettingValue>>;

/** A non-empty environment value (`NAME=` counts as not set, as for every optional variable). */
export function envSets(env: Record<string, string | undefined>, key: string): boolean {
  const v = env[key];
  return typeof v === 'string' && v.trim() !== '';
}

const TRUE = ['1', 'true', 'yes', 'on'];
const FALSE = ['0', 'false', 'no', 'off'];

/**
 * The stored form of one setting value (dashboard input, CLI argument or environment text): a number
 * for numeric kinds, a boolean, or a trimmed string. Range and syntax are checked again by the full
 * schema, which also sees cross-field rules.
 */
export function normalizeSettingValue(
  key: SettingKey,
  raw: unknown,
): { ok: true; value: SettingValue } | { ok: false; message: string } {
  const def = settingDef(key);
  const text = typeof raw === 'string' ? raw.trim() : null;
  switch (def.kind) {
    case 'int':
    case 'number': {
      const n =
        typeof raw === 'number'
          ? raw
          : text !== null && /^-?\d+(\.\d+)?$/.test(text)
            ? Number(text)
            : Number.NaN;
      if (!Number.isFinite(n)) return { ok: false, message: 'must be a number' };
      if (def.kind === 'int' && !Number.isInteger(n))
        return { ok: false, message: 'must be a whole number' };
      if (def.min !== undefined && n < def.min)
        return { ok: false, message: `must be at least ${def.min}` };
      if (def.max !== undefined && n > def.max)
        return { ok: false, message: `must be at most ${def.max}` };
      return { ok: true, value: n };
    }
    case 'bool':
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (text !== null && TRUE.includes(text.toLowerCase())) return { ok: true, value: true };
      if (text !== null && FALSE.includes(text.toLowerCase())) return { ok: true, value: false };
      return { ok: false, message: 'must be true or false' };
    case 'enum':
      if (text !== null && def.options?.includes(text)) return { ok: true, value: text };
      return { ok: false, message: `must be one of ${def.options?.join(', ')}` };
    case 'text':
      if (text === null || text === '') return { ok: false, message: 'must not be empty' };
      if (text.length > 200) return { ok: false, message: 'must be at most 200 characters' };
      return { ok: true, value: text };
  }
}
