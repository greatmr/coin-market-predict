import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { addHours, HOUR_MS } from "../../src/common/time.js";
import { IngestionService, type HistoryBackfillReport } from "../../src/ingestion/ingestion.service.js";
import { PipelineService } from "../../src/pipeline/pipeline.service.js";
import { RetentionService } from "../../src/pipeline/retention.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";
import { ReadModelService } from "../../src/read-model/read-model.service.js";
import { CmcWebClient, WEB_CHART, WEB_DETAIL, WEB_HISTORY, WEB_LISTING, webResponseStatus } from "../../src/sources/coinmarketcap-web/client.js";
import { ReportService } from "../../src/telegram/report.service.js";
import { PoliteHttpClient } from "../../src/sources/http/polite-client.js";
import { InMemorySourceHealthStore } from "../../src/sources/http/source-health.js";
import { makeApp, resetDb, testConfig } from "./helpers.js";

/** SYNTHETIC website universe (not market data): every strategy category is represented. */
interface Coin { id: number; symbol: string; price: number; mcap: number; vol: number; tags?: string[]; chartPrice?: number; chartVol?: number; change1h?: number }
const COINS: Coin[] = [
  { id: 1, symbol: "BTC", price: 100_000, mcap: 2e12, vol: 3e10 },
  { id: 1027, symbol: "ETH", price: 3_500, mcap: 4e11, vol: 1.5e10 },
  { id: 825, symbol: "USDT", price: 1, mcap: 1.5e11, vol: 6e10, tags: ["stablecoin"] },
  ...Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, symbol: `LIQ${i}`, price: 2 + i, mcap: 50e6 + i * 1e6, vol: 5e6 - i * 1e5 })),
  ...Array.from({ length: 5 }, (_, i) => ({ id: 200 + i, symbol: `SML${i}`, price: 0.1, mcap: 2e6, vol: 1e6 })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: 300 + i, symbol: `ILQ${i}`, price: 1, mcap: 20e6, vol: 100_000 })),
  { id: 400, symbol: "NOCAP", price: 1, mcap: 0, vol: 1e6 },
];
const LIQUID = [1, 1027, ...Array.from({ length: 12 }, (_, i) => 100 + i)];
const SLOT = new Date("2026-11-03T16:00:00Z");

let app: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>["compile"]>> | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function setup(overrides: Record<string, string> = {}, opts: { chartGapHour?: Date; failChartIds?: number[]; extraCoins?: Coin[] } = {}) {
  const coins = [...COINS, ...(opts.extraCoins ?? [])];
  let now = new Date(SLOT.getTime() + 20 * 60_000);
  const charts: number[] = [];
  const http = new PoliteHttpClient({
    providerId: "universe_test", requestsPerMinute: 60, monthlyBudget: 10_000, maxAttempts: 1, responseStatus: webResponseStatus, store: new InMemorySourceHealthStore(),
    clock: { now: () => now }, sleep: async () => undefined,
    fetchImpl: (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === WEB_LISTING) {
        const start = Number(url.searchParams.get("start")), limit = Number(url.searchParams.get("limit"));
        const observed = new Date(now.getTime() - 5 * 60_000).toISOString();
        const list = coins.slice(start - 1, start - 1 + limit).map((c) => ({
          id: c.id, name: `${c.symbol} coin`, symbol: c.symbol, slug: c.symbol.toLowerCase(), tags: c.tags ?? [], circulatingSupply: c.mcap ? c.mcap / c.price : 0, lastUpdated: observed,
          quotes: [{ name: "USD", price: c.price, volume24h: c.vol, marketCap: c.mcap, percentChange1h: c.change1h ?? 0.5, percentChange24h: 2, percentChange7d: 5, lastUpdated: observed }],
        }));
        return new Response(JSON.stringify({ status: { error_code: "0" }, data: { cryptoCurrencyList: list, totalCount: String(coins.length) } }));
      }
      if (url.pathname === WEB_CHART) {
        const id = Number(url.searchParams.get("id"));
        charts.push(id);
        if (opts.failChartIds?.includes(id)) return new Response("<html>502 Bad Gateway</html>", { status: 502 });
        const c = coins.find((x) => x.id === id)!;
        const points: Record<string, { v: number[] }> = {};
        const end = Math.floor(now.getTime() / 900_000) * 900_000;
        for (let t = end - 7 * 24 * HOUR_MS, k = 0; t <= end; t += 900_000, k++) {
          if (opts.chartGapHour && t >= opts.chartGapHour.getTime() && t < opts.chartGapHour.getTime() + HOUR_MS) continue;
          points[String(t / 1000)] = { v: [c.chartPrice ?? c.price * (1 + 0.0001 * k), c.chartVol ?? c.vol, c.mcap] };
        }
        return new Response(JSON.stringify({ status: { error_code: "0" }, data: { points } }));
      }
      if (url.pathname === WEB_DETAIL) {
        const id = Number(url.searchParams.get("id"));
        const c = coins.find((x) => x.id === id)!;
        return new Response(JSON.stringify({ status: { error_code: "0" }, data: { id, name: `${c.symbol} coin`, symbol: c.symbol, slug: c.symbol.toLowerCase(), status: "active", actualTimeStart: "2020-01-01T00:00:00.000Z", latestUpdateTime: now.toISOString(), statistics: { volume24h: c.vol, marketCap: c.mcap } } }));
      }
      if (url.pathname === WEB_HISTORY) {
        // Completed daily OHLCV with a constant 5% volume / market cap ratio (the six-month baseline).
        const id = Number(url.searchParams.get("id"));
        const c = coins.find((x) => x.id === id)!;
        const from = Number(url.searchParams.get("timeStart")) * 1000, to = Number(url.searchParams.get("timeEnd")) * 1000;
        const quotes = [];
        for (let d = Math.floor(from / 86_400_000) * 86_400_000; d + 86_400_000 - 1 <= to; d += 86_400_000) {
          quotes.push({ timeOpen: new Date(d).toISOString(), timeClose: new Date(d + 86_400_000 - 1).toISOString(), quote: { name: "2781", volume: c.mcap * 0.05, marketCap: c.mcap, timestamp: new Date(d + 86_400_000 - 1).toISOString() } });
        }
        return new Response(JSON.stringify({ status: { error_code: "0" }, data: { id, quotes } }));
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch,
  });
  const cfg = testConfig({ DATA_SOURCE: "coinmarketcap_web", AGENT_PROVIDER: "off", TELEGRAM_MODE: "disabled", ...overrides });
  app = await Test.createTestingModule({ imports: [AppModule.forRoot(cfg, { http: false })] }).overrideProvider(CmcWebClient).useValue(new CmcWebClient(http, 0, () => now)).compile();
  app.useLogger(false);
  await app.init();
  const prisma = app.get(PrismaService);
  await resetDb(prisma);
  const pipeline = app.get(PipelineService);
  pipeline.clock = { now: () => now };
  return { prisma, pipeline, charts, advance: (h: number) => { now = addHours(now, h); } };
}

const historyOf = async (prisma: PrismaService, runId: string) =>
  (await prisma.pipelineStage.findUniqueOrThrow({ where: { runId_stage: { runId, stage: "history" } } })).detail as unknown as HistoryBackfillReport;

describe("full website universe through the pipeline (synthetic transport)", () => {
  it("collects every listed coin, backfills only coins the strategy can use, and stores derived rows only for the screen universe", async () => {
    const { prisma, pipeline, charts, advance } = await setup();
    const r = await pipeline.runSlot(SLOT);
    expect(r.status).toBe("succeeded");
    expect(await prisma.marketSnapshot.count({ where: { slotTime: SLOT } })).toBe(COINS.length);
    const run = await prisma.pipelineRun.findUniqueOrThrow({ where: { id: r.runId! } });
    expect(run.coverage).toMatchObject({ label: "complete", collected: COINS.length, universeSize: COINS.length });

    // Benchmarks first, then the liquid coins by 24h volume; never stablecoins, sub-floor, illiquid or cap-less coins.
    expect(charts).toEqual(LIQUID);
    expect(await historyOf(prisma, r.runId!)).toMatchObject({ status: "completed", candidates: 14, needed: 14, attempted: 14, backfilled: 14, remaining: 0, stoppedBy: null });
    const backfilled = await prisma.marketSnapshot.groupBy({ by: ["providerAssetId"], where: { qualityFlags: { has: "historical_backfill" } }, _count: { _all: true } });
    expect(backfilled.map((b) => Number(b.providerAssetId)).sort((a, b) => a - b)).toEqual([...LIQUID].sort((a, b) => a - b));
    expect(backfilled.every((b) => b._count._all === 72)).toBe(true);
    // Samples are taken at the current observation's minute (16:15 → :15 of every earlier hour).
    const prev = await prisma.marketSnapshot.findFirstOrThrow({ where: { providerAssetId: "105", slotTime: addHours(SLOT, -1) } });
    expect(prev.observedAt!.toISOString()).toBe("2026-11-03T15:15:00.000Z");

    // Derived rows: benchmarks + 12 liquid + 3 illiquid. Everything else is a counted exclusion.
    expect(await prisma.featureValue.count({ where: { slotTime: SLOT } })).toBe(17);
    const screened = await prisma.screeningResult.findMany({ where: { runId: r.runId! }, include: { asset: true } });
    expect(screened).toHaveLength(17);
    expect(run.metrics).toMatchObject({ observed: 24, outsideUniverse: 7, outsideReasons: { "excluded_class:stablecoin": 1, below_min_market_cap: 5, market_cap_unavailable: 1 }, screened: 17 });
    const liquid = screened.filter((s) => s.asset.symbol.startsWith("LIQ"));
    expect(liquid.every((s) => s.eligible && !s.exclusionReasons.includes("warming_up"))).toBe(true);
    const illiquid = screened.filter((s) => s.asset.symbol.startsWith("ILQ"));
    expect(illiquid.every((s) => s.exclusionReasons.includes("illiquid_volume") && s.exclusionReasons.includes("warming_up"))).toBe(true);
    const fv = await prisma.featureValue.findFirstOrThrow({ where: { slotTime: SLOT, asset: { symbol: "LIQ3" } } });
    expect(fv).toMatchObject({ historyDepth: 73, warmupState: "full" });

    // Dashboard read model: funnel, enriched screening rows and the all-coins market table agree.
    const read = app!.get(ReadModelService);
    const ov = (await read.overview()) as { funnel: Record<string, unknown> };
    expect(ov.funnel).toMatchObject({ listed: 24, collected: 24, coverageLabel: "complete", observed: 24, outside: 7, screened: 17, warming: 3, eligible: 12 });
    expect(ov.funnel.insideReasons).toMatchObject({ illiquid_volume: 3, warming_up: 3, benchmark_reference: 2 });
    expect(Object.values(ov.funnel.classifications as Record<string, number>).reduce((x, y) => x + y, 0)).toBe(12);
    const rows = (await read.screening({ eligibleOnly: true, limit: 100 })).results as Array<{ quote: { price: number; marketCap: number }; keyFeatures: { values: Record<string, number | null>; historyDepth: number } }>;
    expect(rows).toHaveLength(12);
    expect(rows.every((x) => x.quote.price > 0 && x.quote.marketCap >= 5e6 && x.keyFeatures.historyDepth === 73 && x.keyFeatures.values.ret_2h !== null)).toBe(true);
    const all = await read.market({ sort: "market_cap", dir: "desc", scope: "all", limit: 50, offset: 0 });
    expect(all.total).toBe(24);
    const coins = all.coins as Array<{ asset: { symbol: string }; strategy: { inUniverse: boolean; reasons: string[]; screened: boolean } }>;
    expect(coins[0]!.asset.symbol).toBe("BTC");
    expect(coins.find((c) => c.asset.symbol === "USDT")!.strategy).toMatchObject({ inUniverse: false, reasons: ["excluded_class:stablecoin"] });
    expect(coins.filter((c) => c.strategy.inUniverse).every((c) => c.strategy.screened)).toBe(true);
    expect((await read.market({ sort: "volume", dir: "desc", scope: "universe", limit: 50, offset: 0 })).total).toBe(17);
    expect((await read.market({ sort: "symbol", dir: "asc", scope: "outside", limit: 50, offset: 0, search: "sml" })).total).toBe(5);

    // Next hour the listing alone extends every chain: no chart requests at all.
    advance(1);
    const next = await pipeline.runSlot(addHours(SLOT, 1));
    expect(await historyOf(prisma, next.runId!)).toMatchObject({ needed: 0, attempted: 0 });
    expect(charts).toHaveLength(LIQUID.length);
  });

  it("continues an interrupted backfill on the next run without refetching completed coins", async () => {
    const { prisma, pipeline, charts, advance } = await setup({ SOURCE_HISTORY_BOOTSTRAP_MAX_ASSETS: "5" });
    const first = await pipeline.runSlot(SLOT);
    expect(await historyOf(prisma, first.runId!)).toMatchObject({ needed: 14, attempted: 5, stoppedBy: "max_assets", remaining: 9 });
    expect(charts).toEqual(LIQUID.slice(0, 5));
    advance(1);
    const second = await pipeline.runSlot(addHours(SLOT, 1));
    expect(await historyOf(prisma, second.runId!)).toMatchObject({ needed: 9, attempted: 5, remaining: 4 });
    expect(charts.slice(5)).toEqual(LIQUID.slice(5, 10));
    advance(1);
    const third = await pipeline.runSlot(addHours(SLOT, 2));
    // Three consecutive hourly sweeps give every coin t, t−1h, t−2h without any history request.
    expect(await historyOf(prisma, third.runId!)).toMatchObject({ needed: 0, attempted: 0 });
    expect(charts).toHaveLength(10);
    expect(await prisma.screeningResult.count({ where: { runId: third.runId!, exclusionReasons: { has: "warming_up" } } })).toBe(0);
  });

  it("never spends the monthly request budget that the hourly listing still needs", async () => {
    const { prisma, pipeline, charts } = await setup({ CMC_WEB_MONTHLY_REQUEST_BUDGET: "1" });
    const r = await pipeline.runSlot(SLOT);
    expect(r.status).toBe("succeeded");
    expect(await historyOf(prisma, r.runId!)).toMatchObject({ attempted: 0, stoppedBy: "request_budget_reserve", remaining: 14 });
    expect(charts).toEqual([]);
  });

  it("skips a coin whose chart request fails transiently and pauses after repeated failures", async () => {
    const one = await setup({}, { failChartIds: [103] });
    const r = await one.pipeline.runSlot(SLOT);
    expect(await historyOf(one.prisma, r.runId!)).toMatchObject({ attempted: 14, backfilled: 13, failed: 1, remaining: 1, stoppedBy: null });
    await app!.close();
    app = undefined;
    const many = await setup({}, { failChartIds: [100, 101, 102, 103, 104, 105, 106] });
    const r2 = await many.pipeline.runSlot(SLOT);
    const h = await historyOf(many.prisma, r2.runId!);
    expect(h).toMatchObject({ backfilled: 2, stoppedBy: "source_unavailable" });
    expect(h.attempted).toBeLessThanOrEqual(7); // BTC, ETH, then at most five failing coins
    expect(r2.status).toBe("succeeded"); // history problems never fail the run
  });

  it("still screens the collected snapshots when the history stage crashes, and marks the run partial", async () => {
    const { prisma, pipeline } = await setup();
    const spy = vi.spyOn(app!.get(IngestionService), "backfillHistory").mockRejectedValueOnce(new Error("simulated database outage"));
    const r = await pipeline.runSlot(SLOT);
    expect(r.status).toBe("partial");
    expect(r.stages.history).toMatch(/failed: .*simulated database outage/);
    expect(r.stages.screen).toBe("succeeded");
    expect(await prisma.screeningResult.count({ where: { runId: r.runId! } })).toBe(17);
    spy.mockRestore();
  });

  it("keeps existing observations and leaves hours the chart does not have missing", async () => {
    const gap = addHours(SLOT, -5);
    const { prisma, pipeline, charts } = await setup({}, { chartGapHour: gap });
    const r = await pipeline.runSlot(SLOT);
    expect(await prisma.marketSnapshot.count({ where: { slotTime: gap } })).toBe(0);
    const depth = await prisma.featureValue.findFirstOrThrow({ where: { slotTime: SLOT, asset: { symbol: "LIQ0" } } });
    expect(depth.historyDepth).toBe(5); // t … t−4h; the missing t−5h breaks the chain
    // Drop one stored hour and mark another: a new backfill restores only the dropped hour.
    await prisma.marketSnapshot.deleteMany({ where: { providerAssetId: "100", slotTime: addHours(SLOT, -1) } });
    await prisma.marketSnapshot.updateMany({ where: { providerAssetId: "100", slotTime: addHours(SLOT, -2) }, data: { price: 123.456 } });
    const report = await app!.get(IngestionService).backfillHistory(SLOT, r.runId!, new Date(SLOT.getTime() + 20 * 60_000));
    expect(report).toMatchObject({ needed: 1, attempted: 1, backfilled: 1, inserted: 1, remaining: 0 });
    expect(charts.at(-1)).toBe(100);
    expect((await prisma.marketSnapshot.findFirstOrThrow({ where: { providerAssetId: "100", slotTime: addHours(SLOT, -2) } })).price!.toString()).toBe("123.456");
    expect(await prisma.marketSnapshot.count({ where: { providerAssetId: "100", slotTime: addHours(SLOT, -1) } })).toBe(1);
  });
});

describe("pump recommendations: strategy + VMC + 3 days + agents (synthetic transport)", () => {
  // A crafted early surge: flat price and volume for three days, then +3% price and +50% rolling volume this hour.
  const SURGE: Coin = { id: 500, symbol: "SURGE", price: 1.03, mcap: 51.5e6, vol: 7.5e6, chartPrice: 1, chartVol: 5e6, change1h: 3 };

  it("rates the surge high, fetches its six-month VMC baseline, and combines the agents' stance into the call", async () => {
    const { prisma, pipeline, charts } = await setup({ VMC_SOURCE: "cmc_web", VMC_DAILY_CONVENTION: "ohlcv", AGENT_PROVIDER: "fixture" }, { extraCoins: [SURGE] });
    const r = await pipeline.runSlot(SLOT);
    expect(["succeeded", "partial"]).toContain(r.status);
    expect(charts).toContain(500);
    const scr = await prisma.screeningResult.findFirstOrThrow({ where: { runId: r.runId!, asset: { symbol: "SURGE" } } });
    expect(scr).toMatchObject({ classification: "advance_candidate", pumpChance: "high", shortlisted: true });
    expect(scr.pumpReasons.join(" | ")).toMatch(/early-surge setup.*✓ volume building \+50\.0% in 2h/);

    // The vmc stage computed a real baseline (mean of daily volume / market cap = 0.05) for the recommended coin.
    const base = await prisma.vmcBaseline.findFirstOrThrow({ where: { cmcId: 500 } });
    expect(base.meanRatio!.toString()).toBe("0.05");
    expect(base.status).toBe("full");

    const sig = await prisma.signal.findFirstOrThrow({ where: { runId: r.runId!, asset: { symbol: "SURGE" } } });
    expect(sig).toMatchObject({ status: "candidate", pumpChance: "high", agentRecommendation: "buy", recommendation: "buy", origin: "fixture_agent" });
    expect(sig.recommendationReason).toMatch(/strategy .* and agents agree/);

    const rec = (await app!.get(ReadModelService).recommendations({})) as { rows: Array<Record<string, any>> };
    const row = rec.rows.find((x) => x.symbol === "SURGE")!;
    expect(rec.rows[0]!.symbol).toBe("SURGE");
    expect(row.threeDay.change).toBeCloseTo(0.03, 6);
    expect(row.threeDay.spanHours).toBe(72);
    expect(row.vmc.baselineMean).toBeCloseTo(0.05, 10);
    expect(row.vmc.multiple).toBeCloseTo(7.5e6 / 51.5e6 / 0.05, 6);
    expect(row).toMatchObject({ pumpChance: "high", recommendation: "buy", agent: { recommendation: "buy", origin: "fixture_agent" } });
    expect(row.scenario.entryPrice).toBeCloseTo(1.03 * 1.01, 8);

    // The Telegram report leads with the same table.
    const text = (await app!.get(ReportService).build(r.runId!, "completed", null)).join("\n");
    expect(text).toMatch(/<pre>Coin\s+3d\s+MCap\s+VMC\s+Pump\s+Agent\s+Rec\nSURGE\s+\+3\.0%\s+52M\s+2\.9x\s+HIGH\s+BUY\s+BUY/);
  });

  it("skips VMC baselines when the VMC source is the synthetic fixture", async () => {
    const { prisma, pipeline } = await setup({ AGENT_PROVIDER: "fixture" }, { extraCoins: [SURGE] });
    const r = await pipeline.runSlot(SLOT);
    const stage = await prisma.pipelineStage.findUniqueOrThrow({ where: { runId_stage: { runId: r.runId!, stage: "vmc" } } });
    expect(stage.detail).toMatchObject({ skipped: expect.stringMatching(/VMC_SOURCE=fixture/) });
    expect(await prisma.vmcBaseline.count()).toBe(0);
    const rec = (await app!.get(ReadModelService).recommendations({})) as { rows: Array<Record<string, any>> };
    expect(rec.rows.find((x) => x.symbol === "SURGE")!.vmc).toMatchObject({ multiple: null, baselineMean: null });
  });
});

describe("tiered retention", () => {
  it("thins tail coins to one genuine snapshot per UTC day, keeps universe coins, floor-crossers and benchmarks hourly, and prunes derived rows", async () => {
    const { app: a, prisma } = await makeApp({ RETENTION_DETAIL_DAYS: "30" });
    try {
      await resetDb(prisma);
      await prisma.provider.create({ data: { id: "fixture", name: "fixture", accessMethod: "fixture", isLive: false } });
      const mk = async (symbol: string, assetClass = "regular", isBenchmark = false) =>
        (await prisma.asset.create({ data: { name: symbol, symbol, assetClass, isBenchmark, firstSeenAt: SLOT, lastSeenAt: SLOT } })).id;
      const ids = { tail: await mk("TAIL"), uni: await mk("UNI"), cross: await mk("CROSS"), bench: await mk("BENCH", "regular", true), stable: await mk("STBL", "stablecoin") };
      const start = new Date("2026-10-01T00:00:00Z");
      const rows = [];
      for (let h = 0; h < 72; h++) {
        const slotTime = addHours(start, h);
        const crossing = h === 60; // 2026-10-03 12:00 qualifies for the universe
        const values: Record<string, [number, number]> = { tail: [1e6, 1e5], uni: [5e7, 5e6], cross: crossing ? [5e7, 5e6] : [1e6, 1e5], bench: [1e6, 1e5], stable: [5e7, 5e6] };
        for (const [k, [mcap, vol]] of Object.entries(values)) {
          rows.push({ assetId: ids[k as keyof typeof ids], providerId: "fixture", providerAssetId: k, slotTime, collectedAt: slotTime, observedAt: slotTime, sourceUrl: "fixture://x", price: 1, marketCap: mcap, marketCapProvenance: "provider_reported", supplyProvenance: "unavailable", volumeRolling24h: vol, qualityFlags: [], completeness: 1, nullReasons: {} });
        }
      }
      await prisma.marketSnapshot.createMany({ data: rows });
      const run = await prisma.pipelineRun.create({ data: { kind: "hourly", slotTime: start, providerId: "fixture", status: "succeeded", startedAt: start, isLiveData: false } });
      await prisma.featureValue.createMany({ data: [{ assetId: ids.uni, providerId: "fixture", slotTime: start, featureSetVersion: "fs-1", values: {}, unavailable: {}, historyDepth: 1, warmupState: "warming_up" }, { assetId: ids.uni, providerId: "fixture", slotTime: addHours(SLOT, -1), featureSetVersion: "fs-1", values: {}, unavailable: {}, historyDepth: 1, warmupState: "warming_up" }] });
      await prisma.screeningResult.createMany({ data: [ids.uni, ids.tail].map((assetId, i) => ({ runId: run.id, assetId, slotTime: start, strategyVersion: "surge-screen-1", eligible: i === 0, exclusionReasons: [], classification: "none", heuristicScore: 0, components: {}, riskFlags: [], shortlisted: i === 0 })) });

      const report = await a.get(RetentionService).apply("fixture", SLOT);
      expect(report.thinnedDays).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
      const count = (k: keyof typeof ids) => prisma.marketSnapshot.count({ where: { assetId: ids[k] } });
      expect(await count("tail")).toBe(3); // first snapshot of each day
      expect(await count("stable")).toBe(3); // excluded class is never in the universe
      expect(await count("uni")).toBe(72);
      expect(await count("cross")).toBe(72); // qualified on 10-03, so ±72h stays hourly
      expect(await count("bench")).toBe(72);
      const kept = await prisma.marketSnapshot.findMany({ where: { assetId: ids.tail }, orderBy: { slotTime: "asc" }, select: { slotTime: true } });
      expect(kept.map((k) => k.slotTime.toISOString())).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z"]);
      expect(report.prunedFeatures).toBe(1);
      expect(report.prunedScreening).toBe(1);
      expect(await prisma.screeningResult.count({ where: { shortlisted: true } })).toBe(1);

      // Idempotent and resumable: the watermark has passed every eligible day.
      expect((await a.get(RetentionService).apply("fixture", SLOT)).thinnedDays).toEqual([]);
    } finally {
      await a.close();
    }
  });
});
