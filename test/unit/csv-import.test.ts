import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeBaseline } from "../../src/vmc/baseline.js";
import { parseCmcHistoryCsv } from "../../src/vmc/csv-import.js";

const NOW = new Date("2026-11-03T15:00:00Z");
const csv = readFileSync(new URL("../fixtures/cmc-history-litecoin.csv", import.meta.url), "utf8");

describe("CoinMarketCap Historical Data CSV import", () => {
  it("parses the semicolon export, keeps exact values, and skips the incomplete current day", () => {
    const r = parseCmcHistoryCsv(csv, 2, NOW);
    expect(r.rows).toHaveLength(12);
    expect(r.skippedIncomplete).toBe(1);
    expect(r.rows[0]!.dateUtc).toBe("2026-10-22");
    const nov2 = r.rows.find((x) => x.dateUtc === "2026-11-02")!;
    expect(nov2.volume!.toString()).toBe("149922575");
    expect(nov2.marketCap!.toString()).toBe("4171991578");
    expect(nov2.ratio!.toNumber()).toBeCloseTo(149922575 / 4171991578, 15);
  });

  it("produces a baseline equal to the manual mean of the transcribed daily ratios", () => {
    const r = parseCmcHistoryCsv(csv, 2, NOW);
    const manual = r.rows.reduce((s, x) => s + Number(x.volume) / Number(x.marketCap), 0) / r.rows.length;
    const b = computeBaseline(
      { start: "2026-10-22", end: "2026-11-02", expectedDays: 12 },
      r.rows.map((x, i) => ({ observationId: BigInt(i + 1), dateUtc: x.dateUtc, valid: x.valid, ratio: x.ratio, invalidReasons: x.invalidReasons })),
      { minCoverage: 1, firstHistoricalDate: null, convention: "ohlcv" },
    );
    expect(b.status).toBe("full");
    expect(b.meanRatio!.toNumber()).toBeCloseTo(manual, 14);
  });

  it("accepts a copied website table (Date, $ and thousands separators, comma-delimited)", () => {
    const table = [
      `Date,Open*,High,Low,Close**,Volume,Market Cap`,
      `"Nov 02, 2026","$55.55","$56.10","$53.59","$53.63","$149,922,575","$4,171,991,578"`,
      `"Nov 01, 2026","$55.70","$56.30","$54.99","$55.55","$126,107,226","$0"`,
    ].join("\n");
    const r = parseCmcHistoryCsv(table, 2, NOW);
    expect(r.rows.map((x) => [x.dateUtc, x.valid])).toEqual([["2026-11-01", false], ["2026-11-02", true]]);
    expect(r.rows[0]!.invalidReasons).toEqual(["market_cap_zero"]);
  });

  it("rejects files without the required columns", () => {
    expect(() => parseCmcHistoryCsv("a;b\n1;2", 2, NOW)).toThrow(/volume and marketCap/);
  });
});
