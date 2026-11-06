import { describe, expect, it } from "vitest";
import { addDays, isoDate } from "../../src/common/dates.js";
import { CmcWebClient, WEB_LISTING, webResponseStatus } from "../../src/sources/coinmarketcap-web/client.js";
import { CmcWebTier1Source } from "../../src/sources/coinmarketcap-web/coinmarketcap-web.adapter.js";
import { parseWebListing } from "../../src/sources/coinmarketcap-web/parse.js";
import { PoliteHttpClient } from "../../src/sources/http/polite-client.js";
import { InMemorySourceHealthStore } from "../../src/sources/http/source-health.js";

/** Public website only, about five sequential calls. No keys and no database writes. */
describe.skipIf(process.env.RUN_LIVE_CMC_WEB !== "1")("live CMC website crawler (Tier 1 routes)", () => {
  it("reads the listing (rank, date added, tags), 35 completed daily rows, LBank spot pairs and a coin's markets", async () => {
    const web = new CmcWebClient(new PoliteHttpClient({ providerId: "live-cmc-web", requestsPerMinute: 6, monthlyBudget: 10, maxAttempts: 1, store: new InMemorySourceHealthStore(), responseStatus: webResponseStatus, headers: { origin: "https://coinmarketcap.com", referer: "https://coinmarketcap.com/", platform: "web" } }), 0);
    const now = new Date();
    const listing = parseWebListing((await web.get(WEB_LISTING, { start: 1, limit: 5, convertId: 2781 })).body);
    expect(listing.observations.filter((o) => o.rank !== null && o.dateAdded && o.tags).length).toBeGreaterThanOrEqual(3);
    const src = new CmcWebTier1Source(web);
    const latest = addDays(isoDate(now), -1);
    const daily = await src.dailyHistory({ cmcId: 52 }, addDays(isoDate(now), -35), latest, now);
    expect(daily.rows.length).toBeGreaterThanOrEqual(30);
    expect(daily.rows.at(-1)!.dateUtc).toBe(latest);
    expect(daily.rows.every((r) => r.invalidReasons.length === 0 && r.close !== null)).toBe(true);
    const lbank = await src.lbankSpotPairs();
    expect(lbank.pairs.length).toBeGreaterThan(100);
    expect(lbank.pairs.every((p) => p.exchange === "lbank" && p.category === "spot")).toBe(true);
    const markets = await src.assetMarkets({ cmcId: 52, slug: "xrp" });
    expect(markets.pairs.length).toBeGreaterThan(10);
  });
});
