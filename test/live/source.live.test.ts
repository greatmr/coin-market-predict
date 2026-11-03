import { describe, expect, it } from "vitest";
import { CoinGeckoSource } from "../../src/sources/coingecko/coingecko.adapter.js";
import { CoinMarketCapSource } from "../../src/sources/coinmarketcap/coinmarketcap.adapter.js";
import { PoliteHttpClient } from "../../src/sources/http/polite-client.js";
import { InMemorySourceHealthStore } from "../../src/sources/http/source-health.js";

/** Credential-dependent: one page from an official free API. Opt in with RUN_LIVE_SOURCE=1. */
try {
  process.loadEnvFile?.(".env");
} catch {
  // optional
}
const on = process.env.RUN_LIVE_SOURCE === "1";
const client = (id: string, headers: Record<string, string>) =>
  new PoliteHttpClient({ providerId: id, requestsPerMinute: 5, monthlyBudget: 3, store: new InMemorySourceHealthStore(), headers });

describe.skipIf(!on || !process.env.CMC_API_KEY)("live CoinMarketCap Basic API", () => {
  it("returns one listing page with documented fields", async () => {
    const r = await new CoinMarketCapSource(client("coinmarketcap", { "X-CMC_PRO_API_KEY": process.env.CMC_API_KEY! })).collect({ slot: new Date(), maxPages: 1 });
    expect(r.observations.length).toBeGreaterThan(100);
    expect(r.complete).toBe(false);
    expect(r.observations[0]!.observedAt).toBeInstanceOf(Date);
  });
});

describe.skipIf(!on || !process.env.COINGECKO_API_KEY)("live CoinGecko Demo API", () => {
  it("returns one markets page with documented fields", async () => {
    const r = await new CoinGeckoSource(client("coingecko", { "x-cg-demo-api-key": process.env.COINGECKO_API_KEY! })).collect({ slot: new Date(), maxPages: 1 });
    expect(r.observations.length).toBe(250);
    expect(r.complete).toBe(false);
  });
});
