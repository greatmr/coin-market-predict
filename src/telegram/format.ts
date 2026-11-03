import { formatInZone } from "../common/time.js";

export const TELEGRAM_LIMIT = 4096;
const SAFE_LIMIT = 3800;

/** Numeric paper scenario used to render short entry/exit lines. */
export interface RowScenario {
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  trailPct: number;
  trailActivatePct: number;
  maxHoldHours: number;
  expiresAt: string;
}

export interface ReportRow {
  symbol: string;
  name: string;
  status: string;
  signalType: string;
  price: number | null;
  marketCap: number | null;
  volume24h: number | null;
  volumeWindow: string;
  score: number;
  horizonHours: number;
  entry: string;
  invalidation: string;
  exit: string;
  risk: string[];
  sourceUrl: string;
  observedAt: string | null;
  scenario?: RowScenario;
}

export interface ReportInput {
  generatedAt: Date;
  slotTime: Date;
  timezone: string;
  providerName: string;
  isLive: boolean;
  attribution: string | null;
  coverage: { label: string; collected: number; universeSize: number | null; coveragePct: number | null; stale: number };
  oldestObservedAt: string | null;
  agentStatus: string;
  summary: string | null;
  screened: number;
  eligible: number;
  rows: ReportRow[];
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** $1.23B style amounts. */
export function compactUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "n/a";
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** Price with sensible precision for both $100k coins and sub-cent tokens. */
export function usdPrice(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "n/a";
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(3)}`;
}

const pct = (x: number) => `${(x * 100).toFixed(x * 100 >= 10 ? 0 : 1)}%`;

const STATUS_LABEL: Record<string, string> = {
  candidate: "🟢 Candidate",
  watch: "👀 Watch",
  insufficient_data: "⏳ Not enough data",
  no_signal: "⚪ No signal",
};

const TYPE_LABEL: Record<string, string> = {
  advance: "early move (hypothesis)",
  move_underway: "move already underway",
  none: "",
};

/** Plain-language risk labels (internal flag names are not readable in a chat). */
const RISK_LABEL: Record<string, string> = {
  volume_exceeds_market_cap: "volume > market cap",
  possible_wash_trading: "possible wash trading",
  micro_cap: "very small cap",
  market_cap_calculated: "market cap estimated",
  large_fdv_overhang: "large unlocked supply",
  extreme_1h_move: "extreme 1h move",
  price_up_without_volume: "price up without volume",
  provider_timing_mismatch: "data timing mismatch",
  no_liquidity_data: "no liquidity data",
  thin_history: "short history",
};

export function riskText(flags: string[]): string {
  if (!flags.length) return "none flagged";
  return flags.slice(0, 4).map((f) => RISK_LABEL[f] ?? f.replace(/_/g, " ")).join(", ");
}

function hhmm(iso: string, tz: string): string {
  return formatInZone(new Date(iso), tz).slice(11, 16);
}

export const RESEARCH_NOTE = "Research only, not financial advice.\nNo orders placed · prices checked hourly.";

function card(r: ReportRow, i: number, tz: string): string {
  const s = r.scenario;
  const kind = TYPE_LABEL[r.signalType] ?? "";
  const lines = [
    `<b>${i + 1}. ${escapeHtml(r.symbol)}</b> · ${escapeHtml(r.name)}`,
    `${STATUS_LABEL[r.status] ?? escapeHtml(r.status)}${kind ? ` · ${kind}` : ""}`,
    `💵 ${usdPrice(r.price)}  ·  Cap ${compactUsd(r.marketCap)}`,
    `📈 Vol 24h ${compactUsd(r.volume24h)}  ·  Score ${Math.round(r.score)}/100`,
  ];
  if (s) {
    lines.push(
      `▶️ Enter if ≥ ${usdPrice(s.entryPrice)} by ${hhmm(s.expiresAt, tz)}`,
      `⛔ Stop if ≤ ${usdPrice(s.stopPrice)}`,
      `🎯 Target ${usdPrice(s.targetPrice)} · trail ${pct(s.trailPct)} after +${pct(s.trailActivatePct)}`,
      `⏱ Max hold ${s.maxHoldHours}h`,
    );
  } else {
    lines.push(`▶️ ${escapeHtml(r.entry)}`, `⛔ ${escapeHtml(r.invalidation)}`, `🎯 ${escapeHtml(r.exit)}`);
  }
  lines.push(`⚠️ ${escapeHtml(riskText(r.risk))}`);
  return lines.join("\n");
}

/**
 * Telegram HTML messages designed for a phone screen: one short card per token instead of a
 * wide table, local time first, plain-language labels. Each message ≤ 4096 characters and is
 * split only between cards.
 */
export function formatReport(r: ReportInput): string[] {
  const local = formatInZone(r.generatedAt, r.timezone).slice(11);
  const cov = r.coverage;
  const header = [
    `<b>📊 Coins Predicts — hourly report</b>`,
    `🕒 ${escapeHtml(local)} · data hour ${r.slotTime.toISOString().slice(11, 16)} UTC`,
  ];
  if (!r.isLive) header.push(`🧪 <b>TEST DATA</b> — synthetic prices, not real market data`);
  header.push(
    `📦 ${cov.collected}${cov.universeSize ? `/${cov.universeSize}` : ""} coins checked (${escapeHtml(cov.label)}${cov.stale ? `, ${cov.stale} stale` : ""}) · ${r.eligible} eligible`,
  );
  if (r.summary) header.push(`💬 ${escapeHtml(r.summary)}`);

  const blocks: string[] = [header.join("\n")];
  if (r.rows.length === 0) {
    blocks.push("✅ <b>No qualifying signals this hour.</b>\nNothing passed screening and review — that is normal.");
  } else {
    blocks.push(`<b>Top ${r.rows.length} (ranked)</b>`);
    r.rows.forEach((row, i) => blocks.push(card(row, i, r.timezone)));
  }
  blocks.push(`<i>${escapeHtml(RESEARCH_NOTE)}${r.attribution && r.isLive ? `\n${escapeHtml(r.attribution)}` : ""}</i>`);
  return pack(blocks);
}

/** Pack blocks into messages under the limit, separated by blank lines; never split a block. */
export function pack(blocks: string[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const raw of blocks) {
    const b = raw.length > SAFE_LIMIT ? `${raw.slice(0, SAFE_LIMIT - 2).replace(/<[^>]*$/, "")}…` : raw;
    if (cur && cur.length + 2 + b.length > SAFE_LIMIT) {
      out.push(cur);
      cur = b;
    } else cur = cur ? `${cur}\n\n${b}` : b;
  }
  if (cur) out.push(cur);
  return out.length > 1 ? out.map((m, i) => `${m}\n\n<i>(${i + 1}/${out.length})</i>`) : out;
}
