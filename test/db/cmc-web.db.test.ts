import { readFileSync } from "node:fs";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { PipelineService } from "../../src/pipeline/pipeline.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";
import { CmcWebClient, WEB_CHART, WEB_DETAIL, WEB_HISTORY, WEB_LISTING, webResponseStatus } from "../../src/sources/coinmarketcap-web/client.js";
import { PoliteHttpClient } from "../../src/sources/http/polite-client.js";
import { InMemorySourceHealthStore } from "../../src/sources/http/source-health.js";
import { VmcService } from "../../src/vmc/vmc.service.js";
import { ReadModelService } from "../../src/read-model/read-model.service.js";
import { IngestionService } from "../../src/ingestion/ingestion.service.js";
import { eachDay } from "../../src/vmc/window.js";
import { resetDb, testConfig } from "./helpers.js";

const NOW = new Date("2026-11-03T16:20:00Z");
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
let app: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>["compile"]>> | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function setup(overrides: Record<string, string> = {}) {
  const seen: URL[] = [];
  let ms = NOW.getTime();
  let revised = false, emptyChart = false, denied = false;
  const http = new PoliteHttpClient({ providerId: "cmc_web_test", requestsPerMinute: 6, monthlyBudget: 1000, store: new InMemorySourceHealthStore(), responseStatus: webResponseStatus, clock: { now: () => new Date(ms) }, sleep: async (delay) => { ms += delay; }, fetchImpl: (async (input) => {
    const url = new URL(String(input));
    seen.push(url);
    if (denied) return new Response("denied", { status: 403 });
    if (url.pathname.startsWith("/currencies/")) return new Response(fixture("cmc-web-coin.html"));
    if (url.pathname === WEB_DETAIL) return new Response(fixture("cmc-web-detail.json"));
    let data: unknown;
    if (url.pathname === WEB_LISTING) {
      const b = JSON.parse(fixture("cmc-web-listing.json"));
      b.data.totalCount = "3";
      return new Response(JSON.stringify(b));
    } else if (url.pathname === WEB_HISTORY) {
      data = { id: 52, quotes: eachDay("2026-05-03", "2026-11-02").map((d) => ({ timeOpen: `${d}T00:00:00.000Z`, timeClose: `${d}T23:59:59.999Z`, quote: { name: "2781", volume: revised && d === "2026-11-02" ? 200 : 100, marketCap: 1000, timestamp: `${d}T23:59:59.999Z` } })) };
    } else if (url.pathname === WEB_CHART) {
      const points: Record<string, { v: number[] }> = {};
      if (!emptyChart) for (let h = 71; h >= 0; h--) points[String((Date.parse("2026-11-03T16:00:00Z") - h * 3600_000) / 1000)] = { v: [10, 200, 1000] };
      data = { points };
    } else throw new Error(`unexpected URL ${url}`);
    return new Response(JSON.stringify({ status: { error_code: "0" }, data }));
  }) as typeof fetch });
  const cfg = testConfig({ DATA_SOURCE: "coinmarketcap_web", VMC_SOURCE: "cmc_web", VMC_DAILY_CONVENTION: "ohlcv", VMC_ASSET_IDS: "52", AGENT_PROVIDER: "off", TELEGRAM_MODE: "disabled", ...overrides });
  const web = new CmcWebClient(http, 0, () => new Date(ms));
  app = await Test.createTestingModule({ imports: [AppModule.forRoot(cfg, { http: false })] }).overrideProvider(CmcWebClient).useValue(web).compile();
  app.useLogger(false);
  await app.init();
  const prisma = app.get(PrismaService);
  await resetDb(prisma);
  const vmc = app.get(VmcService);
  vmc.now = () => NOW;
  // Freshness is judged against the pipeline clock; pin it to the transport's clock so the
  // fixture listing (observed 15:36 UTC) is not stale whenever the suite happens to run.
  app.get(PipelineService).clock = { now: () => NOW };
  return { prisma, vmc, seen, revise: () => { revised = true; }, emptyChart: (empty: boolean) => { emptyChart = empty; }, deny: () => { denied = true; } };
}

describe("website source into PostgreSQL (synthetic transport)", () => {
  it("stores six-month daily baselines, 72 real-shaped hourly records and coin-page snapshots idempotently", async () => {
    const { prisma, vmc, seen, revise } = await setup();
    for (const job of [() => vmc.syncAssets(), () => vmc.dailyHistory(), () => vmc.baseline(), () => vmc.hourlyBackfill(), () => vmc.hourly()]) expect((await job()).status).toBe("succeeded");
    const b = await prisma.vmcBaseline.findFirstOrThrow({ include: { members: true } });
    expect(b.validDays).toBe(184);
    expect(b.members).toHaveLength(184);
    expect(b.meanRatio!.toString()).toBe("0.1");
    expect(await prisma.vmcHourlyCurrent.count()).toBe(72);
    expect(await prisma.vmcRawResponse.count({ where: { isFixture: true } })).toBe(0);
    expect(seen.find((u) => u.pathname === WEB_HISTORY)!.searchParams.get("interval")).toBe("1d");
    expect(seen.some((u) => u.pathname === "/currencies/xrp/")).toBe(true);
    expect(seen.some((u) => u.hostname.startsWith("pro-api"))).toBe(false);
    const counts = [await prisma.vmcDailyObservation.count(), await prisma.vmcHourlySnapshot.count()];
    await vmc.dailyHistory({ full: true });
    await vmc.hourlyBackfill({ force: true });
    await vmc.hourly();
    expect([await prisma.vmcDailyObservation.count(), await prisma.vmcHourlySnapshot.count()]).toEqual(counts);
    revise();
    await vmc.weekly();
    expect(await prisma.vmcBaseline.count()).toBe(2);
    expect((await prisma.vmcDailyObservation.findMany({ where: { dateUtc: new Date("2026-11-02") }, orderBy: { revision: "asc" } })).map((r) => r.revision)).toEqual([1, 2]);
    expect((await vmc.comparison()).isFixture).toBe(false);
  });

  it("leaves an empty hourly backfill retryable and exposes missing hours", async () => {
    const { vmc, prisma, emptyChart } = await setup();
    await vmc.syncAssets();
    emptyChart(true);
    expect((await vmc.hourlyBackfill()).status).toBe("partial");
    expect((await prisma.vmcAsset.findUniqueOrThrow({ where: { cmcId: 52 } })).hourlyBackfilledAt).toBeNull();
    emptyChart(false);
    expect((await vmc.hourlyBackfill()).status).toBe("succeeded");
  });

  it("keeps native error payloads and stops on access denial", async () => {
    const { vmc, prisma, deny, seen } = await setup();
    await vmc.syncAssets();
    deny();
    const before = seen.length;
    expect((await vmc.hourly()).status).toBe("failed");
    expect(seen.length - before).toBe(1);
    expect(await prisma.vmcRawResponse.count({ where: { httpStatus: 403, body: "denied" } })).toBe(1);
    expect(await prisma.vmcHourlyCurrent.count()).toBe(0);
  });

  it("injects website observations into the main feature and screening pipeline", async () => {
    const { prisma } = await setup();
    const result = await app!.get(PipelineService).runSlot(new Date("2026-11-03T16:00:00Z"));
    expect(result.status).toBe("succeeded");
    expect(await prisma.marketSnapshot.count({ where: { providerId: "coinmarketcap_web", slotTime: new Date("2026-11-03T16:00:00Z") } })).toBe(3);
    expect(await prisma.marketSnapshot.count({ where: { qualityFlags: { has: "historical_backfill" } } })).toBeGreaterThan(100);
    const historical = await prisma.marketSnapshot.findFirstOrThrow({ where: { qualityFlags: { has: "historical_backfill" } } });
    expect(historical.circulatingSupply).toBeNull();
    expect(historical.volumeHourly).toBeNull();
    expect(historical.isStale).toBe(false);
    expect(historical.observedAt!.getTime()).toBeLessThan(historical.collectedAt.getTime());
    const count = await prisma.marketSnapshot.count();
    const again = await app!.get(IngestionService).backfillHistory(new Date("2026-11-03T16:00:00Z"), result.runId!, NOW);
    expect(again).toMatchObject({ needed: 0, attempted: 0 });
    expect(await prisma.marketSnapshot.count()).toBe(count);
    expect(await prisma.featureValue.count()).toBeGreaterThan(0);
    expect((await prisma.provider.findUniqueOrThrow({ where: { id: "coinmarketcap_web" } })).accessMethod).toBe("website");
    expect(await prisma.asset.count({ where: { isBenchmark: true } })).toBe(2);
  });

  it("explains startup and warming-up states instead of returning an unexplained empty panel", async () => {
    const { prisma } = await setup({ SOURCE_HISTORY_BOOTSTRAP_MAX_ASSETS: "0" });
    const read = app!.get(ReadModelService);
    expect((await read.signals({ limit: 50 })).readiness).toMatchObject({ state: "waiting" });
    const result = await app!.get(PipelineService).runSlot(new Date("2026-11-03T16:00:00Z"));
    const response = await read.signals({ limit: 50 });
    expect(response.runId).toBe(result.runId);
    expect(response.signals).toEqual([]);
    // All three listed coins are collected; CMC20 ($4.47M cap) is below the $5M floor, so it is
    // counted as outside the strategy universe instead of getting a screening row.
    expect(await prisma.marketSnapshot.count({ where: { slotTime: new Date("2026-11-03T16:00:00Z") } })).toBe(3);
    expect(response.readiness).toMatchObject({ state: "warming_up", requiredSnapshots: 3, observed: 3, outside: 1, warming: 2, eligible: 0 });
    const run = await prisma.pipelineRun.findUniqueOrThrow({ where: { id: result.runId! } });
    expect(run.metrics).toMatchObject({ observed: 3, outsideUniverse: 1, outsideReasons: { below_min_market_cap: 1 }, screened: 2 });
    const screened = (await read.screening({ eligibleOnly: false, limit: 100 })).results as Array<{ asset: { symbol: string }; exclusionReasons: string[] }>;
    expect(screened.map((r) => r.asset.symbol).sort()).toEqual(["BTC", "ETH"]);
    expect(screened.every((r) => r.exclusionReasons.includes("warming_up") && r.exclusionReasons.includes("benchmark_reference"))).toBe(true);
    const outside = (await read.market({ sort: "market_cap", dir: "desc", scope: "outside", limit: 10, offset: 0 })).coins as Array<{ asset: { symbol: string }; strategy: { inUniverse: boolean; reasons: string[] } }>;
    expect(outside).toHaveLength(1);
    expect(outside[0]).toMatchObject({ asset: { symbol: "CMC20" }, strategy: { inUniverse: false, reasons: ["below_min_market_cap"] } });
  });

  it("selects a run for the panel once its strategy screen succeeded, while agents are still running", async () => {
    const { prisma } = await setup();
    await prisma.provider.create({ data: { id: "coinmarketcap_web", name: "web", accessMethod: "website", isLive: true } });
    const run = await prisma.pipelineRun.create({ data: { kind: "hourly", providerId: "coinmarketcap_web", slotTime: NOW, startedAt: NOW, status: "running", currentStage: "analyze", isLiveData: true, stages: { create: { stage: "screen", status: "succeeded", startedAt: NOW } } } });
    const read = app!.get(ReadModelService);
    expect(await read.latestRunId()).toBe(run.id);
    expect((await read.signals({ limit: 50 })).readiness).toMatchObject({ state: "running", stage: "analyze", runId: run.id });
    // Before the screen succeeds nothing is selected, and a run with no live lease shows as interrupted.
    await prisma.pipelineStage.updateMany({ where: { runId: run.id }, data: { status: "running" } });
    expect(await read.latestRunId()).toBeNull();
    expect((await read.overview()).latestRun).toMatchObject({ status: "interrupted" });
    await prisma.provider.create({ data: { id: "fixture", name: "fixture", accessMethod: "fixture", isLive: false } });
    await prisma.pipelineRun.create({ data: { kind: "hourly", providerId: "fixture", slotTime: NOW, startedAt: NOW, status: "succeeded", isLiveData: false } });
    expect(await read.runs(10)).toHaveLength(1);
  });
});
