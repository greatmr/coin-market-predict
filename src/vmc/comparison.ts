import { Decimal } from "./decimal.js";
import { HOUR_MS, hourFloor } from "./window.js";

/** The latest-N-hours TIME window, which can differ from the latest N stored records when hours are missing. */
export interface WindowAnalysis {
  windowStart: string;
  windowEnd: string;
  expectedHours: number;
  presentHours: number;
  validHours: number;
  missingHours: string[];
  complete: boolean;
  /** Span covered by the latest N stored records regardless of gaps. */
  latestRecords: { count: number; oldest: string | null; newest: string | null };
}

export function analyzeWindow(now: Date, hours: number, snapshots: Array<{ hourBucket: Date; valid: boolean }>): WindowAnalysis {
  const end = hourFloor(now);
  const start = new Date(end.getTime() - (hours - 1) * HOUR_MS);
  const inWindow = snapshots.filter((s) => s.hourBucket >= start && s.hourBucket <= end);
  const have = new Set(inWindow.map((s) => s.hourBucket.getTime()));
  const missing: string[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += HOUR_MS) if (!have.has(t)) missing.push(new Date(t).toISOString());
  const latest = [...snapshots].sort((a, b) => b.hourBucket.getTime() - a.hourBucket.getTime()).slice(0, hours);
  return {
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    expectedHours: hours,
    presentHours: have.size,
    validHours: inWindow.filter((s) => s.valid).length,
    missingHours: missing,
    complete: missing.length === 0,
    latestRecords: { count: latest.length, oldest: latest.at(-1)?.hourBucket.toISOString() ?? null, newest: latest[0]?.hourBucket.toISOString() ?? null },
  };
}

export interface ComparisonInput {
  cmcId: number;
  symbol: string;
  name: string;
  latest: { observedAt: Date | null; volume24hUsd: Decimal | null; marketCapUsd: Decimal | null; ratio: Decimal | null; valid: boolean; invalidReasons: string[] } | null;
  baseline: { meanRatio: Decimal | null; status: string; validDays: number; expectedDays: number; coverage: number; windowStart: string; windowEnd: string; calculatedAt: Date; version: number } | null;
  window: WindowAnalysis;
  hourlyBackfill: "done" | "not_done" | "unavailable";
}

export interface ComparisonRow {
  cmcId: number;
  symbol: string;
  name: string;
  observationTimeUtc: string | null;
  quoteAgeMinutes: number | null;
  volume24hUsd: string | null;
  marketCapUsd: string | null;
  currentRatio: string | null;
  baselineMean: string | null;
  baselineCoverage: string;
  baselineWindow: string | null;
  baselineCalculatedAt: string | null;
  /** Descriptive only: current ratio ÷ baseline mean. Not a signal. */
  ratioToBaseline: string;
  recentWindow: string;
  dataStatus: string[];
}

export function buildRow(i: ComparisonInput, now: Date, staleAfterMinutes: number): ComparisonRow {
  const status: string[] = [];
  const l = i.latest;
  const age = l?.observedAt ? Math.round((now.getTime() - l.observedAt.getTime()) / 60_000) : null;
  if (!l) status.push("no_quote_collected");
  else if (!l.valid) status.push(`latest_quote_invalid:${l.invalidReasons.join("+")}`);
  if (age !== null && age > staleAfterMinutes) status.push(`stale_quote_${age}min`);
  const b = i.baseline;
  if (!b) status.push("baseline_not_calculated");
  else if (b.status === "unavailable") status.push("baseline_unavailable");
  else if (b.status === "partial") status.push("baseline_partial");
  if (b && now.getTime() - b.calculatedAt.getTime() > 8 * 86_400_000) status.push("baseline_older_than_8d");
  if (!i.window.complete) status.push(`recent_window_incomplete_${i.window.presentHours}/${i.window.expectedHours}h`);
  if (i.hourlyBackfill !== "done") status.push(`hourly_backfill_${i.hourlyBackfill}`);

  let multiple = "n/a (no valid current ratio)";
  if (l?.valid && l.ratio) {
    if (!b || b.meanRatio === null) multiple = "n/a (baseline unavailable)";
    else if (b.meanRatio.isZero()) multiple = "n/a (baseline mean is 0)";
    else multiple = `${new Decimal(l.ratio).div(b.meanRatio).toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN).toFixed(4)}x`;
  }
  return {
    cmcId: i.cmcId,
    symbol: i.symbol,
    name: i.name,
    observationTimeUtc: l?.observedAt?.toISOString() ?? null,
    quoteAgeMinutes: age,
    volume24hUsd: l?.volume24hUsd?.toFixed(2) ?? null,
    marketCapUsd: l?.marketCapUsd?.toFixed(2) ?? null,
    currentRatio: l?.ratio?.toFixed(8) ?? null,
    baselineMean: b?.meanRatio?.toFixed(8) ?? null,
    baselineCoverage: b ? `${b.validDays}/${b.expectedDays}d (${(b.coverage * 100).toFixed(1)}%, ${b.status})` : "none",
    baselineWindow: b ? `${b.windowStart}..${b.windowEnd}` : null,
    baselineCalculatedAt: b?.calculatedAt.toISOString() ?? null,
    ratioToBaseline: multiple,
    recentWindow: `${i.window.validHours}/${i.window.expectedHours}h valid${i.window.complete ? "" : `, ${i.window.missingHours.length} missing`}`,
    dataStatus: status.length ? status : ["ok"],
  };
}

const COLS: Array<[keyof ComparisonRow, string, number]> = [
  ["cmcId", "CMC ID", 6],
  ["symbol", "Symbol", 6],
  ["observationTimeUtc", "Observation time UTC", 20],
  ["volume24hUsd", "Volume 24h USD", 19],
  ["marketCapUsd", "Market cap USD", 20],
  ["currentRatio", "Current ratio", 13],
  ["baselineMean", "Baseline mean", 13],
  ["baselineCoverage", "Baseline coverage", 30],
  ["ratioToBaseline", "Cur/Base", 28],
  ["recentWindow", "72h window", 22],
  ["dataStatus", "Data status", 0],
];

export function formatTable(rows: ComparisonRow[], meta: { generatedAt: Date; isFixture: boolean }): string {
  const cell = (v: unknown) => (v === null || v === undefined ? "n/a" : Array.isArray(v) ? v.join(", ") : String(v));
  const fmt = (vals: string[]) => vals.map((v, i) => (COLS[i]![2] ? v.slice(0, COLS[i]![2]).padEnd(COLS[i]![2]) : v)).join(" | ");
  const lines = [
    `Volume / Market Cap comparison — generated ${meta.generatedAt.toISOString()}${meta.isFixture ? " — SYNTHETIC FIXTURE DATA (not CoinMarketCap data)" : ""}`,
    "Current ratio = rolling 24h volume / market cap at the observation time. Baseline = mean of six months of completed daily ratios.",
    "Cur/Base is descriptive only (no thresholds, alerts, or recommendations).",
    "",
    fmt(COLS.map((c) => c[1])),
    fmt(COLS.map((c) => "-".repeat(c[2] || 11))),
    ...rows.map((r) => fmt(COLS.map(([k]) => cell(r[k] === null ? null : k === "observationTimeUtc" && r[k] ? String(r[k]).slice(0, 19) + "Z" : r[k])))),
  ];
  if (rows.length === 0) lines.push("(no assets configured — set VMC_ASSET_IDS)");
  return lines.join("\n");
}
