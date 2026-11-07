import { formatInZone } from '../../common/utils/time.js';

export const TELEGRAM_LIMIT = 4096;
const SAFE_LIMIT = 3800;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** $1.23B style amounts. */
export function compactUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'n/a';
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** Price with sensible precision for both $100k coins and sub-cent tokens. */
export function usdPrice(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'n/a';
  if (n >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(3)}`;
}

export const RESEARCH_NOTE = 'Research screen, not financial advice · no orders are placed';

const int = (x: number) => x.toLocaleString('en-US');
const plural = (k: number, one: string, many = `${one}s`) => `${int(k)} ${k === 1 ? one : many}`;

/** VMC as a percent: 68.8%, 8.19%, 0.663%. */
export function vmcPct(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return 'n/a';
  const p = x * 100;
  return `${p.toFixed(p >= 10 ? 1 : p >= 1 ? 2 : 3)}%`;
}

/** Multiple of a window mean: 6.51×, 12.4×, 135×. */
export function multX(m: number | null): string {
  if (m === null || !Number.isFinite(m)) return 'n/a';
  return `${m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(2)}×`;
}

const SPARK = '▁▂▃▄▅▆▇█';
/**
 * One block character per value; missing values are "·". The range defaults to the series' own
 * min–max; pass one to draw several series on the same scale.
 */
export function sparkline(
  values: Array<number | null>,
  range?: { lo: number; hi: number },
): string {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (!nums.length) return '';
  const hi = range?.hi ?? Math.max(...nums);
  const lo = range?.lo ?? Math.min(...nums);
  const span = hi - lo || 1;
  return values
    .map((v) =>
      v === null || !Number.isFinite(v)
        ? '·'
        : SPARK[Math.max(0, Math.min(7, Math.round(((v - lo) / span) * 7)))]!,
    )
    .join('');
}

/** Multiples share the dashboard's log scale up to 6×, so bars compare across coins and windows. */
const MULT_MAX = 6;
export function multBar(m: number | null, width = 8): string {
  if (m === null || !Number.isFinite(m)) return ' '.repeat(width);
  const f = Math.max(0, Math.min(1, Math.log1p(Math.max(0, m)) / Math.log1p(MULT_MAX)));
  const filled = Math.round(f * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

const stars = (k: number) => '★'.repeat(k) + '☆'.repeat(Math.max(0, 3 - k));

// ---------------------------------------------------------------------------------------------
// Hourly report
// ---------------------------------------------------------------------------------------------

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
  counts: {
    assets: number;
    eligible: number;
    needsReview: number;
    excluded: number;
    queue: number;
  };
  needsReviewWithYes: number;
  lbankUnverifiedWithYes: number;
  rows: QueueRow[];
  warnings: string[];
  /** The bot's @username: coin names become tappable deep links. Null keeps /coin_<id> commands. */
  botUsername?: string | null;
}

const WITHHELD: Record<string, string> = {
  WITHHELD_INCOMPLETE_BATCH: "The crawl batch is incomplete, so the queue can't be complete.",
  WITHHELD_LBANK_UNAVAILABLE: 'The LBank pair list is missing or stale, so tradability is unknown.',
};

/** "13 Nov, 22:30 IRST" in the display timezone. */
function localStamp(d: Date, tz: string): { time: string; day: string } {
  const s = formatInZone(d, tz); // YYYY-MM-DD HH:mm ZONE
  const day = new Date(`${s.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  return { time: s.slice(11), day };
}

/** YES in bold, NO plain, N/A as a dash: the bold windows are the ones that met 1.5×. */
function windowText(label: string, pass: string, m: number | null): string {
  if (pass === 'N/A' || m === null || !Number.isFinite(m)) return `${label} –`;
  return pass === 'YES' ? `${label} <b>${multX(m)}</b>` : `${label} ${multX(m)}`;
}

/**
 * A coin name as a deep link to the bot: tapping it sends /start coin_<id> in the bot's chat,
 * and the bot answers with that coin's details. `label` is already-escaped HTML.
 */
export function coinLink(
  label: string,
  cmcId: number,
  bot: string,
  command: 'coin' | 'vmc' = 'coin',
): string {
  if (!/^[A-Za-z0-9_]{5,32}$/.test(bot) || !Number.isSafeInteger(cmcId)) return label;
  return `<a href="https://t.me/${bot}?start=${command}_${cmcId}">${label}</a>`;
}

/** Two lines per coin: who and how strong, then the three windows; the command opens /coin. */
export function queueCard(r: QueueRow, bot: string | null = null): string {
  const unusualPair = r.lbankPairs.find((p) => p !== `${r.symbol}/USDT`);
  const name = `<b>${r.order}. ${escapeHtml(r.symbol)}</b>`;
  return [
    `${bot ? coinLink(name, r.cmcId, bot) : name}  ${stars(r.stars)}  VMC <b>${vmcPct(r.currentVmc)}</b>${bot ? '' : `  /coin_${r.cmcId}`}`,
    `└ ${[windowText('3d', r.pass.d3, r.multiple.d3), windowText('7d', r.pass.d7, r.multiple.d7), windowText('30d', r.pass.d30, r.multiple.d30)].join(' · ')}${unusualPair ? ` · LBank ${escapeHtml(unusualPair)}` : ''}`,
  ].join('\n');
}

/**
 * Hourly Tier 1 summary for Telegram (HTML, phone width). Presentation only: the Review Queue
 * is a list for human chart review, never a buy signal. A withheld queue is not shown (PDF p.18).
 */
export function formatTier1Report(r: Tier1ReportInput): string[] {
  const at = localStamp(r.slotTime, r.timezone);
  const blocks: string[] = [];
  const head = [
    `📊 <b>VMC screen · ${escapeHtml(at.time)}</b>`,
    `<i>${escapeHtml(at.day)} · batch ${r.slotTime.toISOString().slice(11, 16)} UTC · ${escapeHtml(r.providerName)}</i>`,
  ];
  if (!r.isLive) head.push('🧪 <b>Test data</b>: a synthetic market, not real coins');
  blocks.push(head.join('\n'));

  if (r.batchStatus !== 'COMPLETE')
    blocks.push(
      `⚠️ <b>Batch ${escapeHtml(r.batchStatus.toLowerCase())}</b>${r.batchReasons.length ? `: ${escapeHtml(r.batchReasons.join(', '))}` : ''}`,
    );

  const funnel = `<i>${int(r.counts.assets)} coins · ${int(r.counts.eligible)} eligible · ${int(r.counts.needsReview)} need review · ${int(r.counts.excluded)} excluded</i>`;
  const withheld = WITHHELD[r.queueStatus];
  if (withheld) {
    blocks.push(
      [
        '⚠️ <b>Review queue withheld</b>',
        `${escapeHtml(withheld)} ${plural(r.counts.queue, 'eligible coin')} met a window; they stay on the dashboard, marked incomplete.`,
        funnel,
      ].join('\n'),
    );
  } else if (!r.rows.length) {
    blocks.push(
      [
        '✅ <b>Review queue is empty</b>',
        "No eligible coin's current VMC is at least 1.5× its own 3, 7 or 30-day mean.",
        funnel,
      ].join('\n'),
    );
  } else {
    blocks.push(
      [`🎯 <b>${plural(r.counts.queue, 'coin')} in the review queue</b>`, funnel].join('\n'),
    );
    const bot = r.botUsername ?? null;
    blocks.push(r.rows.map((row) => queueCard(row, bot)).join('\n'));
    const more = r.counts.queue - r.rows.length;
    blocks.push(
      `<i>Bold = at least 1.5× the coin's own mean (YES). ${r.botUsername ? 'Tap a coin for its details.' : 'Tap a /coin link for details.'}${more > 0 ? ` ${plural(more, 'more coin')} in the workbook and on the dashboard.` : ''}</i>`,
    );
  }
  if (r.needsReviewWithYes)
    blocks.push(
      `🔎 ${plural(r.needsReviewWithYes, 'more coin')} met a window but ${r.needsReviewWithYes === 1 ? 'needs' : 'need'} review first${r.lbankUnverifiedWithYes ? ` (${int(r.lbankUnverifiedWithYes)} with an unverified LBank pair)` : ''}. See the dashboard.`,
    );
  blocks.push(
    `<i>${escapeHtml(RESEARCH_NOTE)}${r.attribution && r.isLive ? ` · ${escapeHtml(r.attribution.replace(/^Data:\s*/i, 'data: '))}` : ''}</i>`,
  );
  return pack(blocks);
}

// ---------------------------------------------------------------------------------------------
// /coin and /vmc: one coin of the latest scan
// ---------------------------------------------------------------------------------------------

type V = string | number | null | undefined;

/** The subset of ReadModelService.assetTrace() that /coin shows (values already plain JSON). */
export interface CoinDetailInput {
  record: {
    cmcId: number;
    symbol: string;
    name: string;
    rank: number | null;
    capUsd: V;
    volume24hUsd: V;
    priceUsd: V;
    currentVmc: V;
    currentStatus: string;
    currentReason?: string | null;
    observedAt: V;
    crawledAt: V;
    dateAdded: V;
    ageDays: V;
    stars: number;
    inQueue: boolean;
    queueOrder: number | null;
    flags: string[];
    venueFlags: string[];
    lbankStatus: string;
  };
  batch: { slotTime: V; isLive: boolean };
  eligibility: { status: string; reasons: string[]; assetClass: string; classSource: string };
  current: { formula: string };
  windows: Array<{
    days: number;
    mean: V;
    reason: string | null;
    pass: { status: string; multiple: V; reason: string | null } | null;
  }>;
  daily: {
    asOfDate: string;
    used: Array<{
      dateUtc: string;
      volumeUsd: V;
      marketCapUsd: V;
      vmc: V;
      closeUsd: V;
      valid: boolean | null;
      invalidReasons: string[];
      revision: number | null;
      revisedSinceScan?: boolean;
    }>;
  };
  lbank: {
    status: string;
    reason: string | null;
    pairs: Array<{
      marketPair: string;
      mapping: string;
      trading: string;
      tradingSource: string | null;
      volumeUsd: V;
      evidence: string[];
    }>;
    crawl: { status: string; finishedAt: V; fetchedCount: number } | null;
    decisions: Array<{
      decidedAt: V;
      decision: string;
      marketPair: string | null;
      reviewer: string;
      note?: string | null;
    }>;
    tasks: Array<{ marketPair: string; kind: string; status: string }>;
  };
  venues: {
    review: string | null;
    flags: string[];
    summary: {
      dataStatus: string;
      observedAt: V;
      pairsUsed: number;
      expectedCount: number | null;
      exchanges: Array<{ name: string; volumeUsd: V; volumePercent: V }>;
    } | null;
  };
  reviews: Array<{
    revision: number;
    reviewer: string;
    reviewedAt: V;
    venueDecision: string;
    eventDay: string;
    finalDecision: string;
    planStatus: string | null;
  }>;
}

const REASON_TEXT: Record<string, string> = {
  RANK_OUT_OF_RANGE: 'rank outside 101–1200',
  RANK_MISSING: 'no CMC rank',
  RANK_AMBIGUOUS: 'duplicate rank',
  MARKET_CAP_BELOW_MIN: 'market cap below $15M',
  MARKET_CAP_MISSING: 'market cap missing',
  LISTING_AGE_BELOW_60D: 'listed under 60 days',
  DATE_ADDED_MISSING: 'no listing date',
  STABLECOIN: 'stablecoin',
  TOKENIZED_ASSET: 'tokenized stock or asset',
  CLASS_AMBIGUOUS: 'class ambiguous',
  NO_LBANK_SPOT_PAIR: 'no LBank Spot pair',
  LBANK_NOT_TRADABLE: 'LBank pair not tradable',
  LBANK_PAIR_UNVERIFIED: 'LBank pair unverified',
  LBANK_STATUS_UNKNOWN: 'LBank status unknown',
  DAILY_ROW_MISSING: 'a completed day is missing',
  DAILY_ROW_INVALID: 'a completed day is invalid',
  ZERO_BASELINE: 'zero baseline',
  NOT_EVALUATED_EXCLUDED: 'not evaluated (excluded)',
  CURRENT_STALE: 'quote older than the limit',
  CURRENT_MISSING: 'no current quote',
  TIMESTAMP_UNVERIFIED: 'no provider time',
  TIMESTAMP_IN_FUTURE: 'provider time in the future',
  MISMATCHED_OBSERVATION: 'volume and cap mismatch',
  CURRENT_CAP_INVALID: 'current cap invalid',
  CURRENT_VOLUME_INVALID: 'current volume invalid',
};
const reasonText = (code: string | null | undefined) => {
  if (!code) return '';
  const [k = '', detail] = code.split(':');
  return `${REASON_TEXT[k] ?? k.replace(/_/g, ' ').toLowerCase()}${detail ? ` (${detail.replace(/_/g, ' ').toLowerCase()})` : ''}`;
};
const n = (v: V): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const utcShort = (v: V) => (v ? `${String(v).slice(5, 10)} ${String(v).slice(11, 16)} UTC` : 'n/a');
const dayShort = (ymd: string) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
  });
const pad = (s: string, w: number, left = false) =>
  (left ? s.padEnd(w) : s.padStart(w)).slice(0, w);
const lower = (s: string) => s.toLowerCase().replace(/_/g, ' ');
const STATUS: Record<string, string> = {
  ELIGIBLE: '✅ Eligible',
  NEEDS_REVIEW: '🔎 Needs review',
  EXCLUDED: '⛔ Excluded',
};

/** Fixed-width window rows (≤ 36 columns) with a bar of the multiple on the shared log scale. */
const winLine = (win: string, mean: string, bar: string, mult: string, result: string) =>
  `${pad(win, 3, true)} ${pad(mean, 7)}  ${bar} ${pad(mult, 6)} ${result}`.trimEnd();

/** The windows table plus a 30-day VMC sparkline that ends in today's value (shared by /coin and /vmc). */
function vmcBlock(t: CoinDetailInput): string {
  const r = t.record;
  const cur = n(r.currentVmc);
  const rows = t.windows.map((w) => {
    const mean = n(w.mean);
    if (!w.pass) return winLine(`${w.days}d`, vmcPct(mean), ' '.repeat(8), '', 'context');
    if (w.pass.status === 'N/A' || mean === null)
      return winLine(`${w.days}d`, vmcPct(mean), ' '.repeat(8), '', 'N/A');
    const m = n(w.pass.multiple);
    return winLine(`${w.days}d`, vmcPct(mean), multBar(m), multX(m), w.pass.status);
  });
  const days = [...t.daily.used].reverse(); // oldest → newest
  const series = days.map((d) => n(d.vmc));
  const all = [...series, cur].filter((v): v is number => v !== null);
  const pre = [...rows];
  if (all.length > 1) {
    // VMC has a natural zero, so the bars start at 0 and today's spike reads true to size.
    const range = { lo: 0, hi: Math.max(...all) };
    pre.push(
      '',
      `${days.length}d ${sparkline(series, range)} ${sparkline([cur], range) || '·'} now`,
    );
  }
  // One line per distinct N/A reason ("3d, 7d N/A: a completed day is missing"), not per window.
  const byReason = new Map<string, string[]>();
  for (const w of t.windows.filter((x) => x.mean === null || x.pass?.status === 'N/A')) {
    const why = reasonText(w.pass?.reason ?? w.reason);
    byReason.set(why, [...(byReason.get(why) ?? []), `${w.days}d`]);
  }
  const naNotes = [...byReason].map(([why, wins]) => `${wins.join(', ')} N/A: ${escapeHtml(why)}`);
  const quote =
    r.currentStatus === 'OK'
      ? ''
      : ` · ⚠️ ${escapeHtml(lower(r.currentStatus))}${r.currentReason ? ` (${escapeHtml(reasonText(r.currentReason))})` : ''}`;
  const head = [
    `<b>Volume ÷ market cap</b> · now <b>${vmcPct(cur)}</b>${quote}`,
    `<i>${compactUsd(n(r.volume24hUsd))} rolling 24h volume ÷ ${compactUsd(n(r.capUsd))} cap</i>`,
  ];
  if (t.windows.every((w) => n(w.mean) === null) && !t.daily.used.length)
    return [...head, '<i>Windows not evaluated: excluded coins get no daily history.</i>'].join(
      '\n',
    );
  return [
    ...head,
    `<pre>${escapeHtml(pre.join('\n'))}</pre>`,
    ...naNotes,
    '<i>YES = now at least 1.5× the mean of completed UTC days · 14d is context only</i>',
  ].join('\n');
}

function headBlock(t: CoinDetailInput): string {
  const r = t.record;
  const slot = String(t.batch.slotTime ?? '').slice(11, 16);
  const lines = [
    `🪙 <b>${escapeHtml(r.symbol)}</b> · ${escapeHtml(r.name)}`,
    `<i>Rank ${r.rank ?? 'n/a'} · CMC ${r.cmcId} · batch ${slot} UTC${t.batch.isLive ? '' : ' · test data'}</i>`,
    `${STATUS[t.eligibility.status] ?? escapeHtml(t.eligibility.status)} · ${stars(r.stars)}${r.inQueue ? ` · 🎯 queue #${r.queueOrder}` : ''}`,
    `💵 ${usdPrice(n(r.priceUsd))} · cap ${compactUsd(n(r.capUsd))} · vol 24h ${compactUsd(n(r.volume24hUsd))}`,
  ];
  if (!t.batch.isLive) lines.push('🧪 <b>Test data</b>: a synthetic market, not a real coin');
  if (t.eligibility.reasons.length)
    lines.push(`Left out: ${escapeHtml(t.eligibility.reasons.map(reasonText).join(' · '))}`);
  const flags = [...r.flags, ...r.venueFlags];
  if (flags.length) lines.push(`🚩 ${escapeHtml(flags.map(lower).join(' · '))}`);
  return lines.join('\n');
}

/** /vmc: the coin's header line and its windows only. */
export function formatVmcBrief(t: CoinDetailInput, bot: string | null = null): string {
  const r = t.record;
  return [
    `🪙 <b>${escapeHtml(r.symbol)}</b> · ${escapeHtml(r.name)} · ${STATUS[t.eligibility.status] ?? escapeHtml(t.eligibility.status)} · ${stars(r.stars)}${r.inQueue ? ` · 🎯 #${r.queueOrder}` : ''}`,
    '',
    vmcBlock(t),
    '',
    bot
      ? `<i>${coinLink(`Everything about ${escapeHtml(r.symbol)}`, r.cmcId, bot)}</i>`
      : `<i>Everything about this coin: /coin_${r.cmcId}</i>`,
  ].join('\n');
}

/**
 * /coin: the dashboard's coin detail as phone-width messages: status, the VMC windows with
 * sparklines, price, LBank, venues, reviews, and the daily rows in a collapsed quote.
 * Presentation only; every value comes from the stored Tier 1 record.
 */
export function formatCoinDetail(t: CoinDetailInput): string[] {
  const blocks = [headBlock(t), vmcBlock(t)];

  const days = [...t.daily.used].reverse();
  const closes = days.map((d) => n(d.closeUsd));
  const known = closes.filter((v): v is number => v !== null);
  if (known.length > 1) {
    const first = known[0]!,
      last = known[known.length - 1]!;
    const change = first ? ((last - first) / first) * 100 : null;
    blocks.push(
      [
        `<b>Price</b> · ${days.length} days`,
        `<pre>${escapeHtml(`${sparkline(closes)}\n${usdPrice(first)} → ${usdPrice(last)}${change === null ? '' : ` (${change >= 0 ? '+' : '−'}${Math.abs(change).toFixed(1)}%)`}`)}</pre>`,
      ].join('\n'),
    );
  }

  const lb = t.lbank;
  const market = [
    `<b>LBank</b> · ${escapeHtml(lower(lb.status))}${lb.reason ? ` (${escapeHtml(reasonText(lb.reason))})` : ''}`,
  ];
  for (const p of lb.pairs) {
    const trading =
      p.trading === 'TRADING'
        ? `tradable${p.tradingSource ? ` (${p.tradingSource === 'listing' ? 'listed' : p.tradingSource})` : ''}`
        : lower(p.trading);
    const mapping = p.mapping === 'OK' ? '' : ` · mapping ${lower(p.mapping)}`;
    market.push(
      `• ${escapeHtml(p.marketPair)} · ${escapeHtml(trading)}${escapeHtml(mapping)} · vol ${compactUsd(n(p.volumeUsd))}`,
    );
    if (p.mapping === 'AMBIGUOUS' || p.mapping === 'REJECTED')
      for (const e of p.evidence.slice(0, 2)) market.push(`  ↳ ${escapeHtml(e)}`);
  }
  if (!lb.pairs.length) market.push('No LBank Spot pair maps to this coin.');
  const openTasks = lb.tasks.filter((x) => x.status === 'OPEN');
  if (openTasks.length)
    market.push(
      `Open mapping tasks: ${escapeHtml(openTasks.map((x) => `${x.marketPair} (${lower(x.kind)})`).join(', '))}. Decide on the dashboard.`,
    );
  const lastDecision = lb.decisions[0];
  if (lastDecision)
    market.push(
      `Last decision ${utcShort(lastDecision.decidedAt)}: ${escapeHtml(lower(lastDecision.decision))} ${escapeHtml(lastDecision.marketPair ?? '(coin)')} by ${escapeHtml(lastDecision.reviewer)}`,
    );

  const v = t.venues;
  if (v.summary && v.summary.dataStatus !== 'MISSING' && v.summary.exchanges.length) {
    const ex = [...v.summary.exchanges].sort(
      (a, b) => (n(b.volumeUsd) ?? 0) - (n(a.volumeUsd) ?? 0),
    );
    const top = ex
      .slice(0, 3)
      .map(
        (e) =>
          `${escapeHtml(e.name)} ${n(e.volumePercent) === null ? compactUsd(n(e.volumeUsd)) : `${n(e.volumePercent)!.toFixed(0)}%`}`,
      );
    market.push(
      '',
      `<b>Where it trades</b> · ${top.join(' · ')}${ex.length > 3 ? ` · +${ex.length - 3} more` : ''}`,
    );
    if (v.flags.length || (v.review && v.review !== 'PENDING'))
      market.push(
        `Venue review ${escapeHtml(lower(v.review ?? 'PENDING'))}${v.flags.length ? ` · ${escapeHtml(v.flags.map(lower).join(' · '))}` : ''}`,
      );
  } else if (t.eligibility.status !== 'EXCLUDED')
    market.push('', '<b>Where it trades</b> · collected for review candidates only');

  const rv = t.reviews[0];
  if (rv)
    market.push(
      '',
      `<b>Review</b> · ${escapeHtml(lower(rv.finalDecision))}${rv.planStatus ? ` (${escapeHtml(lower(rv.planStatus))})` : ''} · r${rv.revision} by ${escapeHtml(rv.reviewer)}, ${utcShort(rv.reviewedAt)}${t.reviews.length > 1 ? ` · ${t.reviews.length} revisions` : ''}`,
    );
  else if (t.eligibility.status !== 'EXCLUDED')
    market.push('', '<b>Review</b> · none yet. Record one on the dashboard.');
  blocks.push(market.join('\n'));

  if (t.daily.used.length) {
    const rows = t.daily.used.map((d) => {
      const date = dayShort(d.dateUtc);
      if (n(d.vmc) === null)
        return `${date} · ${d.valid === false ? `invalid: ${escapeHtml(lower(d.invalidReasons[0] ?? ''))}` : 'missing'}`;
      return `${date} · <b>${vmcPct(n(d.vmc))}</b> · vol ${compactUsd(n(d.volumeUsd))} · cap ${compactUsd(n(d.marketCapUsd))} · ${usdPrice(n(d.closeUsd))}${d.revisedSinceScan ? ' · revised' : ''}`;
    });
    blocks.push(
      `<blockquote expandable><b>Daily rows used</b> · ${t.daily.used.length} completed UTC days, newest first\n${rows.join('\n')}</blockquote>`,
    );
  }

  blocks.push('<i>Descriptive screen result, not advice · /vmc for the short version</i>');
  return pack(blocks);
}

/** Pack blocks into messages under the limit, separated by blank lines; never split a block. */
export function pack(blocks: string[]): string[] {
  const out: string[] = [];
  let cur = '';
  for (const raw of blocks) {
    const b =
      raw.length > SAFE_LIMIT ? `${raw.slice(0, SAFE_LIMIT - 2).replace(/<[^>]*$/, '')}…` : raw;
    if (cur && cur.length + 2 + b.length > SAFE_LIMIT) {
      out.push(cur);
      cur = b;
    } else cur = cur ? `${cur}\n\n${b}` : b;
  }
  if (cur) out.push(cur);
  return out.length > 1 ? out.map((m, i) => `${m}\n\n<i>(${i + 1}/${out.length})</i>`) : out;
}
