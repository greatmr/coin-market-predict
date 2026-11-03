import { describe, expect, it } from "vitest";
import { escapeHtml, formatReport, TELEGRAM_LIMIT, type ReportInput, type ReportRow } from "../../src/telegram/format.js";

const row = (i: number, over: Partial<ReportRow> = {}): ReportRow => ({
  symbol: `T${i}`,
  name: `Token <${i}> & co`,
  status: i % 2 ? "watch" : "candidate",
  signalType: "advance",
  price: 1.2345 + i,
  marketCap: 1e8 * (i + 1),
  volume24h: 1e7,
  volumeWindow: "rolling_24h",
  score: 50 + i,
  horizonHours: 24,
  entry: "Enter only if an hourly snapshot prints ≥ 1.25 before 2026-11-03T18:00:00Z",
  invalidation: "Invalidate if an hourly snapshot prints ≤ 1.16",
  exit: "Take profit at ≥ 1.43; trailing 5% after +8%; max hold 24h",
  risk: ["thin_history", "no_liquidity_data"],
  sourceUrl: `https://example.invalid/coins/t${i}?a=1&b=2`,
  observedAt: "2026-11-03T12:03:00.000Z",
  ...over,
});

const input = (rows: ReportRow[], over: Partial<ReportInput> = {}): ReportInput => ({
  generatedAt: new Date("2026-11-03T12:10:00Z"),
  slotTime: new Date("2026-11-03T12:00:00Z"),
  timezone: "Asia/Tehran",
  providerName: "Test <Provider>",
  isLive: true,
  attribution: "Data: Test",
  coverage: { label: "partial", collected: 2000, universeSize: 8049, coveragePct: 24.85, stale: 3 },
  oldestObservedAt: "2026-11-03T12:03:00.000Z",
  agentStatus: "completed",
  summary: "Two assets reviewed.",
  screened: 2000,
  eligible: 800,
  rows,
  ...over,
});

/** Every message must have balanced <pre>, <b>, <i> tags so Telegram's HTML parser accepts it. */
function balanced(msg: string) {
  for (const tag of ["pre", "b", "i"]) {
    const open = msg.split(`<${tag}>`).length - 1;
    const close = msg.split(`</${tag}>`).length - 1;
    if (open !== close) return false;
  }
  return true;
}

describe("Telegram report formatting", () => {
  it("escapes untrusted text for HTML parse mode", () => {
    expect(escapeHtml("<script>&")).toBe("&lt;script&gt;&amp;");
    const [msg] = formatReport(input([row(1)]));
    expect(msg).toContain("Token &lt;1&gt; &amp; co");
    expect(msg).toContain("a=1&amp;b=2");
    expect(msg).not.toContain("<script>");
  });

  it("includes report time, freshness, coverage, source references and the research note", () => {
    const [msg] = formatReport(input([row(1)]));
    expect(msg).toMatch(/Report: 2026-11-03 15:40/);
    expect(msg).toMatch(/Coverage: partial — 2000\/8049 assets \(24\.9%\), stale 3/);
    expect(msg).toMatch(/Freshness: oldest cited observation/);
    expect(msg).toMatch(/Source: https:\/\/example\.invalid/);
    expect(msg).toMatch(/not financial advice/);
    expect(msg).toMatch(/Vol24h = provider rolling 24h volume/);
  });

  it("publishes an honest no-signal report", () => {
    const parts = formatReport(input([]));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatch(/No qualifying signals this hour/);
  });

  it("labels fixture data loudly", () => {
    expect(formatReport(input([], { isLive: false }))[0]).toMatch(/FIXTURE \/ SYNTHETIC DATA/);
  });

  it("splits long reports under the Telegram limit without breaking tags", () => {
    const parts = formatReport(input(Array.from({ length: 25 }, (_, i) => row(i))));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
      expect(balanced(p)).toBe(true);
    }
    expect(parts.at(-1)).toMatch(new RegExp(`\\(${parts.length}/${parts.length}\\)`));
  });

  it("renders a fixed-width table with the required columns", () => {
    const [msg] = formatReport(input([row(1)]));
    const pre = /<pre>([\s\S]*?)<\/pre>/.exec(msg!)![1]!;
    const lines = pre.split("\n");
    expect(lines[0]).toMatch(/Token +Price +MCap +Vol24h +Scr +Hz +St/);
    expect(new Set(lines.map((l) => l.trimEnd().length)).size).toBeLessThanOrEqual(2);
  });

  it("labels detection of a move already underway", () => {
    expect(formatReport(input([row(1, { signalType: "move_underway" })]))[0]).toMatch(/move already underway \(detection\)/);
  });
});
