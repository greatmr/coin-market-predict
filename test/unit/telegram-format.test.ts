import { describe, expect, it } from "vitest";
import { compactUsd, escapeHtml, formatReport, riskText, TELEGRAM_LIMIT, usdPrice, type ReportInput, type ReportRow } from "../../src/telegram/format.js";

const row = (i: number, over: Partial<ReportRow> = {}): ReportRow => ({
  symbol: `T${i}`,
  name: `Token <${i}> & co`,
  status: i % 2 ? "watch" : "candidate",
  signalType: "advance",
  price: 1.2345 + i,
  marketCap: 1e8 * (i + 1),
  volume24h: 1.2e7,
  volumeWindow: "rolling_24h",
  score: 50 + i,
  horizonHours: 24,
  entry: "Enter only if an hourly snapshot prints ≥ 1.25",
  invalidation: "Invalidate if an hourly snapshot prints ≤ 1.16",
  exit: "Take profit at ≥ 1.43",
  risk: ["thin_history", "no_liquidity_data"],
  sourceUrl: `https://example.invalid/coins/t${i}?a=1&b=2`,
  observedAt: "2026-11-03T12:03:00.000Z",
  scenario: { entryPrice: 1.25, stopPrice: 1.1625, targetPrice: 1.4375, trailPct: 0.05, trailActivatePct: 0.08, maxHoldHours: 24, expiresAt: "2026-11-03T18:00:00.000Z" },
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

function balanced(msg: string) {
  for (const tag of ["pre", "b", "i"]) if (msg.split(`<${tag}>`).length !== msg.split(`</${tag}>`).length) return false;
  return true;
}

/** Visible text width per line once HTML tags are removed. */
const visibleLines = (m: string) => m.replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt);/g, "x").split("\n");

describe("Telegram report formatting (mobile)", () => {
  it("escapes untrusted text for HTML parse mode", () => {
    expect(escapeHtml("<script>&")).toBe("&lt;script&gt;&amp;");
    const [msg] = formatReport(input([row(1)]));
    expect(msg).toContain("Token &lt;1&gt; &amp; co");
    expect(msg).not.toContain("<script>");
  });

  it("puts local time first and shows coverage, freshness context and a short research note", () => {
    const [msg] = formatReport(input([row(1)]));
    expect(msg).toMatch(/🕒 15:40 IRST · data hour 12:00 UTC/);
    expect(msg).toMatch(/2000\/8049 coins checked \(partial, 3 stale\) · 800 eligible/);
    expect(msg).toMatch(/Research only, not financial advice/);
  });

  it("renders each token as a short card with every required field", () => {
    const [msg] = formatReport(input([row(0)]));
    for (const re of [/<b>1\. T0<\/b>/, /🟢 Candidate · early move/, /💵 \$1\.23 {2}· {2}Cap \$100\.0M/, /Vol 24h \$12\.0M/, /Score 50\/100/, /Enter if ≥ \$1\.25 by 21:30/, /Stop if ≤ \$1\.16/, /Target \$1\.44 · trail 5\.0% after \+8\.0%/, /Max hold 24h/, /short history, no liquidity data/]) {
      expect(msg).toMatch(re);
    }
  });

  it("keeps lines short enough for a phone (no wide tables)", () => {
    for (const m of formatReport(input(Array.from({ length: 6 }, (_, i) => row(i))))) {
      expect(m).not.toContain("<pre>");
      for (const line of visibleLines(m)) expect([...line].length).toBeLessThanOrEqual(64);
    }
  });

  it("publishes an honest no-signal report and labels test data", () => {
    const parts = formatReport(input([], { isLive: false }));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatch(/No qualifying signals this hour/);
    expect(parts[0]).toMatch(/TEST DATA/);
  });

  it("splits long reports under the Telegram limit without breaking tags", () => {
    const parts = formatReport(input(Array.from({ length: 30 }, (_, i) => row(i))));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
      expect(balanced(p)).toBe(true);
    }
  });

  it("labels moves already underway and humanizes values", () => {
    expect(formatReport(input([row(1, { signalType: "move_underway" })]))[0]).toMatch(/move already underway/);
    expect(usdPrice(100123.4)).toBe("$100,123");
    expect(usdPrice(0.000012345)).toBe("$0.0000123");
    expect(compactUsd(1.55e12)).toBe("$1.55T");
    expect(riskText(["volume_exceeds_market_cap"])).toBe("volume > market cap");
    expect(riskText([])).toBe("none flagged");
  });
});
