import { describe, expect, it } from "vitest";
import { computeBaseline, type DailyInput } from "../../src/vmc/baseline.js";
import { CmcApiError, CmcClient, type RawRecord } from "../../src/vmc/cmc-client.js";
import { parseDailyEodQuotes, parseDailyOhlcv, parseHourlyHistorical, parseLatestQuotes, validatePair } from "../../src/vmc/cmc-parse.js";
import { analyzeWindow, buildRow, type ComparisonInput } from "../../src/vmc/comparison.js";
import { Decimal, parseExactJson } from "../../src/vmc/decimal.js";
import { addCalendarMonths, baselineWindow, eachDay } from "../../src/vmc/window.js";

const d = (s: string) => new Decimal(s);
const input = (dateUtc: string, ratio: string | null, valid = true, id = 1n): DailyInput => ({ observationId: id, dateUtc, valid, ratio: ratio === null ? null : d(ratio), invalidReasons: valid ? [] : ["market_cap_zero"] });

describe("six-calendar-month window over completed UTC days", () => {
  it("ends at the latest completed UTC day and starts six calendar months earlier + 1 day", () => {
    expect(baselineWindow(new Date("2026-11-03T10:00:00Z"), 6)).toEqual({ start: "2026-05-03", end: "2026-11-02", expectedDays: 184 });
  });
  it("excludes the current (incomplete) UTC day even just after midnight", () => {
    expect(baselineWindow(new Date("2026-11-03T00:00:00Z"), 6).end).toBe("2026-11-02");
    expect(baselineWindow(new Date("2026-11-02T23:59:59Z"), 6).end).toBe("2026-11-01");
  });
  it("clamps month ends, including leap years", () => {
    expect(addCalendarMonths("2026-08-31", -6)).toBe("2026-02-28");
    expect(baselineWindow(new Date("2026-09-01T05:00:00Z"), 6)).toMatchObject({ start: "2026-03-01", end: "2026-08-31" });
    expect(addCalendarMonths("2028-08-31", -6)).toBe("2028-02-29");
  });
});

describe("daily ratio validation (PDF p.7)", () => {
  it("matches a manual calculation of the PDF p.4 Litecoin row (Nov 02, 2026)", () => {
    const p = validatePair("149922575", "4171991578");
    expect(p.valid).toBe(true);
    expect(p.ratio!.toNumber()).toBeCloseTo(0.035935493204392085, 15);
    expect(p.ratio!.decimalPlaces()).toBeLessThanOrEqual(18);
  });
  it("treats zero volume as a valid zero ratio", () => {
    expect(validatePair("0", "1000").ratio!.toString()).toBe("0");
  });
  it("rejects zero/negative market cap and missing, non-finite or negative values", () => {
    expect(validatePair("10", "0").invalidReasons).toEqual(["market_cap_zero"]);
    expect(validatePair("10", "-5").invalidReasons).toEqual(["market_cap_negative"]);
    expect(validatePair(null, "100").invalidReasons).toEqual(["volume_missing"]);
    expect(validatePair("Infinity", "100").invalidReasons).toEqual(["volume_not_finite"]);
    expect(validatePair("-1", "100").invalidReasons).toEqual(["volume_negative"]);
    expect(validatePair("10", undefined).valid).toBe(false);
  });
  it("keeps exact source digits through JSON parsing", () => {
    const body = parseExactJson('{"v":149922575.123456789012345,"m":4171991578}') as { v: string };
    expect(body.v).toBe("149922575.123456789012345");
  });
});

describe("baseline = arithmetic mean of daily ratios", () => {
  const win = { start: "2026-01-01", end: "2026-01-02", expectedDays: 2 };
  it("is the mean of ratios, not total volume / total market cap or mean vol / mean cap", () => {
    // day 1: 1 / 100 = 0.01 ; day 2: 100 / 1000 = 0.1
    const r = computeBaseline(win, [input("2026-01-01", validatePair("1", "100").ratio!.toString(), true, 1n), input("2026-01-02", validatePair("100", "1000").ratio!.toString(), true, 2n)], { minCoverage: 0.95, firstHistoricalDate: null, convention: "eod_quote" });
    expect(r.meanRatio!.toString()).toBe("0.055");
    expect(r.meanRatio!.toNumber()).not.toBeCloseTo(101 / 1100, 3); // ratio of aggregates
    expect(r.status).toBe("full");
  });
  it("matches the PDF p.4 Litecoin rows (mean of the two daily ratios)", () => {
    const r1 = validatePair("149922575", "4171991578").ratio!;
    const r2 = validatePair("126107226", "4320624915").ratio!;
    const r = computeBaseline({ start: "2026-11-01", end: "2026-11-02", expectedDays: 2 }, [input("2026-11-01", r2.toString(), true, 1n), input("2026-11-02", r1.toString(), true, 2n)], { minCoverage: 1, firstHistoricalDate: null, convention: "ohlcv" });
    expect(r.meanRatio!.toNumber()).toBeCloseTo(0.03256137929201726, 14);
    expect(r.meanRatio!.toNumber()).not.toBeCloseTo(0.03250232731308617, 5);
  });
  it("excludes invalid days, counts missing days, and never fills them", () => {
    const w = { start: "2026-01-01", end: "2026-01-10", expectedDays: 10 };
    const r = computeBaseline(w, [input("2026-01-01", "0.02", true, 1n), input("2026-01-02", null, false, 2n), input("2026-01-03", "0.04", true, 3n)], { minCoverage: 0.95, firstHistoricalDate: null, convention: "eod_quote" });
    expect(r).toMatchObject({ validDays: 2, invalidDays: 1, returnedDays: 3, missingDays: 7, status: "partial" });
    expect(r.meanRatio!.toString()).toBe("0.03");
    expect(r.members.find((m) => m.dateUtc === "2026-01-02")!.included).toBe(false);
    expect(r.statusReasons[0]).toMatch(/coverage_20\.0pct/);
  });
  it("labels younger assets as partial and empty histories as unavailable", () => {
    const w = { start: "2026-01-01", end: "2026-01-03", expectedDays: 3 };
    const young = computeBaseline(w, [input("2026-01-03", "0.05")], { minCoverage: 0, firstHistoricalDate: "2026-01-03", convention: "eod_quote" });
    expect(young.status).toBe("partial");
    expect(young.statusReasons[0]).toMatch(/history_starts_2026-01-03/);
    const empty = computeBaseline(w, [], { minCoverage: 0.95, firstHistoricalDate: null, convention: "eod_quote" });
    expect(empty).toMatchObject({ status: "unavailable", meanRatio: null, validDays: 0, missingDays: 3 });
    const allBad = computeBaseline(w, [input("2026-01-01", null, false)], { minCoverage: 0.95, firstHistoricalDate: null, convention: "eod_quote" });
    expect(allBad.statusReasons).toEqual(["no_valid_daily_records"]);
  });
  it("ignores rows outside the window boundaries", () => {
    const r = computeBaseline({ start: "2026-01-02", end: "2026-01-02", expectedDays: 1 }, [input("2026-01-01", "1"), input("2026-01-02", "0.5", true, 2n), input("2026-01-03", "1", true, 3n)], { minCoverage: 1, firstHistoricalDate: null, convention: "eod_quote" });
    expect(r.meanRatio!.toString()).toBe("0.5");
  });
});

describe("CMC response parsing", () => {
  const hist = (quotes: unknown[]) => parseExactJson(JSON.stringify({ status: { error_code: 0 }, data: { "2": { id: 2, symbol: "LTC", quotes } } }));
  const q = (ts: string, v: number, m: number) => ({ timestamp: ts, quote: { USD: { volume_24h: v, market_cap: m, timestamp: ts } } });

  it("assigns an end-of-day quote sampled just after midnight to the completed previous day", () => {
    const { rows } = parseDailyEodQuotes(hist([q("2026-11-03T00:02:07.000Z", 10, 100)]), 60);
    expect(rows[0]).toMatchObject({ dateUtc: "2026-11-02", valid: true });
    expect(rows[0]!.sourceTimestamp!.toISOString()).toBe("2026-11-03T00:02:07.000Z");
  });
  it("marks samples too far from midnight invalid and keeps the earliest of duplicate samples", () => {
    const { rows, duplicates } = parseDailyEodQuotes(hist([q("2026-11-03T02:00:00Z", 10, 100), q("2026-11-04T00:01:00Z", 30, 100), q("2026-11-04T00:00:30Z", 20, 100)]), 60);
    expect(rows.find((r) => r.dateUtc === "2026-11-02")!.invalidReasons).toContain("sample_120min_after_midnight");
    expect(rows.find((r) => r.dateUtc === "2026-11-03")!.volume!.toString()).toBe("20");
    expect(duplicates).toBe(1);
  });
  it("parses OHLCV daily rows by time_open and skips the incomplete current day", () => {
    const body = { data: { id: 2, quotes: [
      { time_open: "2026-11-02T00:00:00.000Z", time_close: "2026-11-02T23:59:59.999Z", quote: { USD: { volume: 149922575, market_cap: 4171991578, timestamp: "2026-11-02T23:59:59.999Z" } } },
      { time_open: "2026-11-03T00:00:00.000Z", time_close: "2026-11-03T23:59:59.999Z", quote: { USD: { volume: 1, market_cap: 2 } } },
    ] } };
    const r = parseDailyOhlcv(parseExactJson(JSON.stringify(body)), new Date("2026-11-03T12:00:00Z"));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ dateUtc: "2026-11-02" });
    expect(r.incompleteSkipped).toBe(1);
  });
  it("buckets hourly historical quotes by their own timestamp without interpolation", () => {
    const rows = parseHourlyHistorical(hist([q("2026-11-03T10:00:05Z", 1, 10), q("2026-11-03T10:30:00Z", 2, 10), q("2026-11-03T12:00:04Z", 3, 10)]));
    expect(rows.map((r) => r.hourBucket.toISOString())).toEqual(["2026-11-03T10:00:00.000Z", "2026-11-03T12:00:00.000Z"]);
    expect(rows[0]!.observedAt.toISOString()).toBe("2026-11-03T10:00:05.000Z"); // no 11:00 row invented
  });
  it("reads rolling volume_24h from v3 quotes/latest (array quote form) and the USD-keyed form", () => {
    const arr = parseLatestQuotes(parseExactJson(JSON.stringify({ data: [{ id: 1, symbol: "BTC", name: "Bitcoin", quote: [{ id: 2781, symbol: "USD", volume_24h: 25010000000, market_cap: 1550000000000, last_updated: "2026-11-03T14:04:00Z" }] }] })));
    expect(arr[0]).toMatchObject({ cmcId: 1, symbol: "BTC" });
    expect(arr[0]!.pair.ratio!.toNumber()).toBeCloseTo(0.016135483870967742, 15);
    const obj = parseLatestQuotes({ data: [{ id: 2, quote: { USD: { volume_24h: "5", market_cap: "0", last_updated: "2026-11-03T14:04:00Z" } } }] });
    expect(obj[0]!.pair.invalidReasons).toEqual(["market_cap_zero"]);
  });
});

describe("72-hour window vs latest 72 records", () => {
  it("reports missing hours and shows the latest records spanning further back", () => {
    const now = new Date("2026-11-03T14:30:00Z");
    const hours = [0, 1, 2, 5, 6, 80, 81].map((h) => ({ hourBucket: new Date(Date.parse("2026-11-03T14:00:00Z") - h * 3_600_000), valid: true }));
    const w = analyzeWindow(now, 72, hours);
    expect(w).toMatchObject({ expectedHours: 72, presentHours: 5, complete: false });
    expect(w.missingHours).toHaveLength(67);
    expect(w.latestRecords.count).toBe(7);
    expect(new Date(w.latestRecords.oldest!) < new Date(w.windowStart)).toBe(true);
    expect(eachDay("2026-01-01", "2026-01-03")).toHaveLength(3);
  });
});

describe("comparison row", () => {
  const now = new Date("2026-11-03T14:30:00Z");
  const base = (meanRatio: string | null, status = "full"): ComparisonInput["baseline"] => ({ meanRatio: meanRatio === null ? null : d(meanRatio), status, validDays: 184, expectedDays: 184, coverage: 1, windowStart: "2026-05-03", windowEnd: "2026-11-02", calculatedAt: now, version: 1 });
  const latest = { observedAt: new Date("2026-11-03T14:20:00Z"), volume24hUsd: d("25"), marketCapUsd: d("1000"), ratio: d("0.025"), valid: true, invalidReasons: [] };
  const win = analyzeWindow(now, 2, [{ hourBucket: new Date("2026-11-03T14:00:00Z"), valid: true }, { hourBucket: new Date("2026-11-03T13:00:00Z"), valid: true }]);
  const row = (o: Partial<ComparisonInput>) => buildRow({ cmcId: 1, symbol: "BTC", name: "Bitcoin", latest, baseline: base("0.0125"), window: win, hourlyBackfill: "done", ...o }, now, 90);

  it("gives a descriptive multiple and an ok status when everything is present", () => {
    expect(row({})).toMatchObject({ ratioToBaseline: "2.0000x", dataStatus: ["ok"], currentRatio: "0.02500000" });
  });
  it("handles zero and unavailable baselines explicitly", () => {
    expect(row({ baseline: base("0") }).ratioToBaseline).toBe("n/a (baseline mean is 0)");
    expect(row({ baseline: base(null, "unavailable") })).toMatchObject({ ratioToBaseline: "n/a (baseline unavailable)", dataStatus: ["baseline_unavailable"] });
    expect(row({ baseline: null }).dataStatus).toContain("baseline_not_calculated");
  });
  it("shows stale quotes, invalid quotes, partial baselines and incomplete windows", () => {
    const r = row({ latest: { ...latest, observedAt: new Date("2026-11-03T10:00:00Z") }, baseline: base("0.01", "partial"), window: analyzeWindow(now, 72, []), hourlyBackfill: "unavailable" });
    expect(r.dataStatus).toEqual(expect.arrayContaining(["stale_quote_270min", "baseline_partial", "recent_window_incomplete_0/72h", "hourly_backfill_unavailable"]));
    expect(row({ latest: { ...latest, valid: false, ratio: null, invalidReasons: ["market_cap_zero"] } }).ratioToBaseline).toBe("n/a (no valid current ratio)");
  });
});

describe("CMC client failure handling", () => {
  function client(responses: Array<() => Response | Error>, over: Partial<ConstructorParameters<typeof CmcClient>[0]> = {}) {
    let t = Date.parse("2026-11-03T12:00:00Z");
    const records: RawRecord[] = [];
    const headers: Array<Record<string, string>> = [];
    const sleeps: number[] = [];
    let i = 0;
    const c = new CmcClient({
      apiKey: "test-cmc-key-value-123",
      requestsPerMinute: 1000,
      maxRetries: 3,
      monthlyCreditBudget: 100,
      creditsUsedThisMonth: async () => 0,
      record: async (r) => {
        records.push(r);
        return `raw-${records.length}`;
      },
      fetchImpl: (async (_u: string, init: RequestInit) => {
        headers.push(init.headers as Record<string, string>);
        const r = responses[Math.min(i++, responses.length - 1)]!();
        if (r instanceof Error) throw r;
        return r;
      }) as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      now: () => new Date(t),
      ...over,
    });
    return { c, records, headers, sleeps };
  }
  const res = (status: number, code: number, extra: Record<string, string> = {}) => () =>
    new Response(JSON.stringify({ status: { error_code: code, error_message: `code ${code}`, credit_count: code === 0 ? 1 : 0 }, data: {} }), { status, headers: extra });

  it("waits ~60 s after a per-minute rate limit (1008) and retries", async () => {
    const { c, sleeps } = client([res(429, 1008), res(200, 0)]);
    await expect(c.get("/v3/cryptocurrency/quotes/latest", { id: 1 })).resolves.toMatchObject({ creditCount: 1 });
    expect(Math.max(...sleeps)).toBeGreaterThanOrEqual(60_000);
  });
  it("honors a longer Retry-After header", async () => {
    const { c, sleeps } = client([res(429, 1008, { "retry-after": "120" }), res(200, 0)]);
    await c.get("/x", {});
    expect(Math.max(...sleeps)).toBe(120_000);
  });
  it("does not retry credit exhaustion, plan restrictions, or authentication errors", async () => {
    for (const [status, code, kind] of [[429, 1009, "credits_exhausted"], [429, 1010, "credits_exhausted"], [403, 1006, "plan_not_authorized"], [401, 1001, "auth"], [402, 1004, "billing"]] as const) {
      const { c, records } = client([res(status, code), res(200, 0)]);
      await expect(c.get("/x", {})).rejects.toMatchObject({ kind });
      expect(records).toHaveLength(1);
    }
  });
  it("retries server and network errors a bounded number of times", async () => {
    const ok = client([res(500, 0), () => new Error("ECONNRESET"), res(200, 0)]);
    await expect(ok.c.get("/x", {})).resolves.toBeDefined();
    const bad = client([res(503, 0)]);
    await expect(bad.c.get("/x", {})).rejects.toMatchObject({ kind: "server" });
    expect(bad.records).toHaveLength(4); // 1 + maxRetries
  });
  it("enforces the local monthly credit budget before calling", async () => {
    const { c, records } = client([res(200, 0)], { creditsUsedThisMonth: async () => 100 });
    await expect(c.get("/x", {}, 1)).rejects.toBeInstanceOf(CmcApiError);
    expect(records).toHaveLength(0);
  });
  it("sends the key only as a header and never records it", async () => {
    const { c, records, headers } = client([res(200, 0)]);
    await c.get("/v3/cryptocurrency/quotes/latest", { id: "1,2" });
    expect(headers[0]!["X-CMC_PRO_API_KEY"]).toBe("test-cmc-key-value-123");
    expect(JSON.stringify(records)).not.toContain("test-cmc-key-value-123");
    await expect(c.get("/x", { CMC_PRO_API_KEY: "nope" })).rejects.toThrow(/must not be passed/);
  });
});
