import { formatInZone } from "../common/time.js";

export const TELEGRAM_LIMIT = 4096;
const SAFE_LIMIT = 3800;

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

export const RESEARCH_NOTE = "Research screen only, not financial advice · no orders placed · the trader decides after chart review";

/** One Review Queue row (values from the database; formatting only). */
export interface QueueRow {
  order: number;
  cmcId: number;
  symbol: string;
  stars: number;
  pass: { d3: string; d7: string; d30: string };
  multiple: { d3: number | null; d7: number | null; d30: number | null };
  currentVmc: number | null;
  capUsd: number | null;
  lbankPairs: string[];
}

export interface Tier1ReportInput {
  generatedAt: Date;
  slotTime: Date;
  crawledAt: Date;
  timezone: string;
  providerName: string;
  isLive: boolean;
  attribution: string | null;
  batchStatus: string;
  batchReasons: string[];
  queueStatus: string;
  counts: { assets: number; eligible: number; needsReview: number; excluded: number; queue: number };
  needsReviewWithYes: number;
  lbankUnverifiedWithYes: number;
  rows: QueueRow[];
  warnings: string[];
}

const WITHHELD: Record<string, string> = {
  WITHHELD_INCOMPLETE_BATCH: "the crawl batch is incomplete, so the queue cannot be complete",
  WITHHELD_LBANK_UNAVAILABLE: "the LBank pair feed is unavailable or stale, so tradability is unknown",
};

/** ASCII-only monospace cell: multiple with "*" for YES (≥ 1.5x), "n/a" for N/A. */
function cell(pass: string, m: number | null): string {
  if (pass === "N/A" || m === null || !Number.isFinite(m)) return "n/a";
  const v = m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(2);
  return pass === "YES" ? `${v}*` : v;
}

const pctText = (x: number | null) => (x === null || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(x * 100 >= 10 ? 1 : 2)}%`);

/** Phone-width (≤ 44 columns) monospace queue table: order, coin, stars, 3d/7d/30d multiples, current VMC. */
export function queueTable(rows: QueueRow[]): string {
  const cols = [
    { h: "#", w: 3, left: true, v: (r: QueueRow) => String(r.order) },
    { h: "Coin", w: 7, left: true, v: (r: QueueRow) => r.symbol.slice(0, 7) },
    { h: "YES", w: 3, left: true, v: (r: QueueRow) => "*".repeat(r.stars) },
    { h: "3d", w: 6, v: (r: QueueRow) => cell(r.pass.d3, r.multiple.d3) },
    { h: "7d", w: 6, v: (r: QueueRow) => cell(r.pass.d7, r.multiple.d7) },
    { h: "30d", w: 6, v: (r: QueueRow) => cell(r.pass.d30, r.multiple.d30) },
    { h: "VMC", w: 6, v: (r: QueueRow) => pctText(r.currentVmc) },
  ];
  const fit = (text: string, w: number, left?: boolean) => (left ? text.padEnd(w) : text.padStart(w)).slice(0, w);
  const line = (vals: string[]) => vals.map((v, i) => fit(v, cols[i]!.w, cols[i]!.left)).join(" ").trimEnd();
  return `<pre>${escapeHtml([line(cols.map((c) => c.h)), ...rows.map((r) => line(cols.map((c) => c.v(r))))].join("\n"))}</pre>`;
}

/**
 * Compact Tier 1 summary for Telegram (HTML, phone width). Presentation only: the Review Queue
 * is a list for human chart review, never a buy signal. A withheld queue is not shown (PDF p.18).
 */
export function formatTier1Report(r: Tier1ReportInput): string[] {
  const local = formatInZone(r.generatedAt, r.timezone).slice(11);
  const header = [
    "<b>📊 Tier 1 VMC screen</b>",
    `🕒 ${escapeHtml(local)} · batch ${r.slotTime.toISOString().slice(0, 13)}:00 UTC · crawled ${r.crawledAt.toISOString().slice(11, 16)} UTC`,
  ];
  if (!r.isLive) header.push("🧪 <b>TEST DATA</b> — synthetic fixture market, not real coins");
  header.push(`📦 ${r.counts.assets} coins · ✅ ${r.counts.eligible} eligible · 🔎 ${r.counts.needsReview} need review · ⛔ ${r.counts.excluded} excluded`);
  if (r.batchStatus !== "COMPLETE") header.push(`⚠️ Batch ${escapeHtml(r.batchStatus)}${r.batchReasons.length ? `: ${escapeHtml(r.batchReasons.join(", "))}` : ""}`);
  const blocks = [header.join("\n")];

  const withheld = WITHHELD[r.queueStatus];
  if (withheld) {
    blocks.push(`⚠️ <b>Review Queue withheld</b>: ${escapeHtml(withheld)}. ${r.counts.queue} eligible coins met at least one window; they stay on the dashboard, marked incomplete.`);
  } else if (!r.rows.length) {
    blocks.push("✅ <b>Review Queue empty.</b> No eligible coin has a current VMC ≥ 1.5× any of its own 3d / 7d / 30d daily averages.");
  } else {
    blocks.push(
      [
        `<b>Review Queue</b> (${r.counts.queue}) — current VMC vs the coin's own completed daily averages`,
        queueTable(r.rows),
        `<i>YES = one * per window met · 2.05* = multiple ≥ 1.5x (YES) · n/a = not available · VMC = rolling 24h volume ÷ market cap${r.counts.queue > r.rows.length ? ` · top ${r.rows.length} of ${r.counts.queue}` : ""}</i>`,
      ].join("\n"),
    );
    const pairs = r.rows.filter((x) => x.lbankPairs.length).slice(0, 5).map((x) => `${escapeHtml(x.symbol)}: ${escapeHtml(x.lbankPairs.join(", "))}`);
    if (pairs.length) blocks.push(`LBank Spot: ${pairs.join(" · ")}`);
  }
  if (r.needsReviewWithYes) blocks.push(`🔎 ${r.needsReviewWithYes} more coin(s) met a window but need review first${r.lbankUnverifiedWithYes ? ` (${r.lbankUnverifiedWithYes} with an unverified LBank pair)` : ""} — see the dashboard.`);
  blocks.push(`<i>${escapeHtml(RESEARCH_NOTE)}${r.attribution && r.isLive ? `\n${escapeHtml(r.attribution)}` : ""}</i>`);
  return pack(blocks);
}

// ---------------------------------------------------------------------------------------------
// /coin: the dashboard drawer (calculation trace) for one coin, as phone-width messages.
// ---------------------------------------------------------------------------------------------

type V = string | number | null | undefined;

/** The subset of ReadModelService.assetTrace() that /coin shows (values already plain JSON). */
export interface CoinDetailInput {
  record: {
    cmcId: number; symbol: string; name: string; rank: number | null; capUsd: V; volume24hUsd: V; priceUsd: V; currentVmc: V;
    currentStatus: string; currentReason?: string | null; observedAt: V; crawledAt: V; dateAdded: V; ageDays: V;
    stars: number; inQueue: boolean; queueOrder: number | null; flags: string[]; venueFlags: string[]; lbankStatus: string;
  };
  batch: { slotTime: V; isLive: boolean };
  eligibility: { status: string; reasons: string[]; assetClass: string; classSource: string };
  current: { formula: string };
  windows: Array<{ days: number; mean: V; reason: string | null; pass: { status: string; multiple: V; reason: string | null } | null }>;
  daily: { asOfDate: string; used: Array<{ dateUtc: string; volumeUsd: V; marketCapUsd: V; vmc: V; closeUsd: V; valid: boolean | null; invalidReasons: string[]; revision: number | null; revisedSinceScan?: boolean }> };
  lbank: {
    status: string; reason: string | null;
    pairs: Array<{ marketPair: string; mapping: string; trading: string; tradingSource: string | null; volumeUsd: V; evidence: string[] }>;
    crawl: { status: string; finishedAt: V; fetchedCount: number } | null;
    decisions: Array<{ decidedAt: V; decision: string; marketPair: string | null; reviewer: string; note?: string | null }>;
    tasks: Array<{ marketPair: string; kind: string; status: string }>;
  };
  venues: { review: string | null; flags: string[]; summary: { dataStatus: string; observedAt: V; pairsUsed: number; expectedCount: number | null; exchanges: Array<{ name: string; volumeUsd: V; volumePercent: V }> } | null };
  reviews: Array<{ revision: number; reviewer: string; reviewedAt: V; venueDecision: string; eventDay: string; finalDecision: string; planStatus: string | null }>;
}

const REASON_TEXT: Record<string, string> = {
  RANK_OUT_OF_RANGE: "rank outside 101–1200", RANK_MISSING: "no CMC rank", RANK_AMBIGUOUS: "duplicate rank",
  MARKET_CAP_BELOW_MIN: "market cap below $15M", MARKET_CAP_MISSING: "market cap missing", LISTING_AGE_BELOW_60D: "listed < 60 days",
  DATE_ADDED_MISSING: "no listing date", STABLECOIN: "stablecoin", TOKENIZED_ASSET: "tokenized stock/asset", CLASS_AMBIGUOUS: "class ambiguous",
  NO_LBANK_SPOT_PAIR: "no LBank Spot pair", LBANK_NOT_TRADABLE: "LBank pair not tradable", LBANK_PAIR_UNVERIFIED: "LBank pair unverified", LBANK_STATUS_UNKNOWN: "LBank status unknown",
  DAILY_ROW_MISSING: "a completed day is missing", DAILY_ROW_INVALID: "a completed day is invalid", ZERO_BASELINE: "zero baseline",
  NOT_EVALUATED_EXCLUDED: "not evaluated (excluded)", CURRENT_STALE: "quote older than the limit", CURRENT_MISSING: "no current quote",
  TIMESTAMP_UNVERIFIED: "no provider time", TIMESTAMP_IN_FUTURE: "provider time in the future", MISMATCHED_OBSERVATION: "volume/cap mismatch",
  CURRENT_CAP_INVALID: "current cap invalid", CURRENT_VOLUME_INVALID: "current volume invalid",
};
const reasonText = (code: string | null | undefined) => {
  if (!code) return "";
  const [k = "", detail] = code.split(":");
  return `${REASON_TEXT[k] ?? k}${detail ? ` (${detail.replace(/_/g, " ").toLowerCase()})` : ""}`;
};
const n = (v: V): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const pct = (v: V, dp = 3) => (n(v) === null ? "n/a" : `${(n(v)! * 100).toFixed(dp)}%`);
const utcShort = (v: V) => (v ? `${String(v).slice(5, 10)} ${String(v).slice(11, 16)} UTC` : "n/a");
const pad = (s: string, w: number, left = false) => (left ? s.padEnd(w) : s.padStart(w)).slice(0, w);
const STATUS_ICON: Record<string, string> = { ELIGIBLE: "✅", NEEDS_REVIEW: "🔎", EXCLUDED: "⛔" };
// Fixed-width rows (≤ 44 columns, readable on a phone); headers use the same widths.
const winLine = (win: string, mean: string, mult: string, result: string) => `${pad(win, 4, true)} ${pad(mean, 8)} ${pad(mult, 8)}  ${result}`;
const dayLine = (date: string, vmc: string, vol: string, cap: string, close: string) => `${pad(date, 5, true)} ${pad(vmc, 7)} ${pad(vol, 7)} ${pad(cap, 8)} ${pad(close, 10)}`;
const venueLine = (name: string, vol: string, share: string) => `${pad(name, 18, true)} ${pad(vol, 8)} ${pad(share, 6)}`;

/**
 * The dashboard drawer for one coin: status, current observation, windows, the completed daily
 * rows used, LBank pairs, venue rows and reviews. Presentation only; every value comes from the
 * stored Tier 1 record.
 */
export function formatCoinDetail(t: CoinDetailInput): string[] {
  const r = t.record;
  const blocks: string[] = [];

  const head = [
    `🪙 <b>${escapeHtml(r.symbol)}</b> · ${escapeHtml(r.name)} · CMC ${r.cmcId}`,
    `🕒 batch ${String(t.batch.slotTime ?? "").slice(0, 16).replace("T", " ")} UTC · crawled ${String(r.crawledAt ?? "").slice(11, 16)} UTC${t.batch.isLive ? "" : " · 🧪 <b>TEST DATA</b>"}`,
    `${STATUS_ICON[t.eligibility.status] ?? "•"} <b>${escapeHtml(t.eligibility.status)}</b> · ${"★".repeat(r.stars)}${"☆".repeat(3 - r.stars)} (${r.stars} of 3 windows)${r.inQueue ? ` · Review Queue #${r.queueOrder}` : ""}`,
  ];
  if (t.eligibility.reasons.length) head.push(`Reasons: ${escapeHtml(t.eligibility.reasons.map(reasonText).join(" · "))}`);
  head.push(`📈 rank ${r.rank ?? "n/a"} · cap ${compactUsd(n(r.capUsd))} · vol 24h ${compactUsd(n(r.volume24hUsd))} · price ${usdPrice(n(r.priceUsd))}`);
  head.push(`🗓 listed ${String(r.dateAdded ?? "n/a").slice(0, 10)} (${n(r.ageDays) === null ? "?" : Math.floor(n(r.ageDays)!)} d) · class ${escapeHtml(t.eligibility.assetClass)} (${escapeHtml(t.eligibility.classSource)})`);
  const flags = [...r.flags, ...r.venueFlags];
  if (flags.length) head.push(`Flags: ${escapeHtml(flags.join(" · "))}`);
  blocks.push(head.join("\n"));

  const curOk = r.currentStatus === "OK";
  const winRows = t.windows.map((w) => {
    const result = w.pass ? (w.pass.status === "N/A" ? "N/A" : w.pass.status) : "context";
    const mult = w.pass && w.pass.status !== "N/A" && n(w.pass.multiple) !== null ? `${n(w.pass.multiple)!.toFixed(2)}x` : "-";
    return winLine(`${w.days}d`, w.mean === null ? "n/a" : pct(w.mean), mult, result);
  });
  const naNotes = t.windows.filter((w) => w.mean === null || w.pass?.status === "N/A").map((w) => `${w.days}d N/A: ${escapeHtml(reasonText(w.pass?.reason ?? w.reason))}`);
  blocks.push([
    `<b>Current VMC</b> · rolling 24h · provider time ${utcShort(r.observedAt)} · ${curOk ? "OK" : `<b>${escapeHtml(r.currentStatus)}</b> (${escapeHtml(reasonText(r.currentReason))})`}`,
    `${compactUsd(n(r.volume24hUsd))} ÷ ${compactUsd(n(r.capUsd))} = <b>${pct(r.currentVmc)}</b>`,
    `<pre>${escapeHtml([winLine("win", "mean", "x mean", "result"), ...winRows].join("\n"))}</pre>`,
    ...naNotes,
    "<i>Means of completed UTC daily ratios · YES iff current ≥ 1.5 × mean · 14d is context only</i>",
  ].join("\n"));

  if (t.daily.used.length) {
    const rows = t.daily.used.map((d) => {
      const date = d.dateUtc.slice(5);
      if (d.vmc === null) return `${date}  ${d.valid === false ? `invalid: ${(d.invalidReasons[0] ?? "").replace(/_/g, " ")}` : "missing"}`;
      return `${dayLine(date, pct(d.vmc), compactUsd(n(d.volumeUsd)), compactUsd(n(d.marketCapUsd)), usdPrice(n(d.closeUsd)))}${d.revisedSinceScan ? " r" : ""}`;
    });
    blocks.push([
      `<b>Completed UTC days used</b> (as of ${escapeHtml(t.daily.asOfDate)}; newest first${rows.some((x) => x.endsWith(" r")) ? "; r = revised after this scan" : ""})`,
      `<pre>${escapeHtml([dayLine("date", "VMC", "volume", "mcap", "close"), ...rows].join("\n"))}</pre>`,
    ].join("\n"));
  } else blocks.push("<b>Daily rows</b>: not evaluated — no daily history is requested for excluded coins.");

  const lb = t.lbank;
  const lbLines = [`<b>LBank Spot pairs</b> · ${escapeHtml(lb.status)}${lb.reason ? ` (${escapeHtml(reasonText(lb.reason))})` : ""}${lb.crawl ? ` · list ${escapeHtml(lb.crawl.status)} ${utcShort(lb.crawl.finishedAt)}` : ""}`];
  for (const p of lb.pairs) {
    const trading = p.trading === "TRADING" ? `tradable${p.tradingSource ? ` (${p.tradingSource === "listing" ? "listed" : p.tradingSource})` : ""}` : p.trading.toLowerCase().replace(/_/g, " ");
    lbLines.push(`• ${escapeHtml(p.marketPair)} · mapping ${escapeHtml(p.mapping)} · ${escapeHtml(trading)} · vol ${compactUsd(n(p.volumeUsd))}`);
    if (p.mapping === "AMBIGUOUS" || p.mapping === "REJECTED") for (const e of p.evidence.slice(0, 2)) lbLines.push(`  ↳ ${escapeHtml(e)}`);
  }
  if (!lb.pairs.length) lbLines.push("No LBank Spot pair maps to this coin.");
  const openTasks = lb.tasks.filter((x) => x.status === "OPEN");
  if (openTasks.length) lbLines.push(`Open mapping tasks: ${escapeHtml(openTasks.map((x) => `${x.marketPair} (${x.kind.toLowerCase().replace(/_/g, " ")})`).join(", "))} — decide on the dashboard`);
  for (const d of lb.decisions.slice(0, 3)) lbLines.push(`Decision ${utcShort(d.decidedAt)}: ${escapeHtml(d.decision)} ${escapeHtml(d.marketPair ?? "(coin)")} by ${escapeHtml(d.reviewer)}`);
  blocks.push(lbLines.join("\n"));

  const v = t.venues;
  if (v.summary && v.summary.dataStatus !== "MISSING") {
    const ex = v.summary.exchanges.slice(0, 8).map((e) => venueLine(e.name, compactUsd(n(e.volumeUsd)), n(e.volumePercent) === null ? "-" : `${n(e.volumePercent)!.toFixed(1)}%`));
    blocks.push([
      `<b>CMC Markets venues</b> · ${escapeHtml(v.summary.dataStatus)} · ${v.summary.pairsUsed} of ${v.summary.expectedCount ?? "?"} spot pairs · ${utcShort(v.summary.observedAt)}`,
      ex.length ? `<pre>${escapeHtml([venueLine("exchange", "vol 24h", "share"), ...ex].join("\n"))}</pre>` : "No venue rows.",
      `Venue review: ${escapeHtml(v.review ?? "PENDING")}${v.flags.length ? ` · ${escapeHtml(v.flags.join(" · "))}` : ""}`,
    ].join("\n"));
  } else blocks.push("<b>CMC Markets venues</b>: not collected yet (collected for review candidates).");

  blocks.push(
    t.reviews.length
      ? ["<b>Reviews</b> (append-only)", ...t.reviews.slice(0, 3).map((x) => `• r${x.revision} · ${utcShort(x.reviewedAt)} · ${escapeHtml(x.reviewer)} · ${escapeHtml(x.finalDecision)}${x.planStatus ? ` (${escapeHtml(x.planStatus)})` : ""} · venue ${escapeHtml(x.venueDecision)} · day ${escapeHtml(x.eventDay)}`)].join("\n")
      : "<b>Reviews</b>: none yet — record one on the dashboard.",
  );
  blocks.push("<i>Descriptive screen result, not advice · /vmc for the short version</i>");
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
