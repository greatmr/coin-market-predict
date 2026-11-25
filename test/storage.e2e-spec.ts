import { In } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DAY_MS } from '../src/common/utils/dates.js';
import { D } from '../src/common/utils/decimal.js';
import { addHours, slotOf } from '../src/common/utils/time.js';
import { AppStateService } from '../src/modules/app-state/app-state.service.js';
import { ForwardEvent } from '../src/modules/forward-test/entities/forward-event.entity.js';
import { ForwardOutcome } from '../src/modules/forward-test/entities/forward-outcome.entity.js';
import { ForwardTestService } from '../src/modules/forward-test/forward-test.service.js';
import { Asset } from '../src/modules/ingestion/entities/asset.entity.js';
import { CrawlBatch } from '../src/modules/ingestion/entities/crawl-batch.entity.js';
import { MarketSnapshot } from '../src/modules/ingestion/entities/market-snapshot.entity.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';
import { PipelineService } from '../src/modules/pipeline/pipeline.service.js';
import {
  type PruneReport,
  RetentionService,
  prunedUntilKey,
  utcDayStart,
} from '../src/modules/pipeline/retention.service.js';
import { ReadModelService } from '../src/modules/read-model/read-model.service.js';
import { StorageReportService } from '../src/modules/read-model/storage-report.service.js';
import { ScanResult } from '../src/modules/scan/entities/scan-result.entity.js';
import { ScanService } from '../src/modules/scan/scan.service.js';

import { makeApp, resetDb } from './utils/helpers.js';

/**
 * Storage scope (operator decision D4, ADR-0008) on the SYNTHETIC fixture market: every coin is
 * still screened each hour, only the Review Queue is stored, coins can move into it in a later hour,
 * missing or ambiguous data never becomes a signal, and the one-time cleanup keeps everything the
 * strategy and the forward test need. Nothing here is real market data.
 */
let ctx: Awaited<ReturnType<typeof makeApp>>;
const P = 'fixture';
const C = {
  ZERO: 990002, // eligible, 0 stars by design (current 0.05 against a 0.10 baseline)
  AMB: 990004, // ambiguous LBank mapping: NEEDS_REVIEW with a 3× VMC surge
  TWIN_A: 990005, // ticker on two CMC ids: NEEDS_REVIEW with a 2.2× surge
  WRPX: 990014, // wrapped (class ambiguous): NEEDS_REVIEW with a 2.5× surge
  NORK: 990021, // no CMC rank
  R100: 990025, // rank 100: EXCLUDED with a 4× surge
  R101: 990026, // rank 101, eligible, 0 stars: its cap becomes unverifiable below
  R1201: 990028, // rank 1201 with a 4× surge: never stored
  BTC: 990101,
  ETH: 990102,
};
const FAIL_CLOSED = [C.AMB, C.TWIN_A, C.WRPX, C.NORK, C.R100, C.R101, C.R1201];

const now = slotOf(new Date());
const earlier = addHours(now, -1);
let b1: string;
let b2: string;

const scan = () => ctx.app.get(ScanService);
const snapshotOf = (cmcId: number, slotTime: Date) =>
  ctx.repo(MarketSnapshot).findOneByOrFail({ providerAssetId: String(cmcId), slotTime });

beforeAll(async () => {
  ctx = await makeApp({ TIER1_VENUE_MAX_ASSETS_PER_RUN: '500' });
  await resetDb(ctx.db);
}, 60_000);
afterAll(async () => ctx.app.close());

describe('a coin moves into the Review Queue in a later hour', () => {
  it('hour 1: a 0-star eligible coin is screened and counted, but leaves no row and no event', async () => {
    const r1 = await ctx.app.get(PipelineService).runSlot(earlier);
    expect(r1.status, JSON.stringify(r1)).not.toBe('failed');
    b1 = r1.batchId!;
    const [z] = await scan().evaluateCoins(b1, [C.ZERO]);
    expect([z!.eligibilityStatus, z!.stars, z!.pass3d, z!.pass7d, z!.pass30d]).toEqual([
      'ELIGIBLE',
      0,
      'NO',
      'NO',
      'NO',
    ]);
    expect(await ctx.repo(ScanResult).countBy({ batchId: b1, cmcId: C.ZERO })).toBe(0);
    expect(await ctx.repo(ForwardEvent).countBy({ cmcId: C.ZERO })).toBe(0);
    // Its snapshot (input of the hour) and its daily baseline are kept for the next comparison.
    expect((await snapshotOf(C.ZERO, earlier)).rank).toBe(151);
  });

  it('hour 2: its rolling-24h volume surges, so the same rules store it as a 3-star queue row and open a forward-test event', async () => {
    // The listing of the next hour: ZERO's volume jumps to 0.30 × cap (3× its 0.10 baseline), and
    // R101's cap is no longer provider-reported (missing input) while its volume surges too.
    await ctx.app.get(IngestionService).collect(now, null, new Date());
    const zero = await snapshotOf(C.ZERO, now);
    await ctx
      .repo(MarketSnapshot)
      .update(
        { id: zero.id },
        { volumeRolling24h: new D(zero.marketCap!.toString()).times('0.30').toFixed() },
      );
    const r101 = await snapshotOf(C.R101, now);
    await ctx.repo(MarketSnapshot).update(
      { id: r101.id },
      {
        volumeRolling24h: new D(r101.marketCap!.toString()).times('0.50').toFixed(),
        marketCapProvenance: 'calculated_from_circulating_supply',
      },
    );

    const r2 = await ctx.app.get(PipelineService).runSlot(now);
    expect(r2.stages.forward, JSON.stringify(r2)).toBe('succeeded');
    b2 = r2.batchId!;
    const row = await ctx.repo(ScanResult).findOneByOrFail({ batchId: b2, cmcId: C.ZERO });
    expect([
      row.eligibilityStatus,
      row.stars,
      row.pass3d,
      row.pass7d,
      row.pass30d,
      row.inQueue,
      row.weightedPassPoints,
      row.scoreComplete,
    ]).toEqual(['ELIGIBLE', 3, 'YES', 'YES', 'YES', true, 100, true]);
    // The queue keeps its order: stars first, then weighted points (60 / 25 / 15).
    const queue = await ctx
      .repo(ScanResult)
      .find({ where: { batchId: b2, inQueue: true }, order: { queueOrder: 'ASC' } });
    for (let i = 1; i < queue.length; i++) {
      const [a, b] = [queue[i - 1]!, queue[i]!];
      expect(b.stars <= a.stars).toBe(true);
      if (b.stars === a.stars) expect(b.weightedPassPoints! <= a.weightedPassPoints!).toBe(true);
    }
    expect(queue.some((q) => q.stars === 1)).toBe(true); // 1-star coins stay in the queue
    // Everything needed to inspect the qualifying result is stored with it.
    expect(row.dailyWindow!.revisionIds).toHaveLength(30);
    expect(row.inputsHash).toMatch(/^[0-9a-f]{32}$/);
    const trace = (await ctx.app.get(ReadModelService).assetTrace(C.ZERO, b2)) as {
      evaluation: { mode: string };
      daily: { used: unknown[] };
      current: { snapshot: { id: number } | null };
    };
    expect(trace.evaluation.mode).toBe('stored');
    expect(trace.daily.used).toHaveLength(30);
    expect(trace.current.snapshot).not.toBeNull();

    // The forward test picked it up from this hour's publication, with its detection snapshot.
    const ev = await ctx.repo(ForwardEvent).findOneByOrFail({ cmcId: C.ZERO });
    expect([ev.starCount, ev.sourceBatchId, String(ev.snapshotId), ev.status]).toEqual([
      3,
      b2,
      String(zero.id),
      'OPEN',
    ]);
    expect(ev.snapshotPriceUsd.toFixed()).toBe(row.priceUsd!.toFixed());
  });

  it('missing or ambiguous data, an excluded coin and coins outside ranks 1–1200 never become a signal', async () => {
    expect(await ctx.repo(ScanResult).countBy({ cmcId: In(FAIL_CLOSED) })).toBe(0);
    expect(await ctx.repo(ForwardEvent).countBy({ cmcId: In(FAIL_CLOSED) })).toBe(0);
    const byId = new Map(
      (await scan().evaluateCoins(b2, FAIL_CLOSED)).map((r) => [r.cmcId, r] as const),
    );
    for (const id of [C.AMB, C.TWIN_A, C.WRPX, C.R101]) {
      const r = byId.get(id)!;
      expect([r.eligibilityStatus, r.stars, r.inQueue, r.pass3d, r.reason3d]).toEqual([
        'NEEDS_REVIEW',
        0,
        false,
        'N/A',
        'NOT_EVALUATED_NEEDS_REVIEW',
      ]);
    }
    expect(byId.get(C.R101)!.eligibilityReasons).toContain('MARKET_CAP_MISSING');
    expect([byId.get(C.R100)!.eligibilityStatus, byId.get(C.R100)!.stars]).toEqual(['EXCLUDED', 0]);
    // Outside ranks 1–1200: read and counted, no snapshot, nothing to evaluate.
    expect(byId.has(C.R1201)).toBe(false);
    expect(byId.has(C.NORK)).toBe(false);
    const counts = (await ctx.app.get(ReadModelService).overview()) as {
      scan: { counts: Record<string, number> };
    };
    expect(counts.scan.counts).toMatchObject({
      assets: 1301,
      screened: 1200,
      outsideUniverse: 101,
    });
  });
});

describe('storage cleanup keeps what the strategy and the forward test need', () => {
  let report: PruneReport;
  const legacy = { scanRows: 0, snapshots: 0 };

  it('earlier-policy rows block hourly retention until the operator prunes them', async () => {
    // A fresh database opened the gate at the first run (nothing to clean). Simulate a database
    // upgraded from the earlier policy instead: no gate yet, and rows as that policy stored them
    // for hour 1 (a non-queue result and a rank-1201 snapshot).
    expect(await ctx.app.get(AppStateService).get(prunedUntilKey(P))).toBeDefined();
    await ctx.db.query(`DELETE FROM app_state WHERE key = $1`, [prunedUntilKey(P)]);
    const [zero] = await scan().evaluateCoins(b1, [C.ZERO]);
    await ctx.repo(ScanResult).insert({ ...zero!, computedAt: new Date() } as never);
    const nolb = (await scan().evaluateCoins(b1, [990010]))[0]!;
    await ctx.repo(ScanResult).insert({ ...nolb, computedAt: new Date() } as never);
    legacy.scanRows = 2;
    const template = await snapshotOf(C.ZERO, earlier);
    const r1201 = await ctx.repo(Asset).findOneByOrFail({ symbol: 'R1201' });
    const { id: _id, ...copy } = template;
    await ctx.repo(MarketSnapshot).insert({
      ...copy,
      assetId: r1201.id,
      providerAssetId: String(C.R1201),
      rank: 1201,
    } as never);
    legacy.snapshots = 1;

    const before = await ctx.repo(MarketSnapshot).count();
    const r = await ctx.app.get(RetentionService).apply(P, new Date(now.getTime() + 30 * DAY_MS));
    expect([r.legacyPending, r.prunedSnapshots, r.deletedSnapshots]).toEqual([true, 0, 0]);
    expect(await ctx.repo(MarketSnapshot).count()).toBe(before);
    expect(await ctx.app.get(AppStateService).get(prunedUntilKey(P))).toBeUndefined();
  });

  it('a dry run counts and deletes nothing; --apply removes only earlier-policy rows', async () => {
    const pipeline = ctx.app.get(PipelineService);
    const snaps = await ctx.repo(MarketSnapshot).count();
    const rows = await ctx.repo(ScanResult).count();
    const dry = await pipeline.pruneStorage({ apply: false });
    if ('skipped' in dry) throw new Error(dry.skipped);
    expect(dry.mode).toBe('dry_run');
    expect(dry.scanRows.delete).toBe(legacy.scanRows);
    expect(dry.snapshots.deleteOutsideUniverse).toBe(legacy.snapshots);
    expect(dry.snapshots.deletePastDetailWindow).toBe(0); // both hours are inside 7 days
    expect([await ctx.repo(MarketSnapshot).count(), await ctx.repo(ScanResult).count()]).toEqual([
      snaps,
      rows,
    ]);

    const applied = await pipeline.pruneStorage({ apply: true });
    if ('skipped' in applied) throw new Error(applied.skipped);
    report = applied;
    expect(report.mode).toBe('applied');
    expect(await ctx.repo(ScanResult).countBy({ inQueue: false })).toBe(0);
    expect(await ctx.repo(ScanResult).count()).toBe(rows - legacy.scanRows);
    expect(await ctx.repo(MarketSnapshot).count()).toBe(snaps - legacy.snapshots);
    expect(report.after!.scan_result.rows).toBe(rows - legacy.scanRows);
    // Every forward-test event still has its detection snapshot.
    const events = await ctx.repo(ForwardEvent).find();
    const linked = await ctx.repo(MarketSnapshot).countBy({
      id: In(events.map((e) => String(e.snapshotId))),
    });
    expect(linked).toBe(events.length);
    expect(await ctx.app.get(AppStateService).get(prunedUntilKey(P))).toBe(report.detailCutoff);
    expect((await ctx.app.get(RetentionService).apply(P, new Date())).legacyPending).toBe(false);
  });

  it('past the detail window an hour keeps only its queue inputs, forward-test snapshots and the benchmarks', async () => {
    const retention = ctx.app.get(RetentionService);
    const queue = await ctx.repo(ScanResult).findBy({ batchId: b2, inQueue: true });
    const deleted = await retention.pruneSnapshotDay(P, utcDayStart(now));
    expect(deleted).toBeGreaterThan(0);
    const left = await ctx.repo(MarketSnapshot).findBy({ slotTime: now });
    const ids = new Set(left.map((s) => Number(s.providerAssetId)));
    for (const q of queue) expect(ids.has(q.cmcId)).toBe(true);
    expect(ids.has(C.BTC) && ids.has(C.ETH)).toBe(true);
    expect(ids.has(C.AMB)).toBe(false); // screened in that hour, never selected
    expect(left.length).toBe(queue.length + 2);
    // The batch record and the coin registry stay: the coins can come back any hour.
    expect(await ctx.repo(CrawlBatch).countBy({ id: b2 })).toBe(1);
    expect(await ctx.repo(Asset).countBy({ symbol: 'AMB' })).toBe(1);
  });

  it('existing forward-test events keep updating and finish normally after the cleanup', async () => {
    const fwd = ctx.app.get(ForwardTestService);
    const events = await ctx.repo(ForwardEvent).find();
    expect(events.length).toBeGreaterThan(0);
    const nextDay = new Date(events[0]!.detectedAt.getTime() + DAY_MS);
    const u1 = await fwd.update(P, { now: nextDay, trigger: 'manual' });
    expect('status' in u1.update && u1.update.status).toBe('succeeded');
    expect(await ctx.repo(ForwardOutcome).count()).toBe(events.length);
    expect(new Set((await ctx.repo(ForwardEvent).find()).map((e) => e.status))).toEqual(
      new Set(['TRACKING']),
    );
    const end = new Date(Math.max(...events.map((e) => e.evaluationEnd.getTime())) + 3_600_000);
    const u2 = await fwd.update(P, { now: end, trigger: 'manual' });
    expect('status' in u2.update && u2.update.status).toBe('succeeded');
    const done = await ctx.repo(ForwardEvent).find();
    expect(done.every((e) => e.status === 'FINAL' || e.status === 'INCOMPLETE')).toBe(true);
    // The detection data is immutable: price, stars and snapshot link are exactly as captured.
    for (const e of done) {
      const was = events.find((x) => x.id === e.id)!;
      expect([e.snapshotPriceUsd.toFixed(), e.starCount, String(e.snapshotId)]).toEqual([
        was.snapshotPriceUsd.toFixed(),
        was.starCount,
        String(was.snapshotId),
      ]);
    }
  });
});

describe('storage report (Data page)', () => {
  it('reports the database size and every table, largest first, from catalog sizes', async () => {
    const r = await ctx.app.get(StorageReportService).report();
    expect(r.databaseBytes).toBeGreaterThan(0);
    const names = r.tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['market_snapshot', 'scan_result', 'lbank_spot_candle']),
    );
    const totals = r.tables.map((t) => t.totalBytes);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    for (const t of r.tables)
      expect(t.totalBytes).toBeGreaterThanOrEqual(t.tableBytes + t.indexBytes);
    expect(r.tables.reduce((s, t) => s + t.totalBytes, 0)).toBeLessThanOrEqual(r.databaseBytes);
    expect(r.retention).toMatchObject({
      detailDays: expect.any(Number),
      candleDays: expect.any(Number),
    });
  });
});
