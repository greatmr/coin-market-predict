import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DAY_MS } from '../src/common/utils/dates.js';
import { D } from '../src/common/utils/decimal.js';
import { slotOf } from '../src/common/utils/time.js';
import { DailyMetricsService } from '../src/modules/daily-metrics/daily-metrics.service.js';
import { ForwardEvent } from '../src/modules/forward-test/entities/forward-event.entity.js';
import { ForwardHigh } from '../src/modules/forward-test/entities/forward-high.entity.js';
import { ForwardOutcome } from '../src/modules/forward-test/entities/forward-outcome.entity.js';
import { ForwardTestWatchlist } from '../src/modules/forward-test/entities/forward-test-watchlist.entity.js';
import { ForwardTriggerRejection } from '../src/modules/forward-test/entities/forward-trigger-rejection.entity.js';
import { ForwardTriggerRun } from '../src/modules/forward-test/entities/forward-trigger-run.entity.js';
import { ForwardUpdateRun } from '../src/modules/forward-test/entities/forward-update-run.entity.js';
import {
  ForwardCaptureService,
  type TriggerBatch,
  type TriggerRow,
} from '../src/modules/forward-test/forward-capture.service.js';
import { ForwardExportService } from '../src/modules/forward-test/forward-export.service.js';
import { ForwardReadService } from '../src/modules/forward-test/forward-read.service.js';
import { ForwardTestService } from '../src/modules/forward-test/forward-test.service.js';
import { ForwardUpdateService } from '../src/modules/forward-test/forward-update.service.js';
import { CrawlBatch } from '../src/modules/ingestion/entities/crawl-batch.entity.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';
import { PipelineService } from '../src/modules/pipeline/pipeline.service.js';
import { ScanResult } from '../src/modules/scan/entities/scan-result.entity.js';
import type { DailySourceRow } from '../src/modules/sources/source.types.js';

import { makeApp, resetDb } from './utils/helpers.js';

/**
 * Star Event Forward Test against PostgreSQL (docs/forward-test.md): the PDF's acceptance cases
 * (p.11) through the real trigger, unique key, daily rows, update job and outcome versions. Every
 * value is SYNTHETIC test data.
 */
let ctx: Awaited<ReturnType<typeof makeApp>>;
const P = 'fixture';
const t = (s: string) => new Date(s);
const minutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);

beforeAll(async () => {
  ctx = await makeApp({ TIER1_EXPORT_DIR: 'var/test-exports-forward' });
});
afterAll(async () => {
  await ctx.app.close();
  rmSync('var/test-exports-forward', { recursive: true, force: true });
});
beforeEach(async () => {
  await resetDb(ctx.db);
  await ctx.app.get(IngestionService).ensureProvider();
});

const capture = () => ctx.app.get(ForwardCaptureService);
const updater = () => ctx.app.get(ForwardUpdateService);

/** A crawl batch row whose crawl time is `crawledAt` (the trigger only needs the batch to exist). */
async function batch(crawledAt: string, status: 'COMPLETE' | 'INCOMPLETE' = 'COMPLETE') {
  const at = t(crawledAt);
  const repo = ctx.repo(CrawlBatch);
  const b = await repo.save(
    repo.create({
      providerId: P,
      slotTime: slotOf(at),
      isLive: false,
      startedAt: at,
      finishedAt: at,
      crawledAt: at,
      status,
      statusReasons: [],
      listedTotal: 1,
      collected: 1,
      fieldCounts: {},
      missingRanks: [],
      duplicateRanks: [],
      errors: null,
      notes: [],
    }),
  );
  return {
    id: b.id,
    providerId: P,
    slotTime: b.slotTime,
    status,
    isLive: false,
  } satisfies TriggerBatch;
}

/** A published Review Queue row as the scanner would hand it over (synthetic values). */
function row(
  cmcId: number | null,
  stars: number,
  price: string | null,
  observedAt: string,
  over: Partial<TriggerRow> = {},
): TriggerRow {
  const at = t(observedAt);
  const yes = (n: number) => (stars >= n ? 'YES' : 'NO');
  return {
    cmcId,
    stars,
    inQueue: stars > 0,
    eligibilityStatus: 'ELIGIBLE',
    lbankStatus: 'VERIFIED',
    price: price === null ? null : new D(price),
    currentStatus: 'OK',
    sourceUpdatedAt: minutes(at, -2),
    observedAt: at,
    identityUnique: true,
    symbol: `T${cmcId ?? 0}`,
    name: 'Test Asset (synthetic)',
    slug: `t${cmcId ?? 0}`,
    rank: 150,
    snapshotId: null,
    platformChain: null,
    platformAddress: null,
    capUsd: new D('100000000'),
    volume24hUsd: new D('20000000'),
    currentVmc: new D('0.2'),
    vmc3dAvg: new D('0.1'),
    vmc7dAvg: new D('0.1'),
    vmc14dAvg: new D('0.1'),
    vmc30dAvg: new D('0.1'),
    multiple3d: new D('2'),
    multiple7d: new D('2'),
    multiple30d: new D('2'),
    pass3d: yes(1),
    pass7d: yes(2),
    pass30d: yes(3),
    queueOrder: 1,
    lbankPairs: [],
    rulesetVersion: 'vmc-tier1-1',
    configVersion: 'test',
    inputsHash: 'test',
    scanSnapshot: { synthetic: true, stars, price },
    ...over,
  };
}

/** Trigger one row from its own batch, a few minutes after the crawl (a live publication). */
async function sight(r: TriggerRow, opts: { status?: 'COMPLETE' | 'INCOMPLETE' } = {}) {
  const b = await batch(r.observedAt!.toISOString(), opts.status);
  const queue = opts.status === 'INCOMPLETE' ? 'WITHHELD_INCOMPLETE_BATCH' : 'PUBLISHED';
  return capture().capture(b, queue, [r], { now: minutes(r.observedAt!, 5) });
}

/** One completed UTC day of synthetic CMC USD daily OHLC. */
function day(cmcId: number, date: string, high: string, timeHigh: string | null): DailySourceRow {
  const start = t(`${date}T00:00:00.000Z`);
  const end = new Date(start.getTime() + DAY_MS - 1);
  return {
    cmcId,
    dateUtc: date,
    volume: '1000000',
    marketCap: '100000000',
    open: '10',
    high,
    low: '9',
    close: '10',
    timeHigh: timeHigh ? t(timeHigh) : null,
    timeLow: null,
    invalidReasons: [],
    periodStart: start,
    periodEnd: end,
    sourceCloseAt: end,
    sourceFields: { synthetic: true },
  };
}

const store = (rows: DailySourceRow[]) =>
  ctx.app.get(DailyMetricsService).upsertRows(P, rows, {
    source: 'fixture:daily',
    params: {},
    responseSha256: null,
    retrievedAt: new Date(),
    batchId: null,
  });

const update = (now: string) =>
  updater().update(P, { now: t(now), trigger: 'manual', fetch: false });

async function latestOutcome(eventId: string) {
  return ctx.repo(ForwardOutcome).findOneOrFail({
    where: { eventId },
    order: { resultVersion: 'DESC' },
  });
}

describe('trigger: the first observation per (asset, UTC date, stars) — PDF p.4, p.11', () => {
  it('the 10 Nov timeline creates exactly A, B and C with their first prices; reruns create none', async () => {
    const id = 123;
    const sightings = [
      row(id, 2, '10', '2026-11-10T10:00:00.000Z'), // A
      row(id, 2, '11', '2026-11-10T11:00:00.000Z'), // ignored: (123, 10 Nov, 2) exists
      row(id, 3, '12', '2026-11-10T15:00:00.000Z'), // B
      row(id, 2, '13', '2026-11-10T18:00:00.000Z'), // ignored: 2 -> 3 -> 2
      row(id, 2, '14', '2026-11-11T09:00:00.000Z'), // C: next UTC date, A still open
    ];
    const reports = [];
    for (const s of sightings) reports.push(await sight(s));
    expect(reports.map((r) => [r.created.length, r.ignored.length, r.rejected.length])).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
    ]);
    const events = await ctx.repo(ForwardEvent).find({ order: { detectedAt: 'ASC' } });
    expect(
      events.map((e) => [
        e.detectedUtcDate,
        e.starCount,
        e.snapshotPriceUsd.toFixed(),
        e.detectedAt.toISOString(),
        e.status,
      ]),
    ).toEqual([
      ['2026-11-10', 2, '10', '2026-11-10T10:00:00.000Z', 'OPEN'],
      ['2026-11-10', 3, '12', '2026-11-10T15:00:00.000Z', 'OPEN'],
      ['2026-11-11', 2, '14', '2026-11-11T09:00:00.000Z', 'OPEN'],
    ]);
    // An ignored sighting points at the event that keeps the first price.
    expect(reports[1]!.ignored[0]!.eventId).toBe(events[0]!.id);
    expect(events[0]!.deadline168h.toISOString()).toBe('2026-11-17T10:00:00.000Z');
    expect(events[0]!.evaluationEnd.toISOString()).toBe('2026-11-17T23:59:59.999Z');

    // Rerunning every scanner batch creates nothing and changes no price.
    const batches = await ctx.repo(CrawlBatch).find({ order: { crawledAt: 'ASC' } });
    for (const [i, b] of batches.entries()) {
      const r = await capture().capture(
        { id: b.id, providerId: P, slotTime: b.slotTime, status: 'COMPLETE', isLive: false },
        'PUBLISHED',
        [sightings[i]!],
        { now: minutes(b.crawledAt, 30) },
      );
      expect(r.created).toEqual([]);
    }
    expect(await ctx.repo(ForwardEvent).count()).toBe(3);
    expect(
      (await ctx.repo(ForwardEvent).find({ order: { detectedAt: 'ASC' } })).map((e) =>
        e.snapshotPriceUsd.toFixed(),
      ),
    ).toEqual(['10', '12', '14']);

    // One watchlist row for the asset, no approval step.
    const wl = await ctx.repo(ForwardTestWatchlist).find();
    expect(wl).toHaveLength(1);
    expect(wl[0]).toMatchObject({ cmcId: id, eventCount: 3, isLive: false });
    expect(wl[0]!.firstEventAt.toISOString()).toBe('2026-11-10T10:00:00.000Z');
    expect(wl[0]!.lastEventAt.toISOString()).toBe('2026-11-11T09:00:00.000Z');

    // The overlapping 2- and 3-star events are separate rows, marked as correlated.
    const rows = (
      await ctx.app.get(ForwardReadService).events({ view: 'all', limit: 10, offset: 0 })
    ).rows;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.assetEventCount === 3 && r.overlappingEventIds.length === 2)).toBe(
      true,
    );
  });

  it('concurrent workers cannot create a duplicate (atomic unique key)', async () => {
    const b = await batch('2026-11-12T08:00:00.000Z');
    const r = row(555, 3, '2.5', '2026-11-12T08:00:00.000Z');
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        capture().capture(b, 'PUBLISHED', [r], { now: t('2026-11-12T08:05:00.000Z') }),
      ),
    );
    expect(results.reduce((n, x) => n + x.created.length, 0)).toBe(1);
    expect(results.reduce((n, x) => n + x.ignored.length, 0)).toBe(3);
    expect(await ctx.repo(ForwardEvent).countBy({ cmcId: 555 })).toBe(1);
    expect((await ctx.repo(ForwardTestWatchlist).findOneByOrFail({ cmcId: 555 })).eventCount).toBe(
      1,
    );
  });

  it('a 0-star row, a stale quote, a missing CMC id and an asset outside the queue open no priced event; an eligible 1-star row does, automatically', async () => {
    const b = await batch('2026-11-10T10:00:00.000Z');
    const at = '2026-11-10T10:00:00.000Z';
    const r = await capture().capture(
      b,
      'PUBLISHED',
      [
        row(901, 0, '5', at),
        row(902, 2, '5', at, { currentStatus: 'STALE' }),
        row(null, 2, '5', at),
        row(904, 1, '5', at, { inQueue: false, eligibilityStatus: 'NEEDS_REVIEW' }),
        row(905, 2, '0', at),
        row(906, 1, '7.25', at), // eligible 1-star: no human step
      ],
      { now: t('2026-11-10T10:04:00.000Z') },
    );
    expect(r.created.map((c) => c.cmcId)).toEqual([906]);
    expect(r.rejected.map((x) => [x.cmcId, x.reasons])).toEqual([
      [901, ['NOT_IN_REVIEW_QUEUE', 'STARS_OUT_OF_RANGE:0']],
      [902, ['QUOTE_STALE']],
      [null, ['CMC_ID_MISSING']],
      [904, ['NOT_IN_REVIEW_QUEUE', 'NOT_ELIGIBLE:NEEDS_REVIEW']],
      [905, ['PRICE_NOT_POSITIVE']],
    ]);
    expect(await ctx.repo(ForwardEvent).count()).toBe(1);
    expect(await ctx.repo(ForwardTestWatchlist).count()).toBe(1);
    const stored = await ctx.repo(ForwardTriggerRejection).find({ order: { id: 'ASC' } });
    expect(stored).toHaveLength(5);
    // Observed values are kept as they were, never repaired.
    expect(stored.find((s) => s.cmcId === 905)!.observed).toMatchObject({ price: '0' });
    const run = await ctx.repo(ForwardTriggerRun).findOneByOrFail({ batchId: b.id });
    expect([run.queueRows, run.created, run.ignored, run.rejected]).toEqual([6, 1, 0, 5]);
  });

  it('a withheld queue (incomplete batch) and a replayed old batch open nothing, with reasons kept', async () => {
    const withheld = await sight(row(700, 2, '3', '2026-11-10T10:00:00.000Z'), {
      status: 'INCOMPLETE',
    });
    expect(withheld.rejected[0]!.reasons).toEqual([
      'QUEUE_NOT_PUBLISHED:WITHHELD_INCOMPLETE_BATCH',
      'BATCH_NOT_COMPLETE:INCOMPLETE',
    ]);
    const old = await batch('2026-11-01T10:00:00.000Z');
    const replay = await capture().capture(
      old,
      'PUBLISHED',
      [row(701, 3, '3', '2026-11-01T10:00:00.000Z')],
      { now: t('2026-11-10T10:00:00.000Z') },
    );
    expect(replay.rejected[0]!.reasons).toEqual(['TRIGGER_BATCH_NOT_CURRENT']);
    expect(await ctx.repo(ForwardEvent).count()).toBe(0);
  });
});

describe('daily High update — PDF p.5–7, p.11', () => {
  it('excludes the pre-signal and after-window Highs, flags the extension, keeps a lower bound, then a revision settles the peak exactly', async () => {
    const id = 777;
    const created = await sight(row(id, 2, '10', '2026-11-10T14:00:00.000Z'));
    const eventId = created.created[0]!.eventId;
    await store([
      day(id, '2026-11-10', '20', '2026-11-10T09:00:00.000Z'), // pre-signal: must never count
      day(id, '2026-11-11', '11', '2026-11-11T03:00:00.000Z'),
      day(id, '2026-11-12', '12', '2026-11-12T03:00:00.000Z'),
      day(id, '2026-11-13', '13', '2026-11-13T03:00:00.000Z'),
      day(id, '2026-11-14', '14', '2026-11-14T03:00:00.000Z'),
      day(id, '2026-11-15', '12', '2026-11-15T03:00:00.000Z'),
      day(id, '2026-11-16', '12', '2026-11-16T03:00:00.000Z'),
      day(id, '2026-11-17', '15', '2026-11-17T20:00:00.000Z'), // inside the end-of-day extension
      day(id, '2026-11-18', '99', '2026-11-18T00:00:00.000Z'), // after evaluation_end
    ]);

    // After the 168 h deadline, the final day still open.
    await update('2026-11-17T15:00:00.000Z');
    let e = await ctx.repo(ForwardEvent).findOneByOrFail({ id: eventId });
    let o = await latestOutcome(eventId);
    expect([e.status, o.peakKind, o.peakHighUsd?.toFixed(), o.reasons]).toEqual([
      'AWAITING_FINAL_DAY',
      'LOWER_BOUND',
      '14',
      ['DAY0_UNRESOLVED'],
    ]);

    // Final day closed: 17 Nov 20:00 counts (extension), 18 Nov does not, 10 Nov 09:00 never.
    await update('2026-11-18T00:30:00.000Z');
    e = await ctx.repo(ForwardEvent).findOneByOrFail({ id: eventId });
    o = await latestOutcome(eventId);
    expect(e.status).toBe('INCOMPLETE');
    expect(e.qualityFlags).toEqual(['INCOMPLETE_DAY0']);
    expect([
      o.status,
      o.coverageStatus,
      o.peakKind,
      o.peakHighUsd?.toFixed(),
      o.peakReturnPct?.toFixed(),
      o.extensionPeakFlag,
      o.peakTimePrecision,
      o.peakAt?.toISOString(),
      o.day0State,
      o.coveredDays,
    ]).toEqual([
      'INCOMPLETE',
      'INCOMPLETE',
      'LOWER_BOUND',
      '15',
      '50',
      'TRUE',
      'SOURCE_TIME',
      '2026-11-17T20:00:00.000Z',
      'UNRESOLVED',
      7,
    ]);
    const highs = await ctx.repo(ForwardHigh).find({
      where: { eventId },
      order: { periodStart: 'ASC' },
    });
    expect(highs.map((h) => h.dateUtc)).toEqual([
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
    ]);
    expect([highs[0]!.eligibility, highs[0]!.reason]).toEqual([
      'DAY0_UNPROVEN',
      'time_high_before_detection',
    ]);
    expect(highs.every((h) => h.quoteCurrency === 'USD' && h.source === 'fixture:daily')).toBe(
      true,
    );

    // A late source revision of 13 Nov (High 21 ≥ the whole signal-day High 20) settles day 0.
    await store([day(id, '2026-11-13', '21', '2026-11-13T05:00:00.000Z')]);
    const r = await update('2026-11-18T06:00:00.000Z');
    expect(r.highs).toMatchObject({ inserted: 1, superseded: 1 });
    e = await ctx.repo(ForwardEvent).findOneByOrFail({ id: eventId });
    o = await latestOutcome(eventId);
    expect([
      e.status,
      o.resultVersion,
      o.revisionReason,
      o.peakKind,
      o.peakReturnPct?.toFixed(),
      o.extensionPeakFlag,
      o.day0State,
    ]).toEqual(['FINAL', 3, 'source_revision', 'EXACT', '110', 'FALSE', 'SHORTCUT']);
    expect(e.finalizedAt!.toISOString()).toBe('2026-11-18T06:00:00.000Z');
    const day13 = await ctx.repo(ForwardHigh).find({
      where: { eventId, dateUtc: '2026-11-13' },
      order: { id: 'ASC' },
    });
    expect(day13.map((h) => [h.highUsd?.toFixed(), h.isCurrent, !!h.supersededAt])).toEqual([
      ['13', false, true],
      ['21', true, false],
    ]);
    // The detection snapshot never moved; earlier outcome versions are kept.
    expect([e.snapshotPriceUsd.toFixed(), e.detectedAt.toISOString()]).toEqual([
      '10',
      '2026-11-10T14:00:00.000Z',
    ]);
    expect(await ctx.repo(ForwardOutcome).countBy({ eventId })).toBe(3);

    // Safe to rerun: nothing new.
    const again = await update('2026-11-18T06:00:00.000Z');
    expect([again.outcomes.versions, again.highs.inserted]).toEqual([0, 0]);
  });

  it('never claims FINAL before the final day has a High; a late final day keeps AWAITING_FINAL_DAY', async () => {
    const id = 778;
    const eventId = (await sight(row(id, 1, '10', '2026-11-10T14:00:00.000Z'))).created[0]!.eventId;
    await store([
      day(id, '2026-11-10', '12', '2026-11-10T15:00:00.000Z'), // post-signal
      ...['11', '12', '13', '14', '15', '16'].map((d) =>
        day(id, `2026-11-${d}`, '11', `2026-11-${d}T08:00:00.000Z`),
      ),
    ]);
    const first = await update('2026-11-18T00:30:00.000Z');
    expect(first.status).toBe('partial');
    expect((await ctx.repo(ForwardEvent).findOneByOrFail({ id: eventId })).status).toBe(
      'AWAITING_FINAL_DAY',
    );
    expect((await latestOutcome(eventId)).reasons).toEqual([
      'HIGH_MISSING:2026-11-17',
      'FINAL_DAY_PENDING',
    ]);
    // Missing Highs are retried later; a full run is not repeated within the retry interval.
    expect((await updater().due(P, t('2026-11-18T01:00:00.000Z'))).due).toBe(false);
    expect((await updater().due(P, t('2026-11-18T04:00:00.000Z'))).due).toBe(true);

    await store([day(id, '2026-11-17', '13', '2026-11-17T20:00:00.000Z')]);
    const second = await update('2026-11-18T04:00:00.000Z');
    expect(second.status).toBe('succeeded');
    const o = await latestOutcome(eventId);
    expect([o.status, o.peakKind, o.peakReturnPct?.toFixed(), o.extensionPeakFlag]).toEqual([
      'FINAL',
      'EXACT',
      '30',
      'TRUE',
    ]);
    expect((await updater().due(P, t('2026-11-18T23:00:00.000Z'))).due).toBe(false);
    expect((await updater().due(P, t('2026-11-19T00:10:00.000Z'))).reason).toMatch(/closed/);
  });

  it('keeps the detection snapshot immutable in the database', async () => {
    const eventId = (await sight(row(779, 2, '4', '2026-11-10T14:00:00.000Z'))).created[0]!.eventId;
    await expect(
      ctx.db.query(`UPDATE forward_event SET snapshot_price_usd = 5 WHERE id = $1`, [eventId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      ctx.db.query(`UPDATE forward_event SET detected_at = now() WHERE id = $1`, [eventId]),
    ).rejects.toThrow(/immutable/);
    await ctx.db.query(`UPDATE forward_event SET status = 'TRACKING' WHERE id = $1`, [eventId]);
    const e = await ctx.repo(ForwardEvent).findOneByOrFail({ id: eventId });
    expect([e.status, e.snapshotPriceUsd.toFixed()]).toEqual(['TRACKING', '4']);
  });
});

describe('hourly pipeline integration on the synthetic fixture', () => {
  it('records the published queue as events (never on reprocessing), follows them daily and finalizes them', async () => {
    const p = ctx.app.get(PipelineService);
    const r = await p.runSlot(slotOf(new Date()));
    expect(r.stages.forward).toBe('succeeded');
    const queue = await ctx
      .repo(ScanResult)
      .find({ where: { batchId: r.batchId!, inQueue: true } });
    expect(queue.length).toBeGreaterThan(0);
    const events = await ctx.repo(ForwardEvent).find();
    const crawl = await ctx.repo(CrawlBatch).findOneByOrFail({ id: r.batchId! });
    // One event per published queue row, carrying the scanner's stars and price unchanged.
    expect(events).toHaveLength(queue.length);
    for (const q of queue) {
      const e = events.find((x) => x.cmcId === q.cmcId)!;
      expect([e.starCount, e.snapshotPriceUsd.toFixed(), e.status, e.isLive]).toEqual([
        q.stars,
        q.priceUsd!.toFixed(),
        'OPEN',
        false,
      ]);
      expect(e.detectedAt.toISOString()).toBe(crawl.crawledAt.toISOString());
    }
    // No event for a 0-star (ZERO), a stale quote (STAL) or an excluded asset (R100).
    for (const cmcId of [990002, 990015, 990025])
      expect(await ctx.repo(ForwardEvent).countBy({ cmcId })).toBe(0);
    expect(await ctx.repo(ForwardTestWatchlist).count()).toBe(
      new Set(queue.map((q) => q.cmcId)).size,
    );

    // Reprocessing the batch and re-running the hour create nothing new.
    await p.reprocess(r.batchId!);
    await p.runSlot(slotOf(new Date()), { force: true });
    expect(await ctx.repo(ForwardEvent).count()).toBe(events.length);
    const runs = await ctx.repo(ForwardTriggerRun).find({ order: { triggeredAt: 'ASC' } });
    expect(runs.map((x) => [x.created, x.ignored])).toEqual([
      [events.length, 0],
      [0, events.length],
    ]);

    // The day after: day 0 closed, its daily rows fetched for the tracked assets.
    const fwd = ctx.app.get(ForwardTestService);
    const detected = events[0]!.detectedAt;
    const nextDay = new Date(detected.getTime() + DAY_MS);
    const u1 = await fwd.update(P, { now: nextDay, trigger: 'manual' });
    expect('status' in u1.update && u1.update.status).toBe('succeeded');
    const tracked = await ctx.repo(ForwardEvent).find();
    expect(new Set(tracked.map((e) => e.status))).toEqual(new Set(['TRACKING']));
    expect(await ctx.repo(ForwardOutcome).count()).toBe(events.length);

    // After evaluation_end: every event is FINAL or (signal-day High before detection, never
    // exceeded) INCOMPLETE_DAY0 — the synthetic source has no gaps.
    const after = new Date(events[0]!.evaluationEnd.getTime() + 3_600_000);
    const u2 = await fwd.update(P, { now: after, trigger: 'manual' });
    expect('status' in u2.update && u2.update.status).toBe('succeeded');
    const done = await ctx.repo(ForwardEvent).find();
    for (const e of done) {
      expect(['FINAL', 'INCOMPLETE']).toContain(e.status);
      if (e.status === 'INCOMPLETE') expect(e.qualityFlags).toEqual(['INCOMPLETE_DAY0']);
    }
    // Every FINAL peak is recomputable from the stored current Highs and the reference price.
    for (const e of done.filter((x) => x.status === 'FINAL')) {
      const o = await latestOutcome(e.id);
      const highs = await ctx.repo(ForwardHigh).findBy({ eventId: e.id, isCurrent: true });
      expect(highs).toHaveLength(8);
      const eligible = highs.filter((h) => h.eligibility !== 'DAY0_UNPROVEN');
      const max = eligible.reduce((m, h) => (h.highUsd!.gt(m) ? h.highUsd! : m), new D(0));
      expect(o.peakHighUsd!.toFixed()).toBe(max.toFixed());
      expect(o.peakReturnPct!.toFixed()).toBe(
        max.div(e.snapshotPriceUsd).minus(1).times(100).toDecimalPlaces(30).toFixed(),
      );
    }
    const summary = await ctx.app.get(ForwardReadService).summary(after);
    const all = summary.cohort.find((g) => g.group === 'all')!;
    expect(all.events).toBe(events.length);
    expect(all.final + all.incomplete).toBe(events.length);
    expect(all.finalReturns.n).toBe(all.final);

    // Export: CSV per sheet, the workbook and a manifest with checksums.
    const out = await ctx.app.get(ForwardExportService).write(after);
    expect(out.path).toMatch(/forward-test_SYNTHETIC$/);
    const manifest = JSON.parse(readFileSync(join(out.path, 'manifest.json'), 'utf8')) as {
      files: Array<{ name: string; rows: number; sha256: string }>;
    };
    expect(manifest.files.map((f) => f.name)).toEqual([
      'events_active.csv',
      'events_final.csv',
      'events_incomplete.csv',
      'cohort_summary.csv',
      'distributions.csv',
      'rejected_triggers.csv',
      'run_metadata.csv',
      'workbook.xlsx',
    ]);
    expect(manifest.files.find((f) => f.name === 'events_final.csv')!.rows).toBe(all.final);
    expect(existsSync(join(out.path, 'workbook.xlsx'))).toBe(true);
    const csv = readFileSync(join(out.path, 'events_final.csv'), 'utf8');
    expect(csv.split('\r\n')[0]).toMatch(/^event_id,cmc_id,symbol,name,detected_at_utc,/);
    expect(csv).toContain('SYNTHETIC');
  }, 180_000);

  it('a forward-test failure never fails the hourly run', async () => {
    const spy = vi
      .spyOn(ctx.app.get(ForwardTestService), 'afterPublication')
      .mockRejectedValueOnce(new Error('simulated forward-test failure'));
    const r = await ctx.app.get(PipelineService).runSlot(slotOf(new Date()));
    expect(r.status).toBe('partial');
    expect(r.stages.forward).toMatch(/failed/);
    expect(r.stages.notify).toBe('succeeded');
    spy.mockRestore();
    // The update run table holds no half-written run.
    expect(await ctx.repo(ForwardUpdateRun).countBy({ status: 'running' })).toBe(0);
  }, 120_000);
});
