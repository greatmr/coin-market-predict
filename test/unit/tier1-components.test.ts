import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { csvField, toCsv } from "../../src/common/csv.js";
import { buildXlsx, columnName } from "../../src/common/xlsx.js";
import { rankContinuity } from "../../src/ingestion/ingestion.service.js";
import { dec } from "../../src/common/decimal.js";
import { parseCmcHistoryCsv } from "../../src/tier1/csv-import.js";
import { dailyRatio } from "../../src/tier1/vmc.js";
import { buildLbankContext, resolveLbank, type VenueDecisionView, type VenuePair } from "../../src/tier1/lbank.js";
import { parseOverrides } from "../../src/tier1/overrides.js";
import { blockingErrors, ReviewSchema, validateReview } from "../../src/tier1/review-rules.js";
import { venueSummary } from "../../src/tier1/venues.js";

const AS_OF = new Date("2026-11-05T07:07:00Z");
const MAX = 120 * 60_000;
const pair = (base: string, id: number | null, quote = "USDT", trading: string | null = null): VenuePair => ({
  exchange: "lbank", exchangeName: "LBank", marketPair: `${base}/${quote}`, category: "spot", baseSymbol: base, baseCurrencyId: id, quoteSymbol: quote, quoteCurrencyId: 825,
  volumeUsd: "1000", volumePercent: null, priceUsd: null, lastUpdated: AS_OF.toISOString(), marketUrl: null, tradingStatus: trading, type: "cex", flags: [],
});
const crawl = (pairs: VenuePair[], status: "COMPLETE" | "INCOMPLETE" | "FAILED" = "COMPLETE", finishedAt = new Date(AS_OF.getTime() + 5_000)) => ({ id: "c1", status, finishedAt, pairs });
const noHistory = { lastAbsentAt: new Map<string, Date>(), everListed: new Set<string>() };
const decision = (marketPair: string | null, kind: VenueDecisionView["decision"], at: Date): VenueDecisionView => ({ id: `${kind}-${marketPair}`, marketPair, decision: kind, decidedAt: at, reviewer: "t", source: "review" });

describe("LBank pair status (p.9, p.10)", () => {
  it("feed without trading status → PAIR_LISTED_UNVERIFIED; feed proof → VERIFIED; all quote currencies kept", () => {
    const ctx = buildLbankContext(crawl([pair("ABC", 7), pair("ABC", 7, "BTC")]), AS_OF, MAX);
    const r = resolveLbank(7, "ABC", ctx, [], noHistory);
    expect([r.status, r.reason]).toEqual(["PAIR_LISTED_UNVERIFIED", "NO_TRADING_STATUS_PROOF"]);
    expect(r.pairs.map((p) => p.marketPair)).toEqual(["ABC/USDT", "ABC/BTC"]);
    const proven = resolveLbank(7, "ABC", buildLbankContext(crawl([pair("ABC", 7, "USDT", "TRADING")]), AS_OF, MAX), [], noHistory);
    expect(proven.status).toBe("VERIFIED");
  });

  it("missing, incomplete, failed or stale crawls → UNKNOWN, never silently eligible", () => {
    expect(resolveLbank(7, "ABC", buildLbankContext(null, AS_OF, MAX), [], noHistory).reason).toBe("LBANK_FEED_MISSING");
    expect(resolveLbank(7, "ABC", buildLbankContext(crawl([pair("ABC", 7)], "INCOMPLETE"), AS_OF, MAX), [], noHistory).reason).toBe("LBANK_FEED_INCOMPLETE");
    expect(resolveLbank(7, "ABC", buildLbankContext(crawl([pair("ABC", 7)], "FAILED"), AS_OF, MAX), [], noHistory).reason).toBe("LBANK_FEED_FAILED");
    const old = crawl([pair("ABC", 7)], "COMPLETE", new Date(AS_OF.getTime() - MAX - 1));
    expect(resolveLbank(7, "ABC", buildLbankContext(old, AS_OF, MAX), [], noHistory)).toMatchObject({ status: "UNKNOWN", reason: "LBANK_FEED_STALE" });
  });

  it("an ambiguous base ticker is never guessed: UNKNOWN plus a mapping-evidence task until a reviewer decides", () => {
    const ctx = buildLbankContext(crawl([pair("ABCX", 7, "USDT", "TRADING"), pair("DUP", 8), pair("DUP", 9, "BTC")]), AS_OF, MAX);
    const mismatch = resolveLbank(7, "ABC", ctx, [], noHistory);
    expect([mismatch.status, mismatch.reason]).toEqual(["UNKNOWN", "AMBIGUOUS_MAPPING"]);
    expect(mismatch.tasks.map((t) => t.kind)).toEqual(["SYMBOL_MISMATCH"]);
    expect(resolveLbank(8, "DUP", ctx, [], noHistory).tasks.map((t) => t.kind)).toEqual(["TICKER_MULTIPLE_IDS"]);
    const confirmed = resolveLbank(7, "ABC", ctx, [decision("ABCX/USDT", "MAPPING_CONFIRMED", AS_OF)], noHistory);
    expect([confirmed.status, confirmed.tasks.length]).toEqual(["VERIFIED", 0]);
    const rejected = resolveLbank(7, "ABC", ctx, [decision("ABCX/USDT", "MAPPING_REJECTED", AS_OF)], noHistory);
    expect(rejected.status).toBe("NOT_LISTED");
  });

  it("a reviewer verification counts until the pair disappears; a disappeared pair is UNKNOWN until reverified (A9)", () => {
    const ctx = buildLbankContext(crawl([pair("ABC", 7)]), AS_OF, MAX);
    const verifiedAt = new Date("2026-11-01T00:00:00Z");
    expect(resolveLbank(7, "ABC", ctx, [decision("ABC/USDT", "VERIFIED_TRADABLE", verifiedAt)], noHistory).status).toBe("VERIFIED");
    const absentLater = { lastAbsentAt: new Map([["ABC/USDT", new Date("2026-11-02T00:00:00Z")]]), everListed: new Set(["ABC/USDT"]) };
    const voided = resolveLbank(7, "ABC", ctx, [decision("ABC/USDT", "VERIFIED_TRADABLE", verifiedAt)], absentLater);
    expect(voided.status).toBe("PAIR_LISTED_UNVERIFIED");
    expect(voided.pairs[0]!.evidence.join(" ")).toMatch(/voided/);
    const gone = resolveLbank(7, "ABC", buildLbankContext(crawl([]), AS_OF, MAX), [], { lastAbsentAt: new Map(), everListed: new Set(["ABC/USDT"]) });
    expect([gone.status, gone.reason]).toEqual(["UNKNOWN", "PAIR_DISAPPEARED"]);
    const confirmedGone = resolveLbank(7, "ABC", buildLbankContext(crawl([]), AS_OF, MAX), [decision(null, "NOT_TRADABLE", AS_OF)], { lastAbsentAt: new Map(), everListed: new Set(["ABC/USDT"]) });
    expect(confirmedGone.status).toBe("NOT_TRADABLE");
    expect(resolveLbank(7, "ABC", buildLbankContext(crawl([]), AS_OF, MAX), [], noHistory).status).toBe("NOT_LISTED");
  });

  it("a reviewer's NOT_TRADABLE wins over feed proof", () => {
    const ctx = buildLbankContext(crawl([pair("ABC", 7, "USDT", "TRADING")]), AS_OF, MAX);
    expect(resolveLbank(7, "ABC", ctx, [decision("ABC/USDT", "NOT_TRADABLE", AS_OF)], noHistory).status).toBe("NOT_TRADABLE");
  });
});

describe("LBank Spot markets list as the source (operator decisions D1, D2)", () => {
  const DAYS_35 = 35 * 86_400_000;
  const listed = (pairs: VenuePair[], finishedAt = new Date(AS_OF.getTime() - 20 * 86_400_000)) => buildLbankContext(crawl(pairs, "COMPLETE", finishedAt), AS_OF, DAYS_35, { listingIsTradable: true });

  it("a listed, unambiguous pair counts as tradable without a separate check; the evidence says so", () => {
    const r = resolveLbank(7, "ABC", listed([pair("ABC", 7)]), [], noHistory);
    expect([r.status, r.pairs[0]!.trading, r.pairs[0]!.tradingSource]).toEqual(["VERIFIED", "TRADING", "listing"]);
    expect(r.pairs[0]!.evidence.join(" ")).toMatch(/listed in CMC's LBank Spot markets/);
  });

  it("a reviewer's NOT_TRADABLE still wins, ambiguous tickers still need a decision, unlisted coins stay NOT_LISTED", () => {
    expect(resolveLbank(7, "ABC", listed([pair("ABC", 7)]), [decision("ABC/USDT", "NOT_TRADABLE", AS_OF)], noHistory).status).toBe("NOT_TRADABLE");
    const amb = resolveLbank(7, "ABC", listed([pair("ABCX", 7)]), [], noHistory);
    expect([amb.status, amb.reason, amb.tasks.length]).toEqual(["UNKNOWN", "AMBIGUOUS_MAPPING", 1]);
    expect(resolveLbank(8, "XYZ", listed([pair("ABC", 7)]), [], noHistory).status).toBe("NOT_LISTED");
  });

  it("a monthly list stays usable for the configured max age, then becomes stale (UNKNOWN)", () => {
    expect(resolveLbank(7, "ABC", listed([pair("ABC", 7)], new Date(AS_OF.getTime() - DAYS_35 + 60_000)), [], noHistory).status).toBe("VERIFIED");
    expect(resolveLbank(7, "ABC", listed([pair("ABC", 7)], new Date(AS_OF.getTime() - DAYS_35 - 60_000)), [], noHistory)).toMatchObject({ status: "UNKNOWN", reason: "LBANK_FEED_STALE" });
  });
});

describe("venue concentration (p.15): facts and flags, no cutoff, never auto-rejected", () => {
  const markets = (rows: Array<[string, string, string]>, status: "COMPLETE" | "INCOMPLETE" = "COMPLETE", expected: number | null = rows.length) => ({
    id: "m1", status, finishedAt: AS_OF, expectedCount: expected, fetchedCount: rows.length,
    pairs: rows.map(([exchange, vol, pct]) => ({ ...pair("ABC", 7), exchange, exchangeName: exchange, volumeUsd: vol, volumePercent: pct })),
  });
  it("flags Upbit as the top venue and a single venue; missing data stays pending", () => {
    const up = venueSummary(7, markets([["upbit", "700", "70"], ["binance", "200", "20"], ["upbit", "100", "10"]]), AS_OF, 48 * 3_600_000);
    expect(up.flags).toEqual(["UPBIT_TOP_VENUE"]);
    expect(up.exchanges[0]).toMatchObject({ exchange: "upbit", pairs: 2, volumeUsd: "800", volumePercent: "80" });
    expect(venueSummary(7, markets([["lbank", "100", "100"]]), AS_OF, 48 * 3_600_000).flags).toEqual(["SINGLE_VENUE"]);
    expect(venueSummary(7, null, AS_OF, 1).flags).toEqual(["VENUE_DATA_PENDING"]);
    const partial = venueSummary(7, markets([["lbank", "100", "10"]], "INCOMPLETE", 50), AS_OF, 48 * 3_600_000);
    expect(partial.flags).toEqual(["VENUE_DATA_INCOMPLETE"]);
    expect(partial.flags).not.toContain("SINGLE_VENUE");
    expect(venueSummary(7, markets([["lbank", "1", "1"]]), new Date(AS_OF.getTime() + 49 * 3_600_000), 48 * 3_600_000).dataStatus).toBe("STALE");
  });
});

describe("Tier 2 review record and trade plan (p.24–27)", () => {
  const base = { cmcId: 7, batchId: "8f0d3c2e-7a35-4c62-9a4b-0c1d2e3f4a5b", reviewer: "trader" };
  const ctx = { symbol: "ABC", verifiedLbankPairs: ["ABC/USDT"], listedLbankPairs: ["ABC/USDT", "ABC/BTC"] };
  const plan = { entryPrice: "2.00", entryTime: "2026-11-05T00:00:00Z", stopPrice: "1.72", targets: [{ price: "2.3", allocationPct: "50" }, { price: "2.6", allocationPct: "30" }, { price: "3", allocationPct: "20" }], notes: "manual plan" };
  const v = (o: Record<string, unknown>) => validateReview(ReviewSchema.parse({ ...base, ...o }), ctx);

  it("PLAN_READY with every field and valid ordering is COMPLETE with derived stop % and 7 × 24 h deadline", () => {
    const r = v({ finalDecision: "PLAN_READY", lbankPair: "ABC/USDT", eventDay: "SECOND", candleState: "PRE_MOVE", plan });
    expect(r.errors).toEqual([]);
    expect(r.planStatus).toBe("COMPLETE");
    expect(r.plan).toMatchObject({ stopPct: "14", deadline: "2026-11-12T00:00:00.000Z" });
  });
  it("missing plan fields or wrong ordering keep the plan INCOMPLETE", () => {
    expect(v({ finalDecision: "PLAN_READY", lbankPair: "ABC/USDT", plan: { ...plan, notes: undefined, targets: plan.targets.slice(0, 2) } }).errors).toEqual(expect.arrayContaining(["plan: TP3 price is required (> 0)", "plan: plan notes are required"]));
    const order = v({ finalDecision: "PLAN_READY", lbankPair: "ABC/USDT", plan: { ...plan, stopPrice: "2.10", targets: [{ price: "1.9", allocationPct: "50" }, { price: "2.6", allocationPct: "30" }, { price: "2.5", allocationPct: "20" }] } });
    expect(order.planStatus).toBe("INCOMPLETE");
    expect(order.errors).toEqual(expect.arrayContaining(["plan: stop must be below entry (long spot plan)", "plan: TP1 must be above entry", "plan: TP3 must be above TP2"]));
    expect(v({ finalDecision: "PLAN_READY", lbankPair: "ABC/USDT", plan: { ...plan, targets: [{ price: "2.3", allocationPct: "60" }, { price: "2.6", allocationPct: "30" }, { price: "3", allocationPct: "20" }] } }).errors.join(" ")).toMatch(/110 %/);
    expect(v({ finalDecision: "PLAN_READY", lbankPair: "ABC/BTC", plan }).errors.join(" ")).toMatch(/not verified tradable/);
    expect(v({ finalDecision: "PLAN_READY", plan }).errors.join(" ")).toMatch(/confirm the actual LBank Spot pair/);
  });
  it("a later or uncertain event needs an explicit disposition; uncertain judgments are recorded, not blocked", () => {
    expect(v({ finalDecision: "PLAN_READY", lbankPair: "ABC/USDT", eventDay: "LATER", plan }).errors.join(" ")).toMatch(/explicit disposition/);
    const ok = v({ finalDecision: "PLAN_READY", lbankPair: "ABC/USDT", eventDay: "LATER", rationale: "accepting a third-day entry: volume still building", rangeLow: "UNCERTAIN", plan });
    expect(ok.planStatus).toBe("COMPLETE");
    expect(ok.warnings.join(" ")).toMatch(/range-low judgment marked UNCERTAIN/);
  });
  it("NO_TRADE needs a rationale; a proxy chart needs a reason and a timezone; ticker look-alikes warn", () => {
    expect(blockingErrors(v({ finalDecision: "NO_TRADE" }))).toEqual(["NO_TRADE needs a rationale"]);
    expect(blockingErrors(v({ chartExchange: "Binance", chartUrl: "https://x.test/c" }))).toEqual(["record the chart's daily candle-close timezone with the chart URL", "a non-LBank chart is a proxy: record the reason"]);
    expect(v({ chartSymbol: "XYZUSDT" }).warnings.join(" ")).toMatch(/not a ticker match/);
    expect(() => ReviewSchema.parse({ ...base, chartUrl: "javascript:alert(1)" })).toThrow();
    expect(() => ReviewSchema.parse({ ...base, finalDecision: "BUY" })).toThrow();
  });
  it("records the time exit: an exit after the deadline is flagged", () => {
    const r = v({ finalDecision: "PLAN_READY", lbankPair: "ABC/USDT", plan: { ...plan, execution: { exitTime: "2026-11-13T00:00:00Z", exitReason: "time exit", tpFilled: [true, false, false] } } });
    expect(r.warnings.join(" ")).toMatch(/after the 7 × 24 h time exit/);
  });
});

describe("versioned override list (p.9, p.18)", () => {
  const text = JSON.stringify({ version: "v7", updatedAt: "2026-11-05T00:00:00.000Z", classOverrides: [{ cmcId: 7, class: "eligible", reason: "governance token, not wrapped", addedBy: "op", addedAt: "2026-11-05" }], lbankMappingOverrides: [{ cmcId: 8, marketPair: "ABCX/USDT", decision: "MAPPING_CONFIRMED", reason: "same contract", addedBy: "op", addedAt: "2026-11-05" }] });
  it("parses, versions and applies entries; rejects unknown fields", () => {
    const o = parseOverrides(text);
    expect(o.version).toBe("v7");
    expect(o.classFor("fixture", 7)).toEqual({ class: "eligible", reason: "governance token, not wrapped", version: "v7" });
    expect(o.lbankDecisionsFor("fixture", 8)[0]).toMatchObject({ marketPair: "ABCX/USDT", decision: "MAPPING_CONFIRMED", source: "overrides_file" });
    expect(() => parseOverrides(JSON.stringify({ version: "x", updatedAt: "2026-11-05T00:00:00.000Z", extra: 1 }))).toThrow(/invalid overrides/);
  });
});

describe("export writers", () => {
  it("CSV quotes per RFC 4180 and leaves N/A numerics blank", () => {
    expect(csvField('a,"b"')).toBe('"a,""b"""');
    expect(csvField(null)).toBe("");
    expect(toCsv(["a", "b"], [["x", null], [1.5, "y\nz"]])).toBe('a,b\r\nx,\r\n1.5,"y\nz"\r\n');
  });
  it("builds a deterministic XLSX zip whose sheets and cells can be read back", () => {
    const sheets = [{ name: "All_Eligible", rows: [["cmc_id", "symbol", "multiple_3d"], [990001, "A&B <x>", 2], [990002, "C", null]] }, { name: "Run_Metadata", rows: [["key", "value"], ["data_label", "SYNTHETIC"]] }];
    const a = buildXlsx(sheets);
    expect(a.equals(buildXlsx(sheets))).toBe(true);
    const entries = unzip(a);
    expect(Object.keys(entries)).toEqual(expect.arrayContaining(["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/styles.xml"]));
    expect(entries["xl/workbook.xml"]).toContain('<sheet name="All_Eligible" sheetId="1" r:id="rId1"/>');
    expect(entries["xl/worksheets/sheet1.xml"]).toContain('<c r="A2"><v>990001</v></c>');
    expect(entries["xl/worksheets/sheet1.xml"]).toContain("A&amp;B &lt;x&gt;");
    expect(entries["xl/worksheets/sheet1.xml"]).not.toContain('r="C3"');
    expect(columnName(0)).toBe("A");
    expect(columnName(27)).toBe("AB");
    expect(() => buildXlsx([{ name: "bad/name", rows: [] }])).toThrow();
  });
});

describe("rank continuity (A12)", () => {
  it("lists missing and duplicate ranks within 1–1200", () => {
    const ranks = Array.from({ length: 1200 }, (_, i) => ({ rank: i + 1, n: 1 })).filter((r) => r.rank !== 500);
    ranks.push({ rank: 7, n: 2 } as never);
    expect(rankContinuity(ranks.filter((r, i, a) => a.findIndex((x) => x.rank === r.rank) === i).map((r) => (r.rank === 7 ? { rank: 7, n: 2 } : r)))).toEqual({ missing: [500], duplicates: [7] });
  });
});

describe("manual CMC history CSV import (daily:import-csv)", () => {
  it("keeps exact digits, skips the open UTC day and orders completed days ascending", () => {
    const text = readFileSync(new URL("../fixtures/cmc-history-litecoin.csv", import.meta.url), "utf8");
    const r = parseCmcHistoryCsv(text, 2, new Date("2026-11-03T16:00:00Z"));
    expect(r.skippedIncomplete).toBe(1); // 2026-11-03 is the current, open day
    expect(r.skippedUnparseable).toBe(0);
    expect(r.rows).toHaveLength(12);
    expect(r.rows[0]!.dateUtc).toBe("2026-10-22");
    const last = r.rows.at(-1)!;
    expect(last).toMatchObject({ cmcId: 2, dateUtc: "2026-11-02", volume: "149922575", marketCap: "4171991578", close: "53.63", invalidReasons: [] });
    expect(last.periodEnd?.toISOString()).toBe("2026-11-02T23:59:59.999Z");
    // Same formula as the website rows: that day's volume ÷ that day's market cap.
    expect(dailyRatio(dec(last.volume), dec(last.marketCap)).ratio!.toFixed(12)).toBe("0.035935493204");
  });

  it("tolerates comma exports with month-name dates and $ thousands separators; flags non-numeric cells", () => {
    const text = 'Date,Open,High,Low,Close,Volume,"Market Cap"\n"Nov 02, 2026","$55.55","$56.10","$53.59","$53.63","$149,922,575","$4,171,991,578"\n"Nov 01, 2026",1,1,1,1,n/a,"4,320,624,915"\nnot a date,1,1,1,1,1,1\n';
    const r = parseCmcHistoryCsv(text, 2, new Date("2026-11-03T00:00:00Z"));
    expect(r.skippedUnparseable).toBe(1);
    expect(r.rows.map((x) => x.dateUtc)).toEqual(["2026-11-01", "2026-11-02"]);
    expect(r.rows[1]).toMatchObject({ volume: "149922575", marketCap: "4171991578", invalidReasons: [] });
    expect(r.rows[0]).toMatchObject({ volume: null, invalidReasons: ["volume_not_numeric"] });
    expect(() => parseCmcHistoryCsv("a;b\n1;2", 2, new Date())).toThrow(/volume and marketCap/);
  });
});

/** Minimal ZIP reader for the test (local headers; deflate). */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const method = buf.readUInt16LE(o + 8), csize = buf.readUInt32LE(o + 18), nameLen = buf.readUInt16LE(o + 26), extra = buf.readUInt16LE(o + 28);
    const name = buf.subarray(o + 30, o + 30 + nameLen).toString("utf8");
    const data = buf.subarray(o + 30 + nameLen + extra, o + 30 + nameLen + extra + csize);
    out[name] = (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    o += 30 + nameLen + extra + csize;
  }
  return out;
}
