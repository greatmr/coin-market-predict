import { describe, expect, it } from "vitest";
import { CmcWebClient, WEB_CHART, WEB_DETAIL, WEB_HISTORY, WEB_LISTING, webResponseStatus } from "../../src/sources/coinmarketcap-web/client.js";
import { parseWebDaily, parseWebHourly, parseWebIdentity, parseWebLatest, parseWebListing, websiteData } from "../../src/sources/coinmarketcap-web/parse.js";
import { PoliteHttpClient } from "../../src/sources/http/polite-client.js";
import { InMemorySourceHealthStore } from "../../src/sources/http/source-health.js";
import { baselineWindow, parseIsoDate } from "../../src/vmc/window.js";

/** Public website only, five sequential calls. No keys, model usage or database writes. */
describe.skipIf(process.env.RUN_LIVE_CMC_WEB !== "1")("live CMC website crawler", () => {
  it("reads XRP's coin page, six-month daily history, 72-hour chart and listing", async () => {
    const web = new CmcWebClient(new PoliteHttpClient({ providerId: "live-cmc-web", requestsPerMinute: 6, monthlyBudget: 10, maxAttempts: 1, store: new InMemorySourceHealthStore(), responseStatus: webResponseStatus, headers: { origin: "https://coinmarketcap.com", referer: "https://coinmarketcap.com/", platform: "web" } }), 0);
    const now = new Date();
    const detail = await web.get(WEB_DETAIL, { id: 52, convertId: 2781 });
    const identity = parseWebIdentity(websiteData(detail.body), 52);
    const page = await web.coin(52, identity.slug);
    expect(page.endpoint).toBe("/currencies/xrp/");
    expect(parseWebLatest(page.body as Record<string, unknown>, 52).pair.valid).toBe(true);
    const win = baselineWindow(now, 6);
    const daily = await web.get(WEB_HISTORY, { id: 52, convertId: 2781, interval: "1d", timeStart: parseIsoDate(win.start).getTime() / 1000, timeEnd: Math.floor(now.getTime() / 1000) });
    const days = parseWebDaily(daily.body, 52, now).rows.filter((r) => r.dateUtc >= win.start && r.dateUtc <= win.end);
    expect(days.length).toBeGreaterThanOrEqual(170);
    expect(days.every((r) => r.valid)).toBe(true);
    const chart = await web.get(WEB_CHART, { id: 52, convertId: 2781, range: "7D" });
    const hours = parseWebHourly(chart.body, 52, new Date(now.getTime() - 72 * 3600_000), now);
    expect(hours.length).toBeGreaterThanOrEqual(70);
    expect(hours.every((r) => r.valid)).toBe(true);
    const listing = await web.get(WEB_LISTING, { start: 1, limit: 2, convertId: 2781 });
    expect(parseWebListing(listing.body).observations.length).toBeGreaterThanOrEqual(2);
  });
});
