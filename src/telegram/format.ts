import { formatInZone } from "../common/time.js";
import { fmt } from "../screening/scenario.js";

export const TELEGRAM_LIMIT = 4096;
const SAFE_LIMIT = 3900;

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

export function compactUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "n/a";
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s);

const STATUS_CODE: Record<string, string> = { candidate: "CAND", watch: "WATCH", insufficient_data: "DATA?", no_signal: "-" };

export const RESEARCH_NOTE =
  "Research hypotheses only — not financial advice, no orders are placed. Hourly snapshots cannot see intrahour moves; entries, stops and targets are evaluated only at hourly observations. Scores are heuristics, not probabilities.";

/** Build Telegram HTML messages (each ≤ 4096 chars), splitting only at block boundaries. */
export function formatReport(r: ReportInput): string[] {
  const header: string[] = [
    `<b>Coins Predicts — hourly research report</b>`,
    `Report: ${escapeHtml(formatInZone(r.generatedAt, r.timezone))} (slot ${escapeHtml(r.slotTime.toISOString().slice(0, 16))}Z)`,
    `Source: ${escapeHtml(r.providerName)}${r.isLive ? "" : " — <b>FIXTURE / SYNTHETIC DATA, not market data</b>"}`,
    `Coverage: ${escapeHtml(r.coverage.label)} — ${r.coverage.collected}${r.coverage.universeSize ? `/${r.coverage.universeSize}` : ""} assets${r.coverage.coveragePct !== null ? ` (${r.coverage.coveragePct.toFixed(1)}%)` : ""}, stale ${r.coverage.stale}`,
    `Freshness: oldest cited observation ${r.oldestObservedAt ? escapeHtml(r.oldestObservedAt.slice(0, 16)) + "Z" : "n/a"}`,
    `Agent review: ${escapeHtml(r.agentStatus)} · screened ${r.screened}, eligible ${r.eligible}`,
  ];
  if (r.summary) header.push(`<i>${escapeHtml(r.summary)}</i>`);

  const blocks: string[] = [header.join("\n")];

  if (r.rows.length === 0) {
    blocks.push(`<b>No qualifying signals this hour.</b> Nothing passed screening and review; that is a normal outcome.`);
  } else {
    const head = `${pad("#", 2)} ${pad("Token", 6)} ${lpad("Price", 9)} ${lpad("MCap", 7)} ${lpad("Vol24h", 7)} ${lpad("Scr", 3)} ${lpad("Hz", 3)} ${pad("St", 5)}`;
    const lines = r.rows.map(
      (x, i) =>
        `${pad(String(i + 1), 2)} ${pad(x.symbol, 6)} ${lpad(x.price === null ? "n/a" : fmt(x.price), 9)} ${lpad(compactUsd(x.marketCap), 7)} ${lpad(compactUsd(x.volume24h), 7)} ${lpad(String(Math.round(x.score)), 3)} ${lpad(`${x.horizonHours}h`, 3)} ${pad(STATUS_CODE[x.status] ?? x.status, 5)}`,
    );
    for (let i = 0; i < lines.length; i += 20) blocks.push(`<pre>${escapeHtml([head, ...lines.slice(i, i + 20)].join("\n"))}</pre>`);
    blocks.push(`<i>Vol24h = provider rolling 24h volume (USD), not hourly volume. St: CAND=candidate, WATCH=watch.</i>`);
    r.rows.forEach((x, i) => {
      const kind = x.signalType === "move_underway" ? "move already underway (detection)" : x.signalType === "advance" ? "advance hypothesis" : "unclassified";
      blocks.push(
        [
          `<b>${i + 1}. ${escapeHtml(x.symbol)}</b> — ${escapeHtml(x.name)} · ${escapeHtml(x.status)} · ${escapeHtml(kind)}`,
          `Entry: ${escapeHtml(x.entry)}`,
          `Invalidation: ${escapeHtml(x.invalidation)}`,
          `Exit: ${escapeHtml(x.exit)}`,
          `Risk: ${escapeHtml(x.risk.length ? x.risk.slice(0, 5).join(", ") : "none flagged")}`,
          `Source: ${escapeHtml(x.sourceUrl)} · observed ${x.observedAt ? escapeHtml(x.observedAt.slice(0, 16)) + "Z" : "n/a"}`,
        ].join("\n"),
      );
    });
  }
  if (r.attribution) blocks.push(escapeHtml(r.attribution));
  blocks.push(`<i>${escapeHtml(RESEARCH_NOTE)}</i>`);
  return pack(blocks);
}

function pack(blocks: string[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const b of blocks) {
    const block = b.length > SAFE_LIMIT ? truncateBlock(b) : b;
    if (cur && cur.length + 2 + block.length > SAFE_LIMIT) {
      out.push(cur);
      cur = block;
    } else cur = cur ? `${cur}\n\n${block}` : block;
  }
  if (cur) out.push(cur);
  if (out.length > 1) return out.map((m, i) => `${m}\n\n<i>(${i + 1}/${out.length})</i>`);
  return out;
}

/** A single block should never exceed the limit; if one does, cut it on a line boundary. */
function truncateBlock(b: string): string {
  const isPre = b.startsWith("<pre>");
  const inner = isPre ? b.slice(5, -6) : b;
  const lines = inner.split("\n");
  let acc = "";
  for (const l of lines) {
    if (acc.length + l.length + 40 > SAFE_LIMIT) break;
    acc = acc ? `${acc}\n${l}` : l;
  }
  return isPre ? `<pre>${acc}\n…</pre>` : `${acc}\n…`;
}
