import { describe, expect, it } from "vitest";
import { D } from "../../src/common/decimal.js";
import { addDays, isoDate } from "../../src/common/dates.js";
import { REASON } from "../../src/tier1/constants.js";
import { classify, evaluateEligibility, type ClassResult, type EligibilityInput } from "../../src/tier1/eligibility.js";
import { compareQueue, inReviewQueue, type QueueKey } from "../../src/tier1/queue.js";
import { compare, currentObservation, type CurrentInput, type DailyInput, evaluateVmc, windowMean } from "../../src/tier1/vmc.js";

/**
 * PDF p.19 acceptance fixtures. Synthetic numbers (not market data); assertions are on
 * unrounded decimal values, statuses, reason codes, stars and sort order.
 */
const AS_OF = new Date("2026-11-05T07:07:00.000Z"); // T = 2026-11-05; T−1 = 2026-11-04
const T = isoDate(AS_OF);
const MAX_AGE = 120 * 60_000;

/** Daily rows from VMC values, newest first (index 0 = T−1), cap 100 so VMC = volume / 100. */
function rowsFromVmc(vmcNewestFirst: Array<string | null>, opts: { invalidAt?: number[]; cap?: (i: number) => string } = {}) {
  const m = new Map<string, DailyInput>();
  vmcNewestFirst.forEach((v, i) => {
    if (v === null) return;
    const date = addDays(T, -(i + 1));
    const cap = new D(opts.cap?.(i) ?? "100");
    const invalid = opts.invalidAt?.includes(i + 1);
    m.set(date, { dateUtc: date, volume: new D(v).times(cap), marketCap: invalid ? new D(0) : cap, valid: true });
  });
  return m;
}

const current = (vmc: string, extra: Partial<CurrentInput> = {}): CurrentInput => ({
  present: true,
  volume24h: new D(vmc).times(1000),
  marketCap: new D(1000),
  capProviderReported: true,
  observedAt: new Date(AS_OF.getTime() - 60_000),
  collectedAt: AS_OF,
  sameObservation: true,
  ...extra,
});

describe("A: inclusive 1.5x boundary on unrounded decimals", () => {
  const rows = rowsFromVmc(["0.08", "0.10", "0.12"]);
  it("mean3 of 0.08, 0.10, 0.12 is exactly 0.10", () => {
    const w = windowMean(AS_OF, rows, 3);
    expect(w.mean!.toFixed()).toBe("0.1");
    expect(w.dates).toEqual([addDays(T, -1), addDays(T, -2), addDays(T, -3)]);
  });
  it("current 0.15 → exactly 1.5x → YES; 0.149999 → NO", () => {
    const w = windowMean(AS_OF, rows, 3);
    const yes = compare(currentObservation(current("0.15"), MAX_AGE), w);
    expect(yes.status).toBe("YES");
    expect(yes.multiple!.toFixed()).toBe("1.5");
    const no = compare(currentObservation(current("0.149999"), MAX_AGE), w);
    expect(no.status).toBe("NO");
    expect(no.multiple!.lt(1.5)).toBe(true);
  });
  it("exact 1.5x stays YES where binary floating point would say NO (0.01, 0.03, 0.14 vs 0.09)", () => {
    expect(0.09 / ((0.01 + 0.03 + 0.14) / 3) >= 1.5).toBe(false);
    const w = windowMean(AS_OF, rowsFromVmc(["0.01", "0.03", "0.14"]), 3);
    expect(w.mean!.toFixed()).toBe("0.06");
    const c = compare(currentObservation(current("0.09"), MAX_AGE), w);
    expect(c.status).toBe("YES");
    expect(c.multiple!.toFixed()).toBe("1.5");
  });
});

describe("B: independent windows, 14d context only", () => {
  // T−1..T−3 = 0.10 (mean3 0.10); T−4..T−7 = 0.1875 (mean7 0.15); T−8..T−30: 22 × 0.02 + 1 × 0.01 (mean30 0.05).
  const vmc = [...Array(3).fill("0.10"), ...Array(4).fill("0.1875"), ...Array(22).fill("0.02"), "0.01"];
  const rows = rowsFromVmc(vmc);
  const e = evaluateVmc(AS_OF, rows, current("0.20"), MAX_AGE);
  it("means are 0.10 / 0.15 / 0.05", () => {
    expect(e.windows[3].mean!.toFixed()).toBe("0.1");
    expect(e.windows[7].mean!.toFixed()).toBe("0.15");
    expect(e.windows[30].mean!.toFixed()).toBe("0.05");
  });
  it("2.0x YES, 1.333…x NO, 4.0x YES, stars = 2; 14d adds no fourth pass", () => {
    expect(e.comparisons[3]).toMatchObject({ status: "YES" });
    expect(e.comparisons[3].multiple!.toFixed()).toBe("2");
    expect(e.comparisons[7].status).toBe("NO");
    expect(e.comparisons[7].multiple!.toFixed(10)).toBe("1.3333333333");
    expect(e.comparisons[30].status).toBe("YES");
    expect(e.comparisons[30].multiple!.toFixed()).toBe("4");
    expect(e.stars).toBe(2);
    expect(Object.keys(e.comparisons)).toEqual(["3", "7", "30"]);
    expect(e.windows[14].mean).not.toBeNull();
  });
});

describe("C: mean of daily ratios, not total volume / total cap", () => {
  it("daily volume 20 / cap 100 = 0.2", () => {
    const m = new Map<string, DailyInput>([[addDays(T, -1), { dateUtc: addDays(T, -1), volume: new D(20), marketCap: new D(100), valid: true }]]);
    expect(evaluateVmc(AS_OF, m, current("0.2"), MAX_AGE).windows[3].missingDates).toHaveLength(2);
    expect(new D(20).div(100).toFixed()).toBe("0.2");
  });
  it("mean of 0.1 (10/100) and 0.3 (60/200) is 0.2 even though Σvol/Σcap = 0.2333…", () => {
    const rows = rowsFromVmc(["0.1", "0.3", "0.1", "0.3"], { cap: (i) => (i % 2 ? "200" : "100") });
    const w2 = [...rows.values()].slice(0, 2);
    const meanOfRatios = w2.reduce((s, r) => s.plus(r.volume!.div(r.marketCap!)), new D(0)).div(2);
    const ratioOfTotals = w2.reduce((s, r) => s.plus(r.volume!), new D(0)).div(w2.reduce((s, r) => s.plus(r.marketCap!), new D(0)));
    expect(meanOfRatios.toFixed()).toBe("0.2");
    expect(ratioOfTotals.toFixed(4)).toBe("0.2333");
    const w = windowMean(AS_OF, rowsFromVmc(["0.1", "0.3", "0.2"], { cap: (i) => (i === 1 ? "200" : "100") }), 3);
    expect(w.mean!.toFixed()).toBe("0.2");
  });
});

describe("D: a missing or invalid date makes only the windows containing it N/A", () => {
  const full = Array(30).fill("0.05");
  it("invalid date eight days ago → 3d and 7d valid; 14d and 30d N/A", () => {
    const e = evaluateVmc(AS_OF, rowsFromVmc(full, { invalidAt: [8] }), current("0.10"), MAX_AGE);
    expect(e.windows[3].reason).toBeNull();
    expect(e.windows[7].reason).toBeNull();
    expect(e.windows[14]).toMatchObject({ mean: null, reason: REASON.dailyRowInvalid, invalidDates: [addDays(T, -8)] });
    expect(e.windows[30]).toMatchObject({ mean: null, reason: REASON.dailyRowInvalid });
    expect(e.comparisons[3].status).toBe("YES");
    expect(e.comparisons[7].status).toBe("YES");
    expect(e.comparisons[30]).toMatchObject({ status: "N/A", reason: REASON.dailyRowInvalid, multiple: null });
  });
  it("invalid date six days ago → 3d valid; 7d/14d/30d N/A", () => {
    const e = evaluateVmc(AS_OF, rowsFromVmc(full, { invalidAt: [6] }), current("0.10"), MAX_AGE);
    expect(e.windows[3].reason).toBeNull();
    for (const n of [7, 14, 30] as const) expect(e.windows[n].reason).toBe(REASON.dailyRowInvalid);
    expect(e.stars).toBe(1);
  });
  it("a missing day is not skipped, zero-filled or shortened", () => {
    const vmc: Array<string | null> = [...full];
    vmc[4] = null; // T−5 missing
    const e = evaluateVmc(AS_OF, rowsFromVmc(vmc), current("0.10"), MAX_AGE);
    expect(e.windows[3].mean!.toFixed()).toBe("0.05");
    expect(e.windows[7]).toMatchObject({ mean: null, reason: REASON.dailyRowMissing, missingDates: [addDays(T, -5)] });
  });
  it("negative volume and non-finite inputs invalidate the date; zero volume is valid", () => {
    const m = rowsFromVmc(["0", "0.1", "0.2"]);
    expect(windowMean(AS_OF, m, 3).mean!.toFixed()).toBe("0.1");
    m.set(addDays(T, -2), { dateUtc: addDays(T, -2), volume: new D(-1), marketCap: new D(100), valid: true });
    expect(windowMean(AS_OF, m, 3).reason).toBe(REASON.dailyRowInvalid);
  });
});

describe("E: zero baseline, invalid current cap, missing or stale quote", () => {
  it("zero historical mean → N/A ZERO_BASELINE (never infinity)", () => {
    const e = evaluateVmc(AS_OF, rowsFromVmc([...Array(3).fill("0"), ...Array(27).fill("0.05")]), current("0.10"), MAX_AGE);
    expect(e.windows[3].mean!.isZero()).toBe(true);
    expect(e.comparisons[3]).toEqual({ multiple: null, status: "N/A", reason: REASON.zeroBaseline });
    expect(e.comparisons[7].status).not.toBe("N/A");
  });
  it.each([["0"], ["-5"]])("current cap %s → every comparison N/A", (cap) => {
    const e = evaluateVmc(AS_OF, rowsFromVmc(Array(30).fill("0.05")), current("0.10", { marketCap: new D(cap) }), MAX_AGE);
    expect(e.current).toMatchObject({ status: "INVALID", reason: REASON.capInvalid, vmc: null });
    expect(Object.values(e.comparisons).every((c) => c.status === "N/A" && c.reason === REASON.capInvalid)).toBe(true);
    expect(e.stars).toBe(0);
  });
  it("missing current quote → N/A CURRENT_MISSING; stale quote → N/A CURRENT_STALE", () => {
    const rows = rowsFromVmc(Array(30).fill("0.05"));
    const missing = evaluateVmc(AS_OF, rows, current("0.10", { present: false }), MAX_AGE);
    expect(missing.comparisons[3]).toMatchObject({ status: "N/A", reason: REASON.currentMissing });
    const stale = evaluateVmc(AS_OF, rows, current("0.10", { observedAt: new Date(AS_OF.getTime() - MAX_AGE - 1) }), MAX_AGE);
    expect(stale.current.status).toBe("STALE");
    expect(stale.comparisons[30]).toMatchObject({ status: "N/A", reason: REASON.currentStale });
    const edge = evaluateVmc(AS_OF, rows, current("0.10", { observedAt: new Date(AS_OF.getTime() - MAX_AGE) }), MAX_AGE);
    expect(edge.current.status).toBe("OK");
  });
  it("no provider time → TIMESTAMP_UNVERIFIED; mismatched observation → MISMATCHED; calculated cap → INVALID", () => {
    expect(currentObservation(current("0.1", { observedAt: null }), MAX_AGE).status).toBe("TIMESTAMP_UNVERIFIED");
    expect(currentObservation(current("0.1", { observedAt: new Date(AS_OF.getTime() + 10 * 60_000) }), MAX_AGE).reason).toBe(REASON.timestampFuture);
    expect(currentObservation(current("0.1", { sameObservation: false }), MAX_AGE)).toMatchObject({ status: "MISMATCHED", vmc: null });
    expect(currentObservation(current("0.1", { capProviderReported: false }), MAX_AGE).status).toBe("INVALID");
    expect(currentObservation(current("0.1", { volume24h: new D(-1) }), MAX_AGE).reason).toBe(REASON.volumeInvalid);
  });
});

describe("F: eligibility boundaries (inclusive) checked in UTC", () => {
  const regular: ClassResult = { assetClass: "regular", kind: null, source: "cmc_tags", evidence: [] };
  const base: Omit<EligibilityInput, "rank"> = { rankDuplicate: false, capUsd: new D("100000000"), capProviderReported: true, dateAdded: new Date("2020-01-01T00:00:00Z"), asOf: AS_OF, cls: regular, lbank: { status: "VERIFIED", reason: null } };
  const status = (o: Partial<EligibilityInput>) => evaluateEligibility({ rank: 500, ...base, ...o }).status;
  it("rank 100 excluded, 101 included, 1200 included, 1201 excluded", () => {
    expect(status({ rank: 100 })).toBe("EXCLUDED");
    expect(status({ rank: 101 })).toBe("ELIGIBLE");
    expect(status({ rank: 1200 })).toBe("ELIGIBLE");
    expect(status({ rank: 1201 })).toBe("EXCLUDED");
    expect(evaluateEligibility({ rank: 1201, ...base }).reasons).toEqual([REASON.rankOutOfRange]);
  });
  it("cap exactly $15m included, a cent below excluded", () => {
    expect(status({ capUsd: new D("15000000") })).toBe("ELIGIBLE");
    expect(status({ capUsd: new D("14999999.99") })).toBe("EXCLUDED");
  });
  it("exactly 60 × 24 h included; 59 days excluded", () => {
    const sixty = new Date(AS_OF.getTime() - 60 * 86_400_000);
    expect(status({ dateAdded: sixty })).toBe("ELIGIBLE");
    expect(status({ dateAdded: new Date(sixty.getTime() + 1) })).toBe("EXCLUDED");
    expect(status({ dateAdded: new Date(AS_OF.getTime() - 59 * 86_400_000) })).toBe("EXCLUDED");
    expect(evaluateEligibility({ rank: 500, ...base, dateAdded: sixty }).ageDays!.toFixed()).toBe("60");
  });
  it("missing or ambiguous inputs → NEEDS_REVIEW, never silently eligible; known failure dominates", () => {
    expect(evaluateEligibility({ ...base, rank: null }).reasons).toEqual([REASON.rankMissing]);
    expect(status({ rankDuplicate: true })).toBe("NEEDS_REVIEW");
    expect(status({ capUsd: null })).toBe("NEEDS_REVIEW");
    expect(status({ capProviderReported: false })).toBe("NEEDS_REVIEW");
    expect(status({ dateAdded: null })).toBe("NEEDS_REVIEW");
    expect(status({ lbank: { status: "PAIR_LISTED_UNVERIFIED", reason: "NO_TRADING_STATUS_PROOF" } })).toBe("NEEDS_REVIEW");
    expect(status({ lbank: { status: "UNKNOWN", reason: "LBANK_FEED_STALE" } })).toBe("NEEDS_REVIEW");
    expect(status({ lbank: { status: "NOT_LISTED", reason: null } })).toBe("EXCLUDED");
    const both = evaluateEligibility({ ...base, rank: 1500, lbank: { status: "UNKNOWN", reason: "LBANK_FEED_STALE" } });
    expect(both.status).toBe("EXCLUDED");
    expect(both.reasons).toEqual([REASON.rankOutOfRange, `${REASON.lbankUnknown}:LBANK_FEED_STALE`]);
  });
});

describe("classification: CMC tags plus override list", () => {
  const c = (tags: string[], extra: Partial<Parameters<typeof classify>[0]> = {}) => classify({ tags, heuristicClass: null, heuristicSource: null, override: null, ...extra });
  it("stablecoins and tokenized stocks/assets are excluded; fan tokens are not", () => {
    expect(c(["stablecoin"]).assetClass).toBe("stablecoin");
    expect(c(["usd-stablecoin"]).assetClass).toBe("stablecoin");
    expect(c(["tokenized-stock"]).assetClass).toBe("tokenized");
    expect(c(["tokenized-gold"]).assetClass).toBe("tokenized");
    expect(c(["fan-token", "sports"]).assetClass).toBe("regular");
    expect(c(["real-world-assets"]).assetClass).toBe("regular");
  });
  it("wrapped tags and heuristic-only matches are ambiguous (review), not excluded", () => {
    expect(c(["wrapped-tokens"])).toMatchObject({ assetClass: "ambiguous", kind: "wrapped" });
    expect(c([], { heuristicClass: "stablecoin", heuristicSource: "heuristic_price" })).toMatchObject({ assetClass: "ambiguous", kind: "stablecoin" });
    expect(c([], { heuristicClass: "wrapped", heuristicSource: "provider_category" }).assetClass).toBe("regular");
  });
  it("a versioned override decides", () => {
    expect(c(["wrapped-tokens"], { override: { class: "eligible", reason: "governance token", version: "v2" } })).toMatchObject({ assetClass: "regular", source: "override@v2" });
    expect(c([], { override: { class: "stablecoin", reason: "pegged", version: "v2" } }).assetClass).toBe("stablecoin");
  });
});

describe("stars and Review Queue order (p.14)", () => {
  const k = (cmcId: number, p3: QueueKey["pass3d"], p7: QueueKey["pass7d"], p30: QueueKey["pass30d"], m3: string | null): QueueKey => ({ cmcId, pass3d: p3, pass7d: p7, pass30d: p30, multiple3d: m3 === null ? null : new D(m3) });
  it("3d YES first, then 7d, then 30d; N/A after NO; ties by 3d multiple desc then CMC id", () => {
    const rows = [
      k(9, "NO", "YES", "YES", "1.2"),
      k(8, "YES", "NO", "YES", "2.0"),
      k(7, "YES", "YES", "NO", "1.6"),
      k(6, "YES", "YES", "NO", "3.1"),
      k(5, "N/A", "YES", "YES", null),
      k(4, "YES", "N/A", "YES", "2.5"),
      k(3, "YES", "YES", "NO", "1.6"),
      k(2, "NO", "NO", "YES", "0.9"),
    ];
    expect(rows.sort(compareQueue).map((r) => r.cmcId)).toEqual([6, 3, 7, 8, 4, 9, 2, 5]);
  });
  it("queue = ELIGIBLE with at least one YES; 0-star eligible rows stay out of the queue only", () => {
    expect(inReviewQueue({ eligibilityStatus: "ELIGIBLE", stars: 1 })).toBe(true);
    expect(inReviewQueue({ eligibilityStatus: "ELIGIBLE", stars: 0 })).toBe(false);
    expect(inReviewQueue({ eligibilityStatus: "NEEDS_REVIEW", stars: 3 })).toBe(false);
  });
});
