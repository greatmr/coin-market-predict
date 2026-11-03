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

/** One row of the pump watchlist table (strategy + agents). Values come from the read model. */
export interface RecommendationRow {
  symbol: string;
  name: string;
  price: number | null;
  marketCap: number | null;
  volume24h: number | null;
  /** Price change over the stored last three days (fraction) and the hours it spans. */
  threeDayChange: number | null;
  threeDaySpanHours: number;
  /** 24h volume ÷ market cap now, its six-month daily mean, and the multiple. */
  vmcCurrent: number | null;
  vmcBaseline: number | null;
  vmcMultiple: number | null;
  pumpChance: "high" | "medium" | "low";
  pumpReasons: string[];
  /** Agents' own stance (null = not reviewed by agents) and the combined recommendation. */
  agentRecommendation: "buy" | "hold" | "sell" | null;
  agentReason: string | null;
  agentOrigin: string | null;
  recommendation: "buy" | "watch" | "avoid";
  recommendationReason: string;
  risk: string[];
  scenario?: { entryPrice: number; stopPrice: number | null; targetPrice: number | null; expiresAt: string | null };
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
  /** Pump watchlist; when present it replaces the per-signal cards with a table + cards. */
  recommendations?: RecommendationRow[];
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
  if (r.recommendations?.length) {
    blocks.push(recTable(r.recommendations));
    r.recommendations.forEach((row, i) => blocks.push(recCard(row, i, r.timezone)));
  } else if (r.rows.length === 0) {
    blocks.push("✅ <b>No qualifying signals this hour.</b>\nNothing passed screening and review — that is normal.");
  } else {
    blocks.push(`<b>Top ${r.rows.length} (ranked)</b>`);
    r.rows.forEach((row, i) => blocks.push(card(row, i, r.timezone)));
  }
  blocks.push(`<i>${escapeHtml(RESEARCH_NOTE)}${r.attribution && r.isLive ? `\n${escapeHtml(r.attribution)}` : ""}</i>`);
  return pack(blocks);
}

const PUMP_SHORT = { high: "HIGH", medium: "MED", low: "LOW" } as const;
const AGENT_SHORT = { buy: "BUY", hold: "HOLD", sell: "SELL" } as const;
const REC_SHORT = { buy: "BUY", watch: "WATCH", avoid: "AVOID" } as const;
const REC_LABEL = { buy: "✅ BUY (paper, on entry trigger)", watch: "👀 WATCH", avoid: "⛔ AVOID" } as const;
const PUMP_LABEL = { high: "🔥 HIGH", medium: "🌤 MEDIUM", low: "🧊 LOW" } as const;

/** ASCII-only signed percent for monospace tables (no Unicode minus: alignment must hold). */
function tablePct(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return "n/a";
  const v = x * 100;
  return `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(Math.abs(v) >= 100 ? 0 : 1)}%`;
}
/** Compact amount without the dollar sign: 61M, 1.6B, 950K. */
function tableAmount(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "n/a";
  const a = Math.abs(n);
  const f = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(0) : v.toFixed(1));
  if (a >= 1e12) return `${f(n / 1e12)}T`;
  if (a >= 1e9) return `${f(n / 1e9)}B`;
  if (a >= 1e6) return `${f(n / 1e6)}M`;
  if (a >= 1e3) return `${f(n / 1e3)}K`;
  return n.toFixed(0);
}
const tableMultiple = (m: number | null) => (m === null || !Number.isFinite(m) ? "n/a" : `${m >= 10 ? m.toFixed(0) : m.toFixed(1)}x`);

/** Phone-width monospace table (≤ 44 columns): coin, 3-day move, market cap, VMC multiple, pump chance, agents, combined. */
export function recTable(rows: RecommendationRow[]): string {
  const cols = [
    { h: "Coin", w: 6, left: true, v: (r: RecommendationRow) => r.symbol.slice(0, 6) },
    { h: "3d", w: 7, v: (r: RecommendationRow) => tablePct(r.threeDayChange) },
    { h: "MCap", w: 5, v: (r: RecommendationRow) => tableAmount(r.marketCap) },
    { h: "VMC", w: 4, v: (r: RecommendationRow) => tableMultiple(r.vmcMultiple) },
    { h: "Pump", w: 4, left: true, v: (r: RecommendationRow) => PUMP_SHORT[r.pumpChance] },
    { h: "Agent", w: 5, left: true, v: (r: RecommendationRow) => (r.agentRecommendation ? AGENT_SHORT[r.agentRecommendation] : "-") },
    { h: "Rec", w: 5, left: true, v: (r: RecommendationRow) => REC_SHORT[r.recommendation] },
  ];
  const cell = (text: string, w: number, left?: boolean) => (left ? text.padEnd(w) : text.padStart(w)).slice(0, w);
  const line = (vals: string[]) => vals.map((v, i) => cell(v, cols[i]!.w, cols[i]!.left)).join(" ").trimEnd();
  const lines = [line(cols.map((c) => c.h)), ...rows.map((r) => line(cols.map((c) => c.v(r))))];
  return [
    `<b>🔥 Pump watchlist</b> · strategy + agents`,
    `<pre>${escapeHtml(lines.join("\n"))}</pre>`,
    `<i>3d = price change over the last 72h · VMC = 24h volume/market cap vs its 6-month average · Pump = strategy chance (heuristic, not a probability) · Agent = agents' own view · Rec = combined</i>`,
  ].join("\n");
}

function recCard(r: RecommendationRow, i: number, tz: string): string {
  const span = r.threeDaySpanHours >= 70 || r.threeDayChange === null ? "3d" : `${r.threeDaySpanHours}h`;
  const lines = [
    `<b>${i + 1}. ${escapeHtml(r.symbol)}</b> · ${escapeHtml(r.name)}`,
    `${REC_LABEL[r.recommendation]} · ${PUMP_LABEL[r.pumpChance]} pump chance`,
    `🤖 Agents: ${r.agentRecommendation ? `<b>${AGENT_SHORT[r.agentRecommendation]}</b>${r.agentOrigin === "fixture_agent" ? " (offline stand-in)" : ""}` : "not reviewed"}`,
    `💵 ${usdPrice(r.price)} · ${span} ${escapeHtml(tablePct(r.threeDayChange))} · Cap ${compactUsd(r.marketCap)}`,
    `📊 VMC ${r.vmcCurrent === null ? "n/a" : r.vmcCurrent.toFixed(3)}${r.vmcBaseline !== null ? ` vs ${r.vmcBaseline.toFixed(3)} 6-mo avg (${escapeHtml(tableMultiple(r.vmcMultiple))})` : " · no 6-mo baseline yet"}`,
  ];
  for (const reason of r.pumpReasons.slice(0, 3)) lines.push(`• ${escapeHtml(reason)}`);
  if (r.agentReason) lines.push(`🤖 ${escapeHtml(r.agentReason.slice(0, 220))}`);
  if (r.scenario) {
    const exp = r.scenario.expiresAt ? ` by ${hhmm(r.scenario.expiresAt, tz)}` : "";
    lines.push(`▶️ Enter ≥ ${usdPrice(r.scenario.entryPrice)}${exp}`);
    lines.push(`⛔ Stop ≤ ${usdPrice(r.scenario.stopPrice)} · 🎯 ${usdPrice(r.scenario.targetPrice)}`);
  }
  lines.push(`⚖️ ${escapeHtml(r.recommendationReason.slice(0, 200))}`);
  if (r.risk.length) lines.push(`⚠️ ${escapeHtml(riskText(r.risk))}`);
  return lines.join("\n");
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
