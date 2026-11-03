import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisService } from "../../src/agents/analysis.service.js";
import { addHours, slotOf } from "../../src/common/time.js";
import { IngestionService } from "../../src/ingestion/ingestion.service.js";
import { LeaseService } from "../../src/pipeline/lease.service.js";
import { PIPELINE_LEASE, PipelineService } from "../../src/pipeline/pipeline.service.js";
import { makeApp, resetDb } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof makeApp>>;

beforeEach(async () => {
  ctx = await makeApp();
  await resetDb(ctx.prisma);
});
afterEach(async () => ctx.app.close());

async function seed(hours: number) {
  const ing = ctx.app.get(IngestionService);
  await ing.discover(new Date());
  const cur = slotOf(new Date());
  for (let h = hours; h >= 1; h--) await ing.collect(addHours(cur, -h), null, new Date(), { fixtureBackfill: true });
}

describe("hourly pipeline", () => {
  it("runs end to end, persists signals and a dry-run Telegram report, and skips a completed slot", async () => {
    await seed(30);
    const p = ctx.app.get(PipelineService);
    const r = await p.runSlot();
    expect(["succeeded", "partial"]).toContain(r.status);
    expect(Object.values(r.stages).every((s) => s === "succeeded")).toBe(true);
    const run = await ctx.prisma.pipelineRun.findUniqueOrThrow({ where: { id: r.runId! } });
    expect(run.isLiveData).toBe(false);
    expect(await ctx.prisma.screeningResult.count({ where: { runId: r.runId! } })).toBeGreaterThan(20);
    const signals = await ctx.prisma.signal.findMany({ where: { runId: r.runId! } });
    for (const s of signals) {
      expect(s.calibratedProbability).toBeNull();
      expect(["agent", "fixture_agent", "deterministic"]).toContain(s.origin);
    }
    const deliveries = await ctx.prisma.telegramDelivery.findMany({ where: { runId: r.runId! } });
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.every((d) => d.status === "dry_run")).toBe(true);
    expect(deliveries[0]!.text).toMatch(/FIXTURE \/ SYNTHETIC DATA/);

    const again = await p.runSlot();
    expect(again.status).toBe("skipped");
    expect(again.reason).toMatch(/already completed/);
  });

  it("does not overlap: a run is skipped while another instance holds the lease", async () => {
    const lease = ctx.app.get(LeaseService);
    expect(await lease.acquire(PIPELINE_LEASE, "other-instance", 60_000)).toBe(true);
    expect(await lease.acquire(PIPELINE_LEASE, "third-instance", 60_000)).toBe(false);
    const r = await ctx.app.get(PipelineService).runSlot();
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/lease/);
    await lease.release(PIPELINE_LEASE, "other-instance");
    expect(await lease.acquire(PIPELINE_LEASE, "third-instance", 1)).toBe(true);
    await new Promise((res) => setTimeout(res, 20));
    expect(await lease.acquire(PIPELINE_LEASE, "fourth-instance", 60_000)).toBe(true); // expired lease can be taken
  });

  it("recovers after a failure without repeating completed stages", async () => {
    await seed(5);
    const p = ctx.app.get(PipelineService);
    const analysis = ctx.app.get(AnalysisService);
    const spy = vi.spyOn(analysis, "analyze").mockRejectedValueOnce(new Error("simulated crash during analysis"));
    const failed = await p.runSlot();
    expect(failed.status).toBe("failed");
    expect(failed.stages.analyze).toMatch(/failed/);
    const collected = await ctx.prisma.marketSnapshot.count();

    const resumed = await p.runSlot();
    expect(["succeeded", "partial"]).toContain(resumed.status);
    expect(resumed.runId).toBe(failed.runId);
    expect(resumed.stages.collect).toMatch(/skipped/);
    expect(resumed.stages.analyze).toBe("succeeded");
    expect(await ctx.prisma.marketSnapshot.count()).toBe(collected);
    expect((await ctx.prisma.pipelineRun.findUniqueOrThrow({ where: { id: failed.runId! } })).attempt).toBe(2);
    spy.mockRestore();
  });

  it("records missed hours on restart instead of inventing data", async () => {
    await ctx.app.close();
    ctx = await makeApp({ MISSED_RUN_POLICY: "skip" });
    const cur = slotOf(new Date());
    await ctx.prisma.provider.create({ data: { id: "fixture", name: "f", accessMethod: "fixture", isLive: false } });
    await ctx.prisma.pipelineRun.create({ data: { kind: "hourly", slotTime: addHours(cur, -4), providerId: "fixture", status: "succeeded", startedAt: new Date(), isLiveData: false } });
    const r = await ctx.app.get(PipelineService).recoverOnStartup();
    expect(r.missedRecorded).toBe(3);
    expect(await ctx.prisma.pipelineRun.count({ where: { status: "missed" } })).toBe(3);
    expect(await ctx.prisma.marketSnapshot.count()).toBe(0);
  });

  it("keeps history across application restarts", async () => {
    await seed(3);
    const before = await ctx.prisma.marketSnapshot.count();
    await ctx.app.close();
    ctx = await makeApp();
    expect(await ctx.prisma.marketSnapshot.count()).toBe(before);
    expect(before).toBeGreaterThan(0);
  });
});
