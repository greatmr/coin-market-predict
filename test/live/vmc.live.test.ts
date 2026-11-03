import { describe, expect, it } from "vitest";
import { CmcClient } from "../../src/vmc/cmc-client.js";
import { parseKeyInfo, parseLatestQuotes } from "../../src/vmc/cmc-parse.js";

/**
 * Credential-dependent: real CoinMarketCap calls with CMC_API_KEY (~2 credits).
 * Opt in with RUN_LIVE_CMC=1. Uses Bitcoin (1) and Litecoin (2).
 */
try {
  process.loadEnvFile?.(".env");
} catch {
  // optional
}
const on = process.env.RUN_LIVE_CMC === "1" && !!process.env.CMC_API_KEY;

describe.skipIf(!on)("live CoinMarketCap API", () => {
  const client = new CmcClient({
    apiKey: process.env.CMC_API_KEY,
    requestsPerMinute: 10,
    maxRetries: 1,
    monthlyCreditBudget: 10,
    creditsUsedThisMonth: async () => 0,
    record: async () => "not-persisted",
  });

  it("reports key plan details", async () => {
    const r = await client.get("/v1/key/info", {}, 0);
    expect(parseKeyInfo(r.body)?.creditLimitMonthly).toBeGreaterThan(0);
  });

  it("returns rolling 24h volume and market cap for real ids from v3 quotes/latest", async () => {
    const r = await client.get("/v3/cryptocurrency/quotes/latest", { id: "1,2", convert: "USD" }, 1);
    const q = parseLatestQuotes(r.body);
    expect(q.map((x) => x.cmcId).sort()).toEqual([1, 2]);
    expect(q.every((x) => x.pair.valid && x.observedAt instanceof Date)).toBe(true);
  });
});
