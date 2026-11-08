import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addHours, slotOf } from '../src/common/utils/time.js';
import { DailyMetricRevision } from '../src/modules/daily-metrics/entities/daily-metric-revision.entity.js';
import { CrawlBatch } from '../src/modules/ingestion/entities/crawl-batch.entity.js';
import { MarketSnapshot } from '../src/modules/ingestion/entities/market-snapshot.entity.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';
import { PipelineRun } from '../src/modules/pipeline/entities/pipeline-run.entity.js';
import { LeaseService } from '../src/modules/pipeline/lease.service.js';
import { PIPELINE_LEASE, PipelineService } from '../src/modules/pipeline/pipeline.service.js';
import { ReadModelService } from '../src/modules/read-model/read-model.service.js';
import { ScanResult } from '../src/modules/scan/entities/scan-result.entity.js';
import { ScanService } from '../src/modules/scan/scan.service.js';
import { Provider } from '../src/modules/sources/entities/provider.entity.js';
import { SourceHealthService } from '../src/modules/sources/source-health.service.js';
import { TelegramDelivery } from '../src/modules/telegram/entities/telegram-delivery.entity.js';

import { makeApp, resetDb } from './utils/helpers.js';

let ctx: Awaited<ReturnType<typeof makeApp>>;

beforeEach(async () => {
  ctx = await makeApp();
  await resetDb(ctx.db);
});
afterEach(async () => ctx.app.close());

describe('hourly pipeline', () => {
  it('runs end to end (collect → LBank → daily → scan → venues → export → notify) and skips a completed slot', async () => {
    const p = ctx.app.get(PipelineService);
    const r = await p.runSlot();
    expect(['succeeded', 'partial']).toContain(r.status);
    expect(Object.keys(r.stages)).toEqual([
      'discover',
      'collect',
      'lbank',
      'daily',
      'scan',
      'venues',
      'export',
      'notify',
    ]);
    expect(Object.values(r.stages).every((s) => s === 'succeeded')).toBe(true);
    const run = await ctx.repo(PipelineRun).findOneByOrFail({ id: r.runId! });
    expect(run.isLiveData).toBe(false);
    expect((run.metrics as { batchId?: string }).batchId).toBe(r.batchId);
    // Item progress is live state only: it is gone once the run has finished.
    expect(run.metrics).not.toHaveProperty('progress');
    const ov = (await ctx.app.get(ReadModelService).overview()) as {
      latestRun: { progress: unknown };
      schedule: { cron: string };
    };
    expect(ov.latestRun.progress).toBeNull();
    expect(ov.schedule.cron).toBeTruthy();
    expect(await ctx.repo(ScanResult).countBy({ batchId: r.batchId! })).toBeGreaterThan(1000);
    const deliveries = await ctx.repo(TelegramDelivery).findBy({ runId: r.runId! });
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.every((d) => d.status === 'dry_run')).toBe(true);

    const again = await p.runSlot();
    expect(again.status).toBe('skipped');
    expect(again.reason).toMatch(/already completed/);
  });

  it('does not overlap: a run is skipped while another instance holds the lease', async () => {
    const lease = ctx.app.get(LeaseService);
    expect(await lease.acquire(PIPELINE_LEASE, 'other-instance', 60_000)).toBe(true);
    expect(await lease.acquire(PIPELINE_LEASE, 'third-instance', 60_000)).toBe(false);
    const r = await ctx.app.get(PipelineService).runSlot();
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/lease/);
    expect((await ctx.app.get(PipelineService).reprocess()).skipped).toMatch(/lease/);
    await lease.release(PIPELINE_LEASE, 'other-instance');
    expect(await lease.acquire(PIPELINE_LEASE, 'third-instance', 1)).toBe(true);
    await new Promise((res) => setTimeout(res, 20));
    expect(await lease.acquire(PIPELINE_LEASE, 'fourth-instance', 60_000)).toBe(true); // expired lease can be taken
  });

  it('manual crawl retry closes an open circuit and crawls the current slot again', async () => {
    const p = ctx.app.get(PipelineService);
    const health = ctx.app.get(SourceHealthService);
    await ctx.app.get(IngestionService).ensureProvider();
    const opened = await health.load(p.providerId);
    await health.save(p.providerId, {
      ...opened,
      state: 'open',
      consecutiveFailures: 6,
      openedAt: new Date(),
    });
    const ov = (await ctx.app.get(ReadModelService).overview()) as {
      sourceHealth: { state: string; reopensAt: string | null };
    };
    expect(ov.sourceHealth.state).toBe('open');
    expect(ov.sourceHealth.reopensAt).toMatch(/^\d{4}-\d\d-\d\dT/);

    const r = await p.retryCrawl();
    if (!r.started) throw new Error(r.reason);
    expect(r.circuitReset).toBe(true);
    expect(r.slot).toBe(slotOf(new Date()).toISOString());
    const outcome = await r.done;
    expect(['succeeded', 'partial']).toContain(outcome.status);
    const after = await health.load(p.providerId);
    expect(after.state).toBe('closed');
    expect(after.consecutiveFailures).toBe(0);

    const again = await p.retryCrawl();
    expect(again).toMatchObject({
      started: false,
      reason: expect.stringMatching(/already completed/),
    });
  });

  it('manual crawl retry refuses a suspended source, an active Retry-After and a held lease', async () => {
    const p = ctx.app.get(PipelineService);
    const health = ctx.app.get(SourceHealthService);
    await ctx.app.get(IngestionService).ensureProvider();
    const base = await health.load(p.providerId);

    await health.save(p.providerId, { ...base, state: 'suspended', suspendedReason: 'HTTP 403' });
    expect(await p.retryCrawl()).toMatchObject({
      started: false,
      reason: expect.stringMatching(/suspended.*source:reset/),
    });
    expect((await health.load(p.providerId)).state).toBe('suspended');

    await health.save(p.providerId, {
      ...base,
      retryAfterUntil: new Date(Date.now() + 60_000),
    });
    expect(await p.retryCrawl()).toMatchObject({
      started: false,
      reason: expect.stringMatching(/asked us to wait/),
    });

    await health.save(p.providerId, base);
    const lease = ctx.app.get(LeaseService);
    expect(await lease.acquire(PIPELINE_LEASE, 'other-instance', 60_000)).toBe(true);
    expect(await p.retryCrawl()).toMatchObject({
      started: false,
      reason: expect.stringMatching(/lease/),
    });
    await lease.release(PIPELINE_LEASE, 'other-instance');
    expect(await ctx.repo(PipelineRun).count()).toBe(0);
  });

  it('recovers after a failure without repeating completed stages or re-crawling', async () => {
    const p = ctx.app.get(PipelineService);
    const spy = vi
      .spyOn(ctx.app.get(ScanService), 'scan')
      .mockRejectedValueOnce(new Error('simulated crash during the scan'));
    const failed = await p.runSlot();
    expect(failed.status).toBe('failed');
    expect(failed.stages.scan).toMatch(/failed/);
    const snapshots = await ctx.repo(MarketSnapshot).count();
    const daily = await ctx.repo(DailyMetricRevision).count();
    expect(snapshots).toBeGreaterThan(0);
    expect(daily).toBeGreaterThan(0);

    const resumed = await p.runSlot();
    expect(['succeeded', 'partial']).toContain(resumed.status);
    expect(resumed.runId).toBe(failed.runId);
    expect(resumed.stages.collect).toMatch(/skipped/);
    expect(resumed.stages.lbank).toMatch(/skipped/);
    expect(resumed.stages.daily).toMatch(/skipped/);
    expect(resumed.stages.scan).toBe('succeeded');
    expect(await ctx.repo(MarketSnapshot).count()).toBe(snapshots);
    expect(await ctx.repo(DailyMetricRevision).count()).toBe(daily);
    expect((await ctx.repo(PipelineRun).findOneByOrFail({ id: failed.runId! })).attempt).toBe(2);
    spy.mockRestore();
  });

  it('records missed hours on restart instead of inventing data', async () => {
    await ctx.app.close();
    ctx = await makeApp({ MISSED_RUN_POLICY: 'skip' });
    const cur = slotOf(new Date());
    await ctx
      .repo(Provider)
      .insert({ id: 'fixture', name: 'f', accessMethod: 'fixture', isLive: false });
    await ctx.repo(PipelineRun).insert({
      kind: 'hourly',
      slotTime: addHours(cur, -4),
      providerId: 'fixture',
      status: 'succeeded',
      startedAt: new Date(),
      isLiveData: false,
    });
    const r = await ctx.app.get(PipelineService).recoverOnStartup();
    expect(r.missedRecorded).toBe(3);
    expect(await ctx.repo(PipelineRun).countBy({ status: 'missed' })).toBe(3);
    expect(await ctx.repo(MarketSnapshot).count()).toBe(0);
    expect(await ctx.repo(CrawlBatch).count()).toBe(0);
  });

  it('keeps history across application restarts', async () => {
    await ctx.app.get(PipelineService).runSlot();
    const before = {
      snaps: await ctx.repo(MarketSnapshot).count(),
      results: await ctx.repo(ScanResult).count(),
    };
    await ctx.app.close();
    ctx = await makeApp();
    expect({
      snaps: await ctx.repo(MarketSnapshot).count(),
      results: await ctx.repo(ScanResult).count(),
    }).toEqual(before);
    expect(before.snaps).toBeGreaterThan(0);
  });
});
