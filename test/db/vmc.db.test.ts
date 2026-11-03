import { afterEach, describe, expect, it } from "vitest";
import { LeaseService } from "../../src/pipeline/lease.service.js";
import { fixtureFetch } from "../../src/vmc/cmc-fixture.js";
import { VmcService } from "../../src/vmc/vmc.service.js";
import { makeApp, resetDb } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof makeApp>> | null = null;
afterEach(async () => {
  await ctx?.app.close();
  ctx = null;
});

const NOW = new Date("2026-11-03T14:20:00Z");

async function setup(env: Record<string, string> = {}) {
  ctx = await makeApp({ VMC_ASSET_IDS: "1,1027,2", VMC_SOURCE: "fixture", ...env });
  await resetDb(ctx.prisma);
  const vmc = ctx.app.get(VmcService);
  let now = NOW;
  vmc.now = () => now;
  return { vmc, prisma: ctx.prisma, setNow: (d: Date) => (now = d) };
}

/** Wrap the fixture transport to rewrite JSON bodies per endpoint. */
function rewriting(base: typeof fetch, edit: (path: string, body: Record<string, unknown>, url: URL) => Record<string, unknown> | Response): typeof fetch {
  return (async (input: string, init?: RequestInit) => {
    const res = await base(input, init);
    const url = new URL(input);
    const out = edit(url.pathname, (await res.json()) as Record<string, unknown>, url);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: res.status });
  }) as unknown as typeof fetch;
}

describe("volume / market cap collection (fixture transport, real CMC ids)", () => {
  it("runs the full workflow and produces a complete comparison", async () => {
    const { vmc, prisma } = await setup();
    for (const job of [() => vmc.syncAssets(), () => vmc.dailyHistory(), () => vmc.baseline(), () => vmc.hourlyBackfill(), () => vmc.hourly()]) {
      expect((await job()).status).toBe("succeeded");
    }
    const c = await vmc.comparison();
    expect(c.isFixture).toBe(true);
    expect(c.rows.map((r) => [r.cmcId, r.symbol])).toEqual([[1, "BTC"], [1027, "ETH"], [2, "LTC"]]);
    for (const r of c.rows) {
      expect(r.dataStatus).toEqual(["ok"]);
      expect(r.baselineCoverage).toMatch(/^184\/184d/);
      expect(r.ratioToBaseline).toMatch(/x$/);
    }
    // Raw payloads are stored and labeled as fixture.
    expect(await prisma.vmcRawResponse.count({ where: { isFixture: true } })).toBeGreaterThan(5);
    const b = await prisma.vmcBaseline.findFirstOrThrow({ where: { cmcId: 2 }, include: { members: true } });
    expect(b.members).toHaveLength(184);
    expect(b.formulaVersion).toMatch(/mean\(volume_d \/ market_cap_d\)/);
  });

  it("deduplicates retried hourly runs: one effective snapshot per asset per UTC hour", async () => {
    const { vmc, prisma } = await setup();
    await vmc.syncAssets();
    await vmc.hourly();
    const n1 = await prisma.vmcHourlySnapshot.count();
    const again = await vmc.hourly();
    expect(Object.values(again.assets).every((s) => s === "ok")).toBe(true);
    expect(await prisma.vmcHourlySnapshot.count()).toBe(n1); // identical observation → unchanged
    expect(await prisma.vmcHourlyCurrent.count()).toBe(3);
  });

  it("stores a corrected source observation as a new revision and keeps the old one", async () => {
    const { vmc, prisma } = await setup();
    await vmc.syncAssets();
    await vmc.hourly();
    vmc.fetchImpl = rewriting(fixtureFetch(() => NOW), (path, body) => {
      if (path === "/v3/cryptocurrency/quotes/latest") for (const item of body.data as Array<{ quote: Array<{ volume_24h: number }> }>) item.quote[0]!.volume_24h *= 2;
      return body;
    });
    await vmc.hourly();
    const btc = await prisma.vmcHourlySnapshot.findMany({ where: { cmcId: 1 }, orderBy: { revision: "asc" } });
    expect(btc.map((s) => [s.revision, s.revisionReason])).toEqual([[1, "first"], [2, "source_revision"]]);
    const cur = await prisma.vmcHourlyCurrent.findFirstOrThrow({ where: { cmcId: 1 } });
    expect(cur.snapshotId).toBe(btc[1]!.id);
  });

  it("recalculates the baseline weekly as a new auditable version when daily data is corrected", async () => {
    const { vmc, prisma } = await setup();
    await vmc.syncAssets();
    await vmc.weekly();
    expect((await vmc.weekly())[1]!.assets).toEqual({ 1: "ok", 2: "ok", 1027: "ok" }); // unchanged → no new version
    expect(await prisma.vmcBaseline.count({ where: { cmcId: 2 } })).toBe(1);

    // CMC revises one recent day for Litecoin.
    vmc.fetchImpl = rewriting(fixtureFetch(() => NOW), (path, body, url) => {
      if (path === "/v3/cryptocurrency/quotes/historical" && url.searchParams.get("id") === "2") {
        const quotes = (body.data as Record<string, { quotes: Array<{ timestamp: string; quote: { USD: { volume_24h: number } } }> }>)["2"]!.quotes;
        quotes.find((q) => q.timestamp.startsWith("2026-11-01"))!.quote.USD.volume_24h = 999_000_000;
      }
      return body;
    });
    const [daily] = await vmc.weekly();
    expect((await prisma.vmcAssetResult.findFirstOrThrow({ where: { runId: daily!.runId!, cmcId: 2 } })).detail).toMatchObject({ revised: 1 });
    const versions = await prisma.vmcBaseline.findMany({ where: { cmcId: 2 }, orderBy: { version: "asc" } });
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[1]!.meanRatio!.greaterThan(versions[0]!.meanRatio!)).toBe(true);
    const day = await prisma.vmcDailyObservation.findMany({ where: { cmcId: 2, dateUtc: new Date("2026-10-31") } });
    expect(day.map((x) => x.revision)).toEqual([1, 2]);
  });

  it("never uses hourly snapshots for the baseline", async () => {
    const { vmc, prisma } = await setup();
    await vmc.syncAssets();
    await vmc.weekly();
    await vmc.hourlyBackfill();
    await vmc.hourly();
    const b = await prisma.vmcBaseline.findFirstOrThrow({ where: { cmcId: 1 }, include: { members: true } });
    const ids = b.members.map((m) => m.observationId);
    expect(await prisma.vmcDailyObservation.count({ where: { id: { in: ids } } })).toBe(ids.length);
    expect((await vmc.baseline()).assets[1]).toBe("ok");
    expect(await prisma.vmcBaseline.count({ where: { cmcId: 1 } })).toBe(1); // hourly data changed nothing
  });

  it("keeps successful assets when one is missing from a partial response", async () => {
    const { vmc, prisma } = await setup();
    await vmc.syncAssets();
    vmc.fetchImpl = rewriting(fixtureFetch(() => NOW), (path, body) => {
      if (path === "/v3/cryptocurrency/quotes/latest") body.data = (body.data as Array<{ id: number }>).filter((x) => x.id !== 1027);
      return body;
    });
    const r = await vmc.hourly();
    expect(r.status).toBe("partial");
    expect(r.assets).toEqual({ 1: "ok", 2: "ok", 1027: "failed" });
    expect(await prisma.vmcHourlyCurrent.count()).toBe(2);
  });

  it("degrades gracefully when the plan lacks hourly history, without retrying", async () => {
    const { vmc, prisma } = await setup();
    await vmc.syncAssets();
    vmc.fetchImpl = rewriting(fixtureFetch(() => NOW), (path, body, url) =>
      path === "/v3/cryptocurrency/quotes/historical" && url.searchParams.get("interval") === "hourly"
        ? new Response(JSON.stringify({ status: { error_code: 1006, error_message: "plan does not support", credit_count: 0 } }), { status: 403 })
        : body,
    );
    const r = await vmc.hourlyBackfill();
    expect(r.status).toBe("failed");
    expect(Object.values(r.assets).sort()).toEqual(["failed", "skipped", "skipped"]);
    expect(await prisma.vmcRawResponse.count({ where: { httpStatus: 403 } })).toBe(1);
    await vmc.hourly();
    const c = await vmc.comparison();
    expect(c.rows[0]!.dataStatus).toEqual(expect.arrayContaining(["hourly_backfill_unavailable", "recent_window_incomplete_1/72h"]));
  });

  it("labels a younger asset's baseline as partial with its actual coverage", async () => {
    const { vmc, prisma } = await setup({ VMC_ASSET_IDS: "52" });
    const young = "2026-09-24T00:00:00.000Z";
    vmc.fetchImpl = rewriting(fixtureFetch(() => NOW), (path, body) => {
      if (path === "/v1/cryptocurrency/map") for (const e of body.data as Array<{ id: number; first_historical_data: string }>) if (e.id === 52) e.first_historical_data = young;
      if (path === "/v3/cryptocurrency/quotes/historical") {
        const entry = (body.data as Record<string, { quotes: Array<{ timestamp: string }> }>)["52"];
        if (entry) entry.quotes = entry.quotes.filter((q) => q.timestamp >= young);
      }
      return body;
    });
    await vmc.syncAssets();
    await vmc.weekly();
    const b = await prisma.vmcBaseline.findFirstOrThrow({ where: { cmcId: 52 } });
    expect(b.status).toBe("partial");
    expect(b.validDays).toBeLessThan(45);
    expect(b.statusReasons.join(" ")).toMatch(/history_starts_2026-09-24/);
    expect((await vmc.comparison()).rows[0]!.dataStatus).toContain("baseline_partial");
  });

  it("does not overlap with another instance running the same job", async () => {
    const { vmc } = await setup();
    const lease = ctx!.app.get(LeaseService);
    await lease.acquire("vmc:hourly", "other-instance", 60_000);
    expect((await vmc.hourly()).status).toBe("skipped");
  });

  it("never stores the CMC API key in raw responses or parameters", async () => {
    const key = "live-cmc-key-should-never-be-stored";
    const { vmc, prisma } = await setup({ VMC_SOURCE: "cmc", CMC_API_KEY: key });
    const seen: string[] = [];
    vmc.fetchImpl = (async (input: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)["X-CMC_PRO_API_KEY"]!);
      return fixtureFetch(() => NOW)(input, init);
    }) as unknown as typeof fetch;
    await vmc.syncAssets();
    await vmc.hourly();
    expect(seen.every((k) => k === key)).toBe(true);
    const raws = await prisma.vmcRawResponse.findMany();
    expect(JSON.stringify(raws)).not.toContain(key);
    expect(JSON.stringify(await prisma.vmcRun.findMany())).not.toContain(key);
  });
});

describe("manual CSV import (CMC Historical Data → Download CSV)", () => {
  it("feeds the ohlcv baseline, is idempotent on re-import, and records corrections as revisions", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(new URL("../fixtures/cmc-history-litecoin.csv", import.meta.url), "utf8");
    const { vmc, prisma } = await setup({ VMC_ASSET_IDS: "2", VMC_DAILY_CONVENTION: "ohlcv" });
    vmc.now = () => new Date("2026-11-03T15:00:00Z");
    await expect(vmc.importCsv({ cmcId: 2, text, fileName: "ltc.csv" })).resolves.toMatchObject({ status: "failed" }); // not registered, no --symbol
    const first = await vmc.importCsv({ cmcId: 2, text, fileName: "ltc.csv", symbol: "LTC", name: "Litecoin" });
    expect(first.status).toBe("succeeded"); // 12 contiguous valid days
    const d1 = (await prisma.vmcAssetResult.findFirstOrThrow({ where: { runId: first.runId! } })).detail as Record<string, number>;
    expect(d1).toMatchObject({ rows: 12, inserted: 12, skippedIncompleteDay: 1 });

    const again = await vmc.importCsv({ cmcId: 2, text, fileName: "ltc.csv" });
    expect((await prisma.vmcAssetResult.findFirstOrThrow({ where: { runId: again.runId! } })).detail).toMatchObject({ unchanged: 12, inserted: 0 });

    const corrected = text.replace("149922575", "150000000");
    const fix = await vmc.importCsv({ cmcId: 2, text: corrected, fileName: "ltc-corrected.csv" });
    expect((await prisma.vmcAssetResult.findFirstOrThrow({ where: { runId: fix.runId! } })).detail).toMatchObject({ revised: 1, unchanged: 11 });

    const b = await vmc.baseline();
    expect(b.assets[2]).toBe("partial"); // 12 of 184 days
    const base = await prisma.vmcBaseline.findFirstOrThrow({ where: { cmcId: 2 } });
    expect(base).toMatchObject({ validDays: 12, expectedDays: 184, convention: "ohlcv", status: "partial" });
    expect(await prisma.vmcRawResponse.count({ where: { endpoint: "manual_csv_import" } })).toBe(3);
  });
});
