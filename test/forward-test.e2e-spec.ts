import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DAY_MS } from '../src/common/utils/dates.js';
import { D, type DValue } from '../src/common/utils/decimal.js';
import { slotOf } from '../src/common/utils/time.js';
import { DailyMetricsService } from '../src/modules/daily-metrics/daily-metrics.service.js';
import { DailyFetchState } from '../src/modules/daily-metrics/entities/daily-fetch-state.entity.js';
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
import { type PassStatus, type VenuePair, rankingScore } from '../src/modules/strategy/index.js';
import {
  VenueCrawl,
  type VenueCrawlKind,
} from '../src/modules/venues/entities/venue-crawl.entity.js';
import {
  BITHUMB_FILTERS,
  type BithumbFilter,
  MARKET_FILTERS,
  type MarketFilter,
  matchesBithumb,
  matchesMarket,
} from '../src/modules/venues/exchange-lists.js';

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

/** The scanner's comparisons for a pass pattern (YES → 2.0×, NO → 1.2×) with their ranking fields. */
function ranked(
  pattern: [PassStatus, PassStatus, PassStatus],
  multiples?: [string, string, string],
) {
  const m = pattern.map((p, i) =>
    p === 'N/A' ? null : new D(multiples?.[i] ?? (p === 'YES' ? '2' : '1.2')),
  ) as [DValue | null, DValue | null, DValue | null];
  const fields = {
    pass3d: pattern[0],
    pass7d: pattern[1],
    pass30d: pattern[2],
    multiple3d: m[0],
    multiple7d: m[1],
    multiple30d: m[2],
  };
  const r = rankingScore(fields);
  return {
    ...fields,
    weightedPassPoints: r.weightedPassPoints,
    scoreComplete: r.scoreComplete,
    weightedStrength: r.weightedStrength,
    rankingRulesetVersion: 'weighted_star_v1',
  };
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
  const rank = ranked([yes(1), yes(2), yes(3)]);
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
    ...rank,
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

  it('snapshots the ranking known at detection; a later score on the same key changes nothing (ranking § 5)', async () => {
    const id = 321;
    const first = await sight(
      row(
        id,
        2,
        '10',
        '2026-11-10T10:00:00.000Z',
        ranked(['YES', 'YES', 'NO'], ['2.2', '1.7', '1.1']),
      ),
    );
    // Same UTC date, still 2 stars, but now NO/YES/YES (40 points): no new event, nothing rewritten.
    const same = await sight(
      row(
        id,
        2,
        '11',
        '2026-11-10T11:00:00.000Z',
        ranked(['NO', 'YES', 'YES'], ['1.4', '1.6', '1.8']),
      ),
    );
    const three = await sight(
      row(id, 3, '12', '2026-11-10T15:00:00.000Z', ranked(['YES', 'YES', 'YES'])),
    );
    expect([
      first.created.length,
      same.created.length,
      same.ignored.length,
      three.created.length,
    ]).toEqual([1, 0, 1, 1]);
    const events = await ctx
      .repo(ForwardEvent)
      .find({ where: { cmcId: id }, order: { detectedAt: 'ASC' } });
    expect(
      events.map((e) => [
        e.starCount,
        `${e.pass3d}/${e.pass7d}/${e.pass30d}`,
        e.weightedPassPoints,
        e.scoreComplete,
        e.weightedStrength?.toFixed() ?? null,
        e.rankingRulesetVersion,
        e.snapshotPriceUsd.toFixed(),
      ]),
    ).toEqual([
      [2, 'YES/YES/NO', 85, true, '1.91', 'weighted_star_v1', '10'],
      [3, 'YES/YES/YES', 100, true, '2', 'weighted_star_v1', '12'],
    ]);
    // Part of the immutable detection snapshot.
    await expect(
      ctx.db.query(`UPDATE forward_event SET weighted_pass_points = 40 WHERE id = $1`, [
        events[0]!.id,
      ]),
    ).rejects.toThrow(/immutable/);
    const rows = (
      await ctx.app.get(ForwardReadService).events({ view: 'all', limit: 5, offset: 0 })
    ).rows;
    expect(rows.find((r) => r.starCount === 2)).toMatchObject({
      passPattern: 'YES/YES/NO',
      weightedPassPoints: 85,
      scoreComplete: true,
      weightedStrength: '1.91',
      rankingRulesetVersion: 'weighted_star_v1',
    });
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
      // The scanner's ranking at detection, copied as published.
      expect([
        e.weightedPassPoints,
        e.scoreComplete,
        e.weightedStrength?.toFixed() ?? null,
        e.rankingRulesetVersion,
      ]).toEqual([
        q.weightedPassPoints,
        q.scoreComplete,
        q.weightedStrength?.toFixed() ?? null,
        'weighted_star_v1',
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

describe('High check status, window progress and the event list (dashboard)', () => {
  const read = () => ctx.app.get(ForwardReadService);
  const apiRow = async (eventId: string) =>
    (await read().events({ view: 'all', limit: 50, offset: 0 })).rows.find(
      (r) => r.eventId === eventId,
    )!;

  it('tells not checked, new record, unchanged, data unavailable and retrieval error apart; checked-through advances', async () => {
    const id = 780;
    const eventId = (await sight(row(id, 2, '10', '2026-11-10T14:00:00.000Z'))).created[0]!.eventId;
    let e = await ctx.repo(ForwardEvent).findOneByOrFail({ id: eventId });
    expect([e.lastCheckStatus, e.lastCheckAt, e.checkedThrough]).toEqual([null, null, null]);
    // The signal day is still open: nothing to check, the event stays "not checked yet".
    let r = await update('2026-11-10T20:00:00.000Z');
    expect(r.checks).toMatchObject({ checked: 0, notDue: 1 });
    expect((await ctx.repo(ForwardEvent).findOneByOrFail({ id: eventId })).lastCheckStatus).toBe(
      null,
    );

    // Day 0 closes with a post-signal High 12 (15:00 ≥ 14:00): the first confirmed record.
    await store([day(id, '2026-11-10', '12', '2026-11-10T15:00:00.000Z')]);
    r = await update('2026-11-11T00:30:00.000Z');
    expect(r.checks).toMatchObject({ checked: 1, newRecord: 1, unchanged: 0, errors: 0 });
    e = await ctx.repo(ForwardEvent).findOneByOrFail({ id: eventId });
    expect([e.lastCheckStatus, e.checkedThrough, e.lastCheckAt?.toISOString()]).toEqual([
      'NEW_RECORD',
      '2026-11-10',
      '2026-11-11T00:30:00.000Z',
    ]);
    // A same-day re-check adds nothing: the record found by the newest day stays visible.
    r = await update('2026-11-11T02:00:00.000Z');
    e = await ctx.repo(ForwardEvent).findOneByOrFail({ id: eventId });
    expect([e.lastCheckStatus, e.lastCheckAt?.toISOString(), r.outcomes.versions]).toEqual([
      'NEW_RECORD',
      '2026-11-11T02:00:00.000Z',
      0,
    ]);

    // A lower High on day 1: the record and the reference price stay, checked-through advances.
    await store([day(id, '2026-11-11', '11', '2026-11-11T08:00:00.000Z')]);
    r = await update('2026-11-12T00:30:00.000Z');
    expect(r.checks).toMatchObject({ checked: 1, newRecord: 0, unchanged: 1 });
    e = await ctx.repo(ForwardEvent).findOneByOrFail({ id: eventId });
    expect([e.lastCheckStatus, e.checkedThrough, e.snapshotPriceUsd.toFixed()]).toEqual([
      'UNCHANGED',
      '2026-11-11',
      '10',
    ]);
    expect((await latestOutcome(eventId)).peakHighUsd?.toFixed()).toBe('12');

    // Day 2 has no daily row yet: data unavailable, checked-through does not move past the gap.
    r = await update('2026-11-13T00:30:00.000Z');
    expect(r.checks).toMatchObject({ dataUnavailable: 1 });
    e = await ctx.repo(ForwardEvent).findOneByOrFail({ id: eventId });
    expect([e.lastCheckStatus, e.checkedThrough]).toEqual(['DATA_UNAVAILABLE', '2026-11-11']);
    expect(e.lastCheckNote).toMatch(/2026-11-12/);

    // The coin's daily-history request failed: a retrieval error, not absent data.
    await ctx.repo(DailyFetchState).save({
      providerId: P,
      cmcId: id,
      lastAttemptAt: t('2026-11-13T03:59:00.000Z'),
      lastSuccessAt: null,
      lastStatus: 'failed',
      lastError: 'HTTP 503 (synthetic)',
      rowsReturned: 0,
      latestDateReturned: null,
    });
    r = await update('2026-11-13T04:00:00.000Z');
    expect(r.checks).toMatchObject({ errors: 1 });
    e = await ctx.repo(ForwardEvent).findOneByOrFail({ id: eventId });
    expect([e.lastCheckStatus, e.lastCheckNote]).toEqual([
      'RETRIEVAL_ERROR',
      expect.stringMatching(/HTTP 503/),
    ]);

    // The day arrives with a higher High: a new record, the previous one named in the note.
    await ctx.repo(DailyFetchState).update({ providerId: P, cmcId: id }, { lastStatus: 'ok' });
    await store([day(id, '2026-11-12', '15', '2026-11-12T10:00:00.000Z')]);
    r = await update('2026-11-13T08:00:00.000Z');
    e = await ctx.repo(ForwardEvent).findOneByOrFail({ id: eventId });
    expect([e.lastCheckStatus, e.checkedThrough]).toEqual(['NEW_RECORD', '2026-11-12']);
    expect(e.lastCheckNote).toMatch(/15 USD on 2026-11-12 \(previous record 12 USD\)/);

    // The API row: status, checked-through, day 3 of 7 with 3 days checked, the update run's counts.
    const api = await apiRow(eventId);
    expect(api.check).toMatchObject({ status: 'NEW_RECORD', checkedThrough: '2026-11-12' });
    expect(api.window).toMatchObject({ lastDay: 7, checkedDays: 3 });
    const run = await read().updateRun(r.updateRunId);
    expect(run).toMatchObject({
      status: 'succeeded',
      progress: { phase: 'done', processed: 1, total: 1 },
      checks: { checked: 1, newRecord: 1 },
    });
  });

  it('keeps an unproven signal-day High out of the result but shows it apart; sorts and filters the list', async () => {
    // A: detected 14:00, the day's High 20 came at 09:00 (before detection), day 1 only 11.
    const a = (await sight(row(781, 2, '10', '2026-11-10T14:00:00.000Z'))).created[0]!.eventId;
    // B: 3 stars, post-signal High 13 → +30 %. C: 1 star, post-signal High 10.5 → +5 %.
    const b = (await sight(row(782, 3, '10', '2026-11-10T15:00:00.000Z'))).created[0]!.eventId;
    const c = (await sight(row(783, 1, '10', '2026-11-10T16:00:00.000Z'))).created[0]!.eventId;
    // One coin per call, as the crawler stores them.
    await store([
      day(781, '2026-11-10', '20', '2026-11-10T09:00:00.000Z'),
      day(781, '2026-11-11', '11', '2026-11-11T09:00:00.000Z'),
    ]);
    await store([
      day(782, '2026-11-10', '13', '2026-11-10T16:00:00.000Z'),
      day(782, '2026-11-11', '12', '2026-11-11T09:00:00.000Z'),
    ]);
    await store([
      day(783, '2026-11-10', '10.5', '2026-11-10T17:00:00.000Z'),
      day(783, '2026-11-11', '10.1', '2026-11-11T09:00:00.000Z'),
    ]);
    await update('2026-11-12T00:30:00.000Z');

    const ra = await apiRow(a);
    expect(ra.outcome?.peakHighUsd).toBe('11'); // the confirmed record: day 1, never the day-0 20
    expect(ra.day0).toMatchObject({
      highUsd: '20',
      eligibility: 'DAY0_UNPROVEN',
      reason: 'time_high_before_detection',
      changePct: '100',
    });
    expect(ra.qualityFlags).toContain('DAY0_UNRESOLVED');

    const list = (q: Parameters<ForwardReadService['events']>[0]) =>
      read()
        .events(q)
        .then((x) => x.rows.map((r) => r.eventId));
    const base = { view: 'all' as const, limit: 50, offset: 0 };
    expect(await list({ ...base, sort: 'return', dir: 'desc' })).toEqual([b, a, c]);
    expect(await list({ ...base, sort: 'return', dir: 'asc' })).toEqual([c, a, b]);
    // One event per coin here, so each coin's Average Return is its event's Return.
    expect(await list({ ...base, sort: 'coinAverage', dir: 'desc' })).toEqual([b, a, c]);
    expect(await list({ ...base, sort: 'coinAverage', dir: 'asc' })).toEqual([c, a, b]);
    expect(await list({ ...base, sort: 'stars', dir: 'asc' })).toEqual([c, a, b]);
    expect(await list({ ...base, result: 'DAY0_UNCONFIRMED' })).toEqual([a]);
    expect(await list({ ...base, result: 'CONFIRMED', stars: 3 })).toEqual([b]);
    expect(await list({ ...base, status: 'TRACKING', result: 'NOT_CHECKED' })).toEqual([]);

    const s = await read().summary(t('2026-11-12T01:00:00.000Z'));
    const all = s.cohort.find((g) => g.group === 'all')!;
    expect([
      all.confirmedHigh,
      all.awaitingCheck,
      all.day0Unconfirmed,
      all.activeReturns.n,
    ]).toEqual([3, 0, 1, 3]);
    // +30 %, +10 % (A's confirmed day 1), +5 %: the unproven +100 % never enters the statistics.
    expect([all.activeReturns.median, all.activeReturns.max]).toEqual(['10', '30']);
  });

  it('lists the overlapping events of one coin with their identification time, stars, price and overlap', async () => {
    const first = (await sight(row(784, 2, '10', '2026-11-10T10:00:00.000Z'))).created[0]!.eventId;
    const second = (await sight(row(784, 3, '12', '2026-11-10T15:00:00.000Z'))).created[0]!.eventId;
    const third = (await sight(row(784, 2, '14', '2026-11-11T09:00:00.000Z'))).created[0]!.eventId;
    const far = (await sight(row(784, 1, '9', '2026-11-25T09:00:00.000Z'))).created[0]!.eventId;
    const o = (await read().overlaps(second))!;
    expect(
      o.overlaps.map((x) => [x.eventId, x.relation, x.starCount, x.referencePriceUsd]),
    ).toEqual([
      [first, 'same_utc_day', 2, '10'],
      [third, 'later', 2, '14'],
    ]);
    expect(o.overlaps[0]).toMatchObject({
      overlapStart: '2026-11-10T15:00:00.000Z',
      overlapEnd: '2026-11-17T23:59:59.999Z',
    });
    expect((await read().overlaps(far))!.overlaps).toEqual([]);
    expect((await apiRow(second)).overlappingEventIds.sort()).toEqual([first, third].sort());
  });

  it('starts the manual update in the background and reports its run; a held lease refuses to start', async () => {
    const p = ctx.app.get(PipelineService);
    const started = await p.startForwardUpdate();
    expect(started.started).toBe(true);
    if (!started.started) return;
    // The lease is held until the background update finishes.
    const busy = await p.startForwardUpdate();
    expect(busy).toMatchObject({ started: false, reason: expect.stringMatching(/in progress/) });
    await started.done;
    const run = await ctx.app.get(ForwardReadService).updateRun(started.updateRunId);
    expect(run).toMatchObject({
      trigger: 'manual',
      status: 'succeeded',
      progress: { phase: 'done' },
    });
    expect(run?.checks).toMatchObject({ checked: 0, errors: 0 });
  });
});

describe('Average Return per coin and exchange listings (dashboard, ADR-0007)', () => {
  const read = () => ctx.app.get(ForwardReadService);
  const base = { view: 'all' as const, limit: 50, offset: 0 };

  it('averages the numeric Returns of every stored event of the coin, by CMC id, and marks a lower bound', async () => {
    // A: 2★ on 1 Nov, FINAL with a High of 12: +20 % (exact).
    const a = (await sight(row(790, 2, '10', '2026-11-01T10:00:00.000Z'))).created[0]!.eventId;
    await store([
      day(790, '2026-11-01', '12', '2026-11-01T12:00:00.000Z'),
      ...['02', '03', '04', '05', '06', '07', '08'].map((d) =>
        day(790, `2026-11-${d}`, '11', `2026-11-${d}T08:00:00.000Z`),
      ),
    ]);
    await update('2026-11-09T00:30:00.000Z');
    // B: 3★ on 10 Nov at 10:00, post-signal High 13: ≥ +30 % (window open). C: 1★ at 15:00 the
    // same day; that High came at 12:00, before C, so C has no Return yet — left out, never 0 %.
    const b = (await sight(row(790, 3, '10', '2026-11-10T10:00:00.000Z'))).created[0]!.eventId;
    const c = (await sight(row(790, 1, '10', '2026-11-10T15:00:00.000Z'))).created[0]!.eventId;
    // D: another coin with the same ticker (≥ +50 %), kept apart by its CMC id.
    const d = (await sight(row(791, 2, '10', '2026-11-10T11:00:00.000Z', { symbol: 'T790' })))
      .created[0]!.eventId;
    await store([day(790, '2026-11-10', '13', '2026-11-10T12:00:00.000Z')]);
    await store([day(791, '2026-11-10', '15', '2026-11-10T12:00:00.000Z')]);
    await update('2026-11-11T00:30:00.000Z');

    const byId = new Map((await read().events(base)).rows.map((r) => [r.eventId, r]));
    expect(byId.get(a)!.outcome).toMatchObject({ peakKind: 'EXACT', peakReturnPct: '20' });
    expect(byId.get(b)!.outcome).toMatchObject({ peakKind: 'LOWER_BOUND', peakReturnPct: '30' });
    expect(byId.get(c)!.outcome?.peakReturnPct ?? null).toBeNull();
    const coin790 = { events: 3, withReturn: 2, lowerBounds: 1, averagePct: '25' };
    for (const id of [a, b, c]) expect(byId.get(id)!.coinAverageReturn).toEqual(coin790);
    expect(byId.get(d)!.coinAverageReturn).toEqual({
      events: 1,
      withReturn: 1,
      lowerBounds: 1,
      averagePct: '50',
    });

    // Views, filters and pages never shrink the coin's set: the active view hides FINAL A.
    const active = await read().events({ view: 'active', stars: 3, limit: 1, offset: 0 });
    expect(active.rows.map((r) => [r.eventId, r.coinAverageReturn])).toEqual([[b, coin790]]);

    // The overlapping-events dialog lists only C (A's window ended before B), yet the coin summary
    // shown with it covers A, B and C.
    const o = (await read().overlaps(b))!;
    expect(o.overlaps.map((x) => x.eventId)).toEqual([c]);
    expect(o.coin).toEqual({ cmcId: 790, ...coin790 });
  });

  it("shows each coin's LBank Spot / Futures and Bithumb listing by CMC id, Unknown until a list is verified; filters agree", async () => {
    const ids = [792, 793, 794, 795];
    for (const [i, id] of ids.entries())
      await sight(row(id, 2, '10', `2026-11-12T1${i}:00:00.000Z`));
    const listings = async () =>
      new Map((await read().events(base)).rows.map((r) => [r.cmcId, r.exchanges]));
    const kept = async (market?: MarketFilter, bithumb?: BithumbFilter) =>
      (await read().events({ ...base, market, bithumb })).rows.map((r) => r.cmcId).sort();

    // No list stored yet: every answer is Unknown (never No) and only the Unknown filters keep rows.
    let l = await listings();
    expect(
      [...l.values()].every((x) =>
        Object.values(x).every((a) => a.status === 'UNKNOWN' && a.reason === 'LIST_NOT_FETCHED'),
      ),
    ).toBe(true);
    expect(await kept('unknown')).toEqual(ids);
    expect(await kept('neither')).toEqual([]);
    expect(await kept(undefined, 'not_listed')).toEqual([]);

    // Lists as the crawler stores them (synthetic): Spot 792, 793; Futures 792, 794 plus a Spot row
    // for 793 in that crawl (not a Futures listing); Bithumb 793, and T794/KRW without a CMC id.
    const now = new Date();
    const vp = (exchange: string, category: string, id: number, quote = 'USDT'): VenuePair => ({
      exchange,
      exchangeName: exchange,
      marketPair: `T${id}/${quote}`,
      category,
      baseSymbol: `T${id}`,
      baseCurrencyId: id,
      quoteSymbol: quote,
      quoteCurrencyId: null,
      volumeUsd: '1000',
      volumePercent: null,
      priceUsd: null,
      lastUpdated: null,
      marketUrl: null,
      tradingStatus: null,
      type: 'cex',
      flags: [],
    });
    const save = (kind: VenueCrawlKind, pairs: VenuePair[]) =>
      ctx.repo(VenueCrawl).save(
        ctx.repo(VenueCrawl).create({
          providerId: P,
          kind,
          startedAt: now,
          finishedAt: now,
          status: 'COMPLETE',
          expectedCount: pairs.length,
          fetchedCount: pairs.length,
          pairs,
          source: 'test (synthetic)',
          sourceParams: {},
        }),
      );
    await save('lbank_spot_pairs', [vp('lbank', 'spot', 792), vp('lbank', 'spot', 793)]);
    await save('lbank_futures_pairs', [
      vp('lbank', 'perpetual', 792),
      vp('lbank', 'perpetual', 794),
      vp('lbank', 'spot', 793),
    ]);
    await save('bithumb_spot_pairs', [
      vp('bithumb', 'spot', 793, 'KRW'),
      { ...vp('bithumb', 'spot', 794, 'KRW'), baseCurrencyId: null },
    ]);

    l = await listings();
    const answers = (id: number) => [
      l.get(id)!.lbankSpot.status,
      l.get(id)!.lbankFutures.status,
      l.get(id)!.bithumb.status,
    ];
    expect(ids.map(answers)).toEqual([
      ['YES', 'YES', 'NO'],
      ['YES', 'NO', 'YES'],
      ['NO', 'YES', 'UNKNOWN'],
      ['NO', 'NO', 'NO'],
    ]);
    expect(l.get(793)!.bithumb).toMatchObject({
      pairs: ['T793/KRW'],
      listFetchedAt: now.toISOString(),
    });
    expect(l.get(794)!.bithumb.reason).toBe('UNMAPPED_PAIR_SAME_TICKER');

    // Each filter, run in SQL, keeps exactly the rows whose shown answers it matches.
    for (const f of MARKET_FILTERS)
      expect(await kept(f), f).toEqual(
        ids.filter((id) =>
          matchesMarket(f, l.get(id)!.lbankSpot.status, l.get(id)!.lbankFutures.status),
        ),
      );
    for (const f of BITHUMB_FILTERS)
      expect(await kept(undefined, f), f).toEqual(
        ids.filter((id) => matchesBithumb(f, l.get(id)!.bithumb.status)),
      );
    expect([await kept('both'), await kept('spot_only', 'listed')]).toEqual([[792], [793]]);

    // The report names the lists behind the answers.
    const sum = await read().summary();
    expect(sum.exchangeLists.map((x) => [x.key, x.status, x.pairs])).toEqual([
      ['lbankSpot', 'VERIFIED', 2],
      ['lbankFutures', 'VERIFIED', 3],
      ['bithumb', 'VERIFIED', 2],
    ]);
  });
});
