import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { D } from '../src/common/utils/decimal.js';
import { slotOf } from '../src/common/utils/time.js';
import { DailyMetricsService } from '../src/modules/daily-metrics/daily-metrics.service.js';
import { DailyMetricRevision } from '../src/modules/daily-metrics/entities/daily-metric-revision.entity.js';
import { DailyMetric } from '../src/modules/daily-metrics/entities/daily-metric.entity.js';
import { MANDATORY_COLUMNS } from '../src/modules/exports/export.service.js';
import { CrawlBatch } from '../src/modules/ingestion/entities/crawl-batch.entity.js';
import { MarketSnapshot } from '../src/modules/ingestion/entities/market-snapshot.entity.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';
import { PipelineService } from '../src/modules/pipeline/pipeline.service.js';
import { ReadModelService } from '../src/modules/read-model/read-model.service.js';
import { Review } from '../src/modules/reviews/entities/review.entity.js';
import { ReviewInputError, ReviewService } from '../src/modules/reviews/review.service.js';
import { ScanResult } from '../src/modules/scan/entities/scan-result.entity.js';
import { ScanRun } from '../src/modules/scan/entities/scan-run.entity.js';
import { compareQueue, rankingScore } from '../src/modules/strategy/index.js';
import { parseDocumentPart } from '../src/modules/telegram/attachment.js';
import { TelegramDelivery } from '../src/modules/telegram/entities/telegram-delivery.entity.js';
import { ReportService } from '../src/modules/telegram/report.service.js';
import { VenueCrawl } from '../src/modules/venues/entities/venue-crawl.entity.js';
import { VenueMappingTask } from '../src/modules/venues/entities/venue-mapping-task.entity.js';
import { VenuesService } from '../src/modules/venues/venues.service.js';

import { makeApp, resetDb } from './utils/helpers.js';

/**
 * End-to-end Tier 1 on the SYNTHETIC fixture market (PDF p.20 demonstration): one pipeline run,
 * then replay, reviews, decisions and failure paths on the stored batch. Nothing is real data.
 */
let ctx: Awaited<ReturnType<typeof makeApp>>;
let batchId: string;
const S = {
  YNY: 990001,
  ZERO: 990002,
  TRIP: 990003,
  AMB: 990004,
  TWIN_A: 990005,
  TWIN_B: 990006,
  GAPD: 990007,
  BADD: 990008,
  UNV: 990009,
  NOLB: 990010,
  STBL: 990011,
  TSLAX: 990012,
  FANX: 990013,
  WRPX: 990014,
  STAL: 990015,
  NOTS: 990016,
  ZBAS: 990017,
  YUNG: 990018,
  AGE60: 990019,
  AGE59: 990020,
  NORK: 990021,
  NOCAP: 990022,
  CAP15: 990023,
  CAPLO: 990024,
  R100: 990025,
  R101: 990026,
  R1200: 990027,
  R1201: 990028,
  SNGL: 990029,
};
const row = (cmcId: number) => ctx.repo(ScanResult).findOneByOrFail({ batchId, cmcId });
/** The comparable outcome of every result row of the batch (row ids change on reprocess). */
const outcomes = async () =>
  (
    await ctx.repo(ScanResult).find({
      where: { batchId },
      select: {
        id: true,
        cmcId: true,
        inputsHash: true,
        pass3d: true,
        stars: true,
        weightedPassPoints: true,
        scoreComplete: true,
        queueOrder: true,
      },
    })
  ).map(({ cmcId, inputsHash, pass3d, stars, weightedPassPoints, scoreComplete, queueOrder }) => ({
    cmcId,
    inputsHash,
    pass3d,
    stars,
    weightedPassPoints,
    scoreComplete,
    queueOrder,
  }));
const counts = async () => ({
  snaps: await ctx.repo(MarketSnapshot).count(),
  results: await ctx.repo(ScanResult).count(),
  reviews: await ctx.repo(Review).count(),
  daily: await ctx.repo(DailyMetricRevision).count(),
});
const dec = (v: { toString(): string } | null) => (v === null ? null : new D(v.toString()));

beforeAll(async () => {
  rmSync('var/test-exports', { recursive: true, force: true });
  ctx = await makeApp({ TIER1_VENUE_MAX_ASSETS_PER_RUN: '500' });
  await resetDb(ctx.db);
  const r = await ctx.app.get(PipelineService).runSlot(slotOf(new Date()));
  expect(r.status, JSON.stringify(r)).not.toBe('failed');
  batchId = r.batchId!;
}, 180_000);
afterAll(async () => ctx.app.close());

describe('Tier 1 end to end on the synthetic fixture', () => {
  it('records a COMPLETE crawl batch with rank continuity and a published queue', async () => {
    const batch = await ctx.repo(CrawlBatch).findOneByOrFail({ id: batchId });
    expect(batch).toMatchObject({
      status: 'COMPLETE',
      isLive: false,
      missingRanks: [],
      duplicateRanks: [],
    });
    // Ranks 1–1300 are contiguous; one more coin is deliberately unranked (RANK_MISSING case).
    expect(batch.collected).toBe(1301);
    expect(batch.listedTotal).toBe(1301);
    const run = await ctx.repo(ScanRun).findOneByOrFail({ batchId });
    expect(run).toMatchObject({
      status: 'succeeded',
      queueStatus: 'PUBLISHED',
      isLive: false,
      rulesetVersion: 'vmc-tier1-1',
    });
    expect(await ctx.repo(ScanResult).countBy({ batchId })).toBe(1301);
  });

  it('YES/NO/YES asset keeps every window with exact multiples (p.7, p.19 B)', async () => {
    const r = await row(S.YNY);
    expect([r.pass3d, r.pass7d, r.pass30d, r.stars, r.eligibilityStatus, r.inQueue]).toEqual([
      'YES',
      'NO',
      'YES',
      2,
      'ELIGIBLE',
      true,
    ]);
    expect(dec(r.multiple3d)!.toFixed()).toBe('2');
    expect(dec(r.multiple7d)!.toFixed(12)).toBe('1.333333333333');
    expect(dec(r.multiple30d)!.toFixed()).toBe('4');
    expect(dec(r.vmc14dAvg)).not.toBeNull();
    expect(r.lbankStatus).toBe('VERIFIED');
  });

  it('0-star eligible asset is kept in All Eligible but not in the queue', async () => {
    const r = await row(S.ZERO);
    expect([r.eligibilityStatus, r.stars, r.inQueue, r.pass3d, r.pass7d, r.pass30d]).toEqual([
      'ELIGIBLE',
      0,
      false,
      'NO',
      'NO',
      'NO',
    ]);
  });

  it('ambiguous LBank tickers are held for review with a saved mapping-evidence task (p.10)', async () => {
    const amb = await row(S.AMB);
    expect(amb.eligibilityStatus).toBe('NEEDS_REVIEW');
    expect(amb.eligibilityReasons).toContain('LBANK_STATUS_UNKNOWN:AMBIGUOUS_MAPPING');
    for (const id of [S.TWIN_A, S.TWIN_B])
      expect((await row(id)).lbankReason).toBe('AMBIGUOUS_MAPPING');
    const tasks = await ctx
      .repo(VenueMappingTask)
      .find({ where: { status: 'OPEN' }, order: { cmcId: 'ASC' } });
    expect(tasks.map((t) => [t.cmcId, t.kind])).toEqual(
      expect.arrayContaining([
        [S.AMB, 'SYMBOL_MISMATCH'],
        [S.TWIN_A, 'TICKER_MULTIPLE_IDS'],
        [S.TWIN_B, 'TICKER_MULTIPLE_IDS'],
      ]),
    );
  });

  it('a missing daily row makes only the windows containing it N/A; an invalid one likewise (p.19 D)', async () => {
    const gap = await row(S.GAPD);
    expect([gap.avg3dReason, gap.avg7dReason, gap.avg14dReason, gap.avg30dReason]).toEqual([
      null,
      'DAILY_ROW_MISSING',
      'DAILY_ROW_MISSING',
      'DAILY_ROW_MISSING',
    ]);
    expect([gap.pass3d, gap.pass7d, gap.pass30d]).toEqual(['YES', 'N/A', 'N/A']);
    expect(gap.multiple7d).toBeNull();
    const bad = await row(S.BADD);
    expect([bad.avg3dReason, bad.avg7dReason, bad.avg14dReason, bad.avg30dReason]).toEqual([
      null,
      null,
      'DAILY_ROW_INVALID',
      'DAILY_ROW_INVALID',
    ]);
  });

  it('LBank: feed status, presence in the LBank Spot markets list (D1), not listed (p.9, p.10)', async () => {
    const yny = await row(S.YNY);
    const pairs = yny.lbankPairs as Array<{
      marketPair: string;
      trading: string;
      tradingSource: string;
    }>;
    expect(pairs.map((p) => p.marketPair).sort()).toEqual(['YNY/BTC', 'YNY/USDT']);
    expect(pairs.every((p) => p.trading === 'TRADING' && p.tradingSource === 'feed')).toBe(true);
    // No trading-status field: the listing itself counts (default LBANK_REQUIRE_MANUAL_VERIFICATION=false).
    const unv = await row(S.UNV);
    expect([unv.lbankStatus, unv.eligibilityStatus, unv.stars, unv.inQueue]).toEqual([
      'VERIFIED',
      'ELIGIBLE',
      3,
      true,
    ]);
    expect((unv.lbankPairs as Array<{ tradingSource: string }>)[0]!.tradingSource).toBe('listing');
    const nolb = await row(S.NOLB);
    expect([nolb.lbankStatus, nolb.eligibilityStatus, nolb.eligibilityReasons]).toEqual([
      'NOT_LISTED',
      'EXCLUDED',
      ['NO_LBANK_SPOT_PAIR'],
    ]);
    expect([nolb.pass3d, nolb.reason3d]).toEqual(['N/A', 'NOT_EVALUATED_EXCLUDED']);
  });

  it('classes, boundaries and current-observation states follow the PDF', async () => {
    const st = async (id: number) => (await row(id)).eligibilityStatus;
    expect(await st(S.STBL)).toBe('EXCLUDED');
    expect((await row(S.TSLAX)).eligibilityReasons).toEqual(['TOKENIZED_ASSET']);
    expect(await st(S.FANX)).toBe('ELIGIBLE');
    expect((await row(S.WRPX)).eligibilityReasons).toContain('CLASS_AMBIGUOUS:wrapped');
    expect([await st(S.R100), await st(S.R101), await st(S.R1200), await st(S.R1201)]).toEqual([
      'EXCLUDED',
      'ELIGIBLE',
      'ELIGIBLE',
      'EXCLUDED',
    ]);
    expect([await st(S.CAP15), await st(S.CAPLO)]).toEqual(['ELIGIBLE', 'EXCLUDED']);
    expect([await st(S.AGE60), await st(S.AGE59), await st(S.YUNG)]).toEqual([
      'ELIGIBLE',
      'EXCLUDED',
      'EXCLUDED',
    ]);
    expect((await row(S.NORK)).eligibilityReasons).toEqual(['RANK_MISSING']);
    expect((await row(S.NOCAP)).eligibilityReasons).toContain('MARKET_CAP_MISSING');
    const stale = await row(S.STAL);
    expect([stale.currentStatus, stale.pass3d, stale.reason3d, stale.stars]).toEqual([
      'STALE',
      'N/A',
      'CURRENT_STALE',
      0,
    ]);
    expect((await row(S.NOTS)).currentStatus).toBe('TIMESTAMP_UNVERIFIED');
    const zb = await row(S.ZBAS);
    expect([zb.pass3d, zb.reason3d]).toEqual(['N/A', 'ZERO_BASELINE']);
    expect(dec(zb.vmc3dAvg)!.isZero()).toBe(true);
  });

  it('orders the Review Queue by the weighted star ranking (weighted_star_v1)', async () => {
    const q = await ctx
      .repo(ScanResult)
      .find({ where: { batchId, inQueue: true }, order: { queueOrder: 'ASC' } });
    expect(q.length).toBeGreaterThan(5);
    expect(q.every((r) => r.eligibilityStatus === 'ELIGIBLE' && r.stars >= 1)).toBe(true);
    expect((await ctx.repo(ScanRun).findOneByOrFail({ batchId })).rankingRulesetVersion).toBe(
      'weighted_star_v1',
    );
    for (const r of q) {
      // The stored score is the ranking of the stored statuses, never a pass of its own.
      const s = rankingScore({
        pass3d: r.pass3d,
        pass7d: r.pass7d,
        pass30d: r.pass30d,
        multiple3d: dec(r.multiple3d),
        multiple7d: dec(r.multiple7d),
        multiple30d: dec(r.multiple30d),
      });
      expect([r.stars, r.weightedPassPoints, r.scoreComplete, r.rankingRulesetVersion]).toEqual([
        s.stars,
        s.weightedPassPoints,
        s.scoreComplete,
        'weighted_star_v1',
      ]);
      if (s.weightedStrength === null) expect(r.weightedStrength).toBeNull();
      // Stored at 30 dp from the unrounded multiples.
      else expect(dec(r.weightedStrength)!.minus(s.weightedStrength).abs().lt('1e-27')).toBe(true);
      expect(r.rulesetVersion).toBe('vmc-tier1-1');
    }
    const keys = q.map((r) => ({
      cmcId: r.cmcId,
      stars: r.stars,
      weightedPassPoints: r.weightedPassPoints!,
      scoreComplete: r.scoreComplete!,
      weightedStrength: dec(r.weightedStrength),
      multiple3d: dec(r.multiple3d),
    }));
    expect([...keys].sort(compareQueue).map((k) => k.cmcId)).toEqual(keys.map((k) => k.cmcId));
    expect(q.map((r) => r.queueOrder)).toEqual(q.map((_, i) => i + 1));
    for (let i = 1; i < q.length; i++) expect(q[i]!.stars).toBeLessThanOrEqual(q[i - 1]!.stars);

    // Designed cases: TRIP 3★ 100 · BADD YES/YES/N/A 2★ 85 (lower bound) · YNY YES/NO/YES 2★ 75 ·
    // ZBAS N/A/YES/YES 2★ 40 (lower bound) · GAPD YES/N/A/N/A 1★ 60 (lower bound).
    const at = async (id: number) => {
      const r = await row(id);
      return {
        pattern: `${r.pass3d}/${r.pass7d}/${r.pass30d}`,
        stars: r.stars,
        points: r.weightedPassPoints,
        complete: r.scoreComplete,
        strength: r.weightedStrength === null ? null : 'set',
        order: r.queueOrder!,
      };
    };
    const trip = await at(S.TRIP);
    const badd = await at(S.BADD);
    const yny = await at(S.YNY);
    const zbas = await at(S.ZBAS);
    const gapd = await at(S.GAPD);
    expect(trip).toMatchObject({ pattern: 'YES/YES/YES', stars: 3, points: 100, complete: true });
    expect(badd).toMatchObject({ pattern: 'YES/YES/N/A', stars: 2, points: 85, complete: false });
    expect(yny).toMatchObject({ pattern: 'YES/NO/YES', stars: 2, points: 75, complete: true });
    expect(zbas).toMatchObject({
      pattern: 'N/A/YES/YES',
      stars: 2,
      points: 40,
      complete: false,
      strength: null,
    });
    expect(gapd).toMatchObject({ pattern: 'YES/N/A/N/A', stars: 1, points: 60, complete: false });
    // A 2-star 40-point row ranks ahead of a 1-star 60-point row.
    expect([trip.order, badd.order, yny.order, zbas.order, gapd.order]).toEqual(
      [trip.order, badd.order, yny.order, zbas.order, gapd.order].sort((a, b) => a - b),
    );
    expect(zbas.order).toBeLessThan(gapd.order);
  });

  it('flags Upbit-dominant and single-venue activity for review without rejecting it (p.15)', async () => {
    expect((await row(S.TRIP)).venueFlags).toContain('UPBIT_TOP_VENUE');
    expect((await row(S.SNGL)).venueFlags).toContain('SINGLE_VENUE');
    expect((await row(S.TRIP)).venueReview).toBe('PENDING');
  });

  it('exports five sheets with every mandatory column; N/A numerics are blank with a reason (p.17)', async () => {
    const run = await ctx.repo(ScanRun).findOneByOrFail({ batchId });
    expect(run.exportStatus).toBe('succeeded');
    const files = run.exportFiles!.map((f) => f.name).sort();
    expect(files).toEqual([
      'all_eligible.csv',
      'excluded.csv',
      'needs_review.csv',
      'review_queue.csv',
      'run_metadata.csv',
      'workbook.xlsx',
    ]);
    const csv = readFileSync(join(run.exportPath!, 'review_queue.csv'), 'utf8').split('\r\n');
    const header = csv[0]!.split(',');
    for (const c of MANDATORY_COLUMNS) expect(header).toContain(c);
    const all = readFileSync(join(run.exportPath!, 'all_eligible.csv'), 'utf8');
    expect(all).toMatch(/,SYNTHETIC\r\n/);
    const yny = all.split('\r\n').find((l) => l.includes(',990001,'))!;
    expect(yny).toContain(',YES,NO,YES,2,ELIGIBLE,');
    const needs = readFileSync(join(run.exportPath!, 'needs_review.csv'), 'utf8').split('\r\n');
    const gap = readFileSync(join(run.exportPath!, 'all_eligible.csv'), 'utf8')
      .split('\r\n')
      .find((l) => l.includes(',990007,'))!
      .split(',');
    expect(gap[header.indexOf('multiple_7d')]).toBe('');
    expect(gap[header.indexOf('reason_7d')]).toBe('DAILY_ROW_MISSING');
    expect(needs.length).toBeGreaterThan(3);
    expect(existsSync(join(run.exportPath!, 'manifest.json'))).toBe(true);
    const xlsx = readFileSync(join(run.exportPath!, 'workbook.xlsx'));
    expect(xlsx.subarray(0, 2).toString()).toBe('PK');
  });

  it('writes a dry-run Telegram summary labelled as test data', async () => {
    const d = await ctx.repo(TelegramDelivery).findBy({ mode: 'dry_run' });
    expect(d.length).toBeGreaterThan(0);
    expect(d.every((x) => x.status === 'dry_run')).toBe(true);
    expect(d[0]!.text).toMatch(/Test data<\/b>: a synthetic market/);
    expect(d[0]!.text).toMatch(/review queue/i);
  });

  it('provides a full calculation trace for one CMC id: 30 completed daily rows and every window (p.20 #2)', async () => {
    const t = (await ctx.app.get(ReadModelService).assetTrace(S.YNY, batchId)) as {
      daily: { used: Array<{ vmc: string | null; revision: number | null }> };
      windows: Array<{ days: number; formula: string; comparison: string | null }>;
      current: { formula: string };
    };
    expect(t.daily.used).toHaveLength(30);
    expect(t.daily.used.every((d) => d.vmc !== null && d.revision === 1)).toBe(true);
    expect(t.current.formula).toMatch(
      /^current_vmc = volume_24h \/ market_cap = 20000000 \/ 100000000 = 0\.2/,
    );
    expect(t.windows.find((w) => w.days === 3)!.formula).toBe(
      'mean_3d = (0.1 + 0.1 + 0.1) / 3 = 0.1',
    );
    expect(t.windows.find((w) => w.days === 7)!.comparison).toMatch(/→ NO/);
  });
});

describe('replay, revisions and human records', () => {
  it('replaying the same batch adds no snapshot, result or review and gives the same outcome (p.20 #5)', async () => {
    const reviews = ctx.app.get(ReviewService);
    await reviews.create({
      cmcId: S.YNY,
      batchId,
      reviewer: 'tester',
      venueDecision: 'ACCEPT',
      eventDay: 'FIRST',
      venueNote: 'volume spread over several venues',
    });
    const before = await counts();
    const hashes = new Map((await outcomes()).map((r) => [r.cmcId, r]));
    const r = await ctx.app.get(PipelineService).runSlot(slotOf(new Date()), { force: true });
    expect(r.status).not.toBe('failed');
    expect(r.batchId).toBe(batchId);
    // Re-crawl the same slot: first write wins, the batch keeps its id and crawl time.
    const batchBefore = await ctx.repo(CrawlBatch).findOneByOrFail({ id: batchId });
    const again = await ctx.app.get(IngestionService).collect(slotOf(new Date()), null, new Date());
    expect(again.batchId).toBe(batchId);
    expect((await ctx.repo(CrawlBatch).findOneByOrFail({ id: batchId })).crawledAt).toEqual(
      batchBefore.crawledAt,
    );
    await ctx.app.get(PipelineService).reprocess(batchId);
    expect(await counts()).toEqual(before);
    for (const a of await outcomes()) expect(a).toEqual(hashes.get(a.cmcId));
    const run = await ctx.repo(ScanRun).findOneByOrFail({ batchId });
    expect(run.attempts).toBeGreaterThanOrEqual(3);
  });

  it('daily rows: identical re-delivery is unchanged, a changed value becomes a new revision', async () => {
    const daily = ctx.app.get(DailyMetricsService);
    const cur = await ctx
      .repo(DailyMetric)
      .findOneOrFail({ where: { cmcId: S.YNY }, order: { dateUtc: 'DESC' } });
    const rev = await ctx.repo(DailyMetricRevision).findOneByOrFail({ id: cur.revisionId });
    const base = {
      cmcId: S.YNY,
      dateUtc: cur.dateUtc,
      volume: rev.volumeUsd!.toString(),
      marketCap: rev.marketCapUsd!.toString(),
      open: rev.openUsd?.toString() ?? null,
      high: rev.highUsd?.toString() ?? null,
      low: rev.lowUsd?.toString() ?? null,
      close: rev.closeUsd?.toString() ?? null,
      invalidReasons: [],
      periodStart: rev.periodStart,
      periodEnd: rev.periodEnd,
      sourceCloseAt: rev.sourceCloseAt,
      sourceFields: {},
    };
    const meta = {
      source: 'test',
      params: {},
      responseSha256: null,
      retrievedAt: new Date(),
      batchId: null,
    };
    expect(await daily.upsertRows('fixture', [base], meta)).toEqual({
      inserted: 0,
      revised: 0,
      unchanged: 1,
      invalid: 0,
    });
    expect(await daily.upsertRows('fixture', [{ ...base, volume: '12345678.9' }], meta)).toEqual({
      inserted: 0,
      revised: 1,
      unchanged: 0,
      invalid: 0,
    });
    const now = await ctx.repo(DailyMetric).findOneByOrFail({ cmcId: S.YNY, dateUtc: cur.dateUtc });
    expect(now.revision).toBe(2);
    expect(
      await ctx.repo(DailyMetricRevision).countBy({ cmcId: S.YNY, dateUtc: cur.dateUtc }),
    ).toBe(2);
    // Restore the fixture value as a third revision so later tests see the designed case.
    await daily.upsertRows('fixture', [base], meta);
  });

  it('daily refresh reports per-coin progress for the dashboard bar', async () => {
    const events: Array<[number, number]> = [];
    // Unknown CMC ids have no stored T−1 row, so both are due; the outcome of each fetch does not matter here.
    const report = await ctx.app.get(DailyMetricsService).refresh(
      'fixture',
      { id: batchId, crawledAt: new Date() },
      [
        { cmcId: 999_991, slug: null },
        { cmcId: 999_992, slug: null },
      ],
      (d, t) => events.push([d, t]),
    );
    expect(report.due).toBe(2);
    expect(events[0]).toEqual([0, 2]);
    expect(events.at(-1)).toEqual([report.attempted, 2]);
    expect(events.every(([d, t]) => d <= t)).toBe(true);
  });

  it('reviews are append-only revisions; plans are validated and kept INCOMPLETE until complete (p.26, p.27)', async () => {
    const reviews = ctx.app.get(ReviewService);
    const first = await ctx.repo(Review).findOneByOrFail({ cmcId: S.YNY, batchId, revision: 1 });
    const bad = await reviews.create({
      cmcId: S.YNY,
      batchId,
      reviewer: 'tester',
      eventDay: 'FIRST',
      finalDecision: 'PLAN_READY',
      lbankPair: 'YNY/USDT',
      rationale: 'test plan',
      plan: {
        entryPrice: '1.00',
        entryTime: '2026-11-05T00:00:00Z',
        stopPrice: '1.10',
        targets: [
          { price: '1.2', allocationPct: '40' },
          { price: '1.1', allocationPct: '30' },
          { price: '1.5', allocationPct: '30' },
        ],
        notes: 'n',
      },
    });
    expect(bad.validation.planStatus).toBe('INCOMPLETE');
    expect(bad.validation.errors.join(' ')).toMatch(/stop must be below entry/);
    expect(bad.validation.errors.join(' ')).toMatch(/TP2 must be above TP1/);
    const good = await reviews.create({
      cmcId: S.YNY,
      batchId,
      reviewer: 'tester',
      eventDay: 'FIRST',
      candleState: 'PRE_MOVE',
      marketRegime: 'UNCERTAIN',
      rangeLow: 'UNCERTAIN',
      finalDecision: 'PLAN_READY',
      lbankPair: 'YNY/USDT',
      chartExchange: 'LBank',
      chartSymbol: 'YNYUSDT',
      chartUrl: 'https://example.test/chart',
      chartTimezone: 'UTC',
      plan: {
        entryPrice: '1.00',
        entryTime: '2026-11-05T00:00:00Z',
        stopPrice: '0.86',
        targets: [
          { price: '1.2', allocationPct: '40' },
          { price: '1.35', allocationPct: '30' },
          { price: '1.5', allocationPct: '30' },
        ],
        notes: 'test only',
      },
    });
    expect(good.validation.planStatus).toBe('COMPLETE');
    expect((good.review.plan as { deadline: string }).deadline).toBe('2026-11-12T00:00:00.000Z');
    expect((good.review.plan as { stopPct: string }).stopPct).toBe('14');
    expect(good.validation.warnings.join(' ')).toMatch(/UNCERTAIN/);
    const revs = await ctx
      .repo(Review)
      .find({ where: { cmcId: S.YNY, batchId }, order: { revision: 'ASC' } });
    expect(revs.map((r) => r.revision)).toEqual([1, 2, 3]);
    expect(revs[2]!.supersedesId).toBe(revs[1]!.id);
    expect(revs[0]).toEqual(first);
    await expect(
      reviews.create({ cmcId: S.YNY, batchId, reviewer: 'tester', finalDecision: 'NO_TRADE' }),
    ).rejects.toBeInstanceOf(ReviewInputError);
    // An ambiguous (unconfirmed) LBank mapping is not a tradable pair for a PLAN_READY plan.
    await expect(
      reviews
        .create({
          cmcId: S.AMB,
          batchId,
          reviewer: 'tester',
          finalDecision: 'PLAN_READY',
          lbankPair: 'AMBX/USDT',
          plan: {
            entryPrice: '1',
            entryTime: '2026-11-05T00:00:00Z',
            stopPrice: '0.9',
            targets: [
              { price: '1.1', allocationPct: '50' },
              { price: '1.2', allocationPct: '25' },
              { price: '1.3', allocationPct: '25' },
            ],
            notes: 'x',
          },
        })
        .then((r) => r.validation.errors.join(' ')),
    ).resolves.toMatch(/not verified tradable/);
  });

  it('with LBANK_REQUIRE_MANUAL_VERIFICATION a listed pair waits for a reviewer; the verification makes it eligible', async () => {
    const manual = await makeApp({
      TIER1_VENUE_MAX_ASSETS_PER_RUN: '500',
      LBANK_REQUIRE_MANUAL_VERIFICATION: 'true',
    });
    try {
      await manual.app.get(PipelineService).reprocess(batchId, { export: false });
      const before = await row(S.UNV);
      expect([before.lbankStatus, before.eligibilityStatus, before.inQueue]).toEqual([
        'PAIR_LISTED_UNVERIFIED',
        'NEEDS_REVIEW',
        false,
      ]);
      const reviews = manual.app.get(ReviewService);
      await expect(
        reviews.decideVenue(
          { cmcId: S.UNV, decision: 'VERIFIED_TRADABLE', reviewer: 'tester' },
          'fixture',
        ),
      ).rejects.toBeInstanceOf(ReviewInputError);
      await reviews.decideVenue(
        {
          cmcId: S.UNV,
          marketPair: 'UNV/USDT',
          decision: 'VERIFIED_TRADABLE',
          reviewer: 'tester',
          note: 'checked on LBank: trading enabled',
        },
        'fixture',
      );
      await manual.app.get(PipelineService).reprocess(batchId, { export: false });
      const after = await row(S.UNV);
      expect([after.lbankStatus, after.eligibilityStatus, after.inQueue]).toEqual([
        'VERIFIED',
        'ELIGIBLE',
        true,
      ]);
    } finally {
      await manual.app.close();
    }
  });

  it('a mapping confirmation resolves the task and the ambiguous asset becomes VERIFIED on reprocess', async () => {
    const reviews = ctx.app.get(ReviewService);
    await reviews.decideVenue(
      { cmcId: S.AMB, marketPair: 'AMBX/USDT', decision: 'MAPPING_CONFIRMED', reviewer: 'tester' },
      'fixture',
    );
    expect((await ctx.repo(VenueMappingTask).findOneByOrFail({ cmcId: S.AMB })).status).toBe(
      'RESOLVED',
    );
    await ctx.app.get(PipelineService).reprocess(batchId, { export: false });
    expect((await row(S.AMB)).lbankStatus).toBe('VERIFIED');
  });

  it('records LBank listing transitions (ABSENT, then LISTED again)', async () => {
    const venues = ctx.app.get(VenuesService);
    const crawl = await ctx.repo(VenueCrawl).findOneByOrFail({ kind: 'lbank_spot_pairs', batchId });
    const pairs = crawl.pairs.filter((p) => p.baseCurrencyId !== S.ZERO);
    const t1 = new Date(Date.now() + 1000),
      t2 = new Date(Date.now() + 2000);
    expect(await venues.recordListingEvents('fixture', crawl.id, pairs as never, t1)).toEqual({
      listed: 0,
      absent: 1,
    });
    expect(await venues.recordListingEvents('fixture', crawl.id, crawl.pairs as never, t2)).toEqual(
      { listed: 1, absent: 0 },
    );
  });

  it("the Telegram report ends with the batch's Excel workbook as a document part", async () => {
    const parts = await ctx.app.get(ReportService).build(batchId);
    const doc = parseDocumentPart(parts.at(-1)!);
    expect(doc).not.toBeNull();
    expect(existsSync(doc!.path)).toBe(true);
    expect(doc!.filename).toMatch(/^coins-tier1_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}Z_SYNTHETIC\.xlsx$/);
    expect(doc!.caption).toMatch(/test data/);
    expect(parts.slice(0, -1).every((p) => parseDocumentPart(p) === null)).toBe(true);
  });

  it('an incomplete batch withholds the queue, and the Telegram summary says why (p.18)', async () => {
    await ctx
      .repo(CrawlBatch)
      .update({ id: batchId }, { status: 'INCOMPLETE', statusReasons: ['missing_ranks:1'] });
    const r = await ctx.app.get(PipelineService).reprocess(batchId, { export: false });
    expect(r.scan!.queueStatus).toBe('WITHHELD_INCOMPLETE_BATCH');
    const parts = await ctx.app.get(ReportService).build(batchId);
    expect(parts.join('\n')).toMatch(/Review queue withheld/);
    expect(parts.join('\n')).not.toMatch(/<pre>|\/coin_/); // no coin cards for a withheld queue
    expect(parts.some((p) => parseDocumentPart(p) !== null)).toBe(false); // no workbook for a withheld queue
    await ctx.repo(CrawlBatch).update({ id: batchId }, { status: 'COMPLETE', statusReasons: [] });
  });

  it('an unavailable LBank feed makes every asset NEEDS_REVIEW (UNKNOWN) and withholds the queue', async () => {
    await ctx.repo(VenueCrawl).update({ kind: 'lbank_spot_pairs' }, { status: 'FAILED' });
    const r = await ctx.app.get(PipelineService).reprocess(batchId, { export: false });
    expect(r.scan!.queueStatus).toBe('WITHHELD_LBANK_UNAVAILABLE');
    expect(await ctx.repo(ScanResult).countBy({ batchId, eligibilityStatus: 'ELIGIBLE' })).toBe(0);
    expect((await row(S.YNY)).eligibilityReasons).toContain(
      'LBANK_STATUS_UNKNOWN:LBANK_FEED_FAILED',
    );
    expect(r.scan!.warnings.join(' ')).toMatch(/LBANK_FEED_UNAVAILABLE/);
    await ctx.repo(VenueCrawl).update({ kind: 'lbank_spot_pairs' }, { status: 'COMPLETE' });
  });
});

describe('LBank Spot markets list: fetched once, refreshed every N days or on demand (D2)', () => {
  const DAY = 86_400_000;
  const lists = () =>
    ctx
      .repo(VenueCrawl)
      .find({ where: { kind: 'lbank_spot_pairs' }, order: { finishedAt: 'ASC' } });

  it('later runs reuse the stored list instead of fetching it again', async () => {
    const before = await lists();
    const r = await ctx.app
      .get(VenuesService)
      .ensureLbankPairs('fixture', batchId, new Date(), { trigger: 'schedule' });
    expect([r.status, r.usable, r.crawlId]).toEqual(['REUSED', true, before.at(-1)!.id]);
    expect(Date.parse(r.nextRefreshAt!) - Date.parse(r.listFetchedAt!)).toBe(30 * DAY);
    expect((await lists()).length).toBe(before.length);
  });

  it('a list older than LBANK_PAIRS_REFRESH_DAYS is fetched again by the next run', async () => {
    await ctx
      .repo(VenueCrawl)
      .update({ kind: 'lbank_spot_pairs' }, { finishedAt: new Date(Date.now() - 31 * DAY) });
    const before = (await lists()).length;
    const r = await ctx.app
      .get(VenuesService)
      .ensureLbankPairs('fixture', batchId, new Date(), { trigger: 'schedule' });
    expect([r.status, r.usable]).toEqual(['COMPLETE', true]);
    const after = await lists();
    expect(after.length).toBe(before + 1);
    expect((after.at(-1)!.summary as { trigger: string }).trigger).toBe('schedule');
  });

  it('the manual refresh fetches now, recomputes the latest batch and reports the list status', async () => {
    const before = (await lists()).length;
    const r = await ctx.app.get(PipelineService).refreshLbankPairs();
    if ('skipped' in r) throw new Error(r.skipped);
    expect([r.lbank.status, r.batchId]).toEqual(['COMPLETE', batchId]);
    expect(r.scan!.warnings.join(' ')).toMatch(/LBANK_LIST_REFRESHED/);
    const after = await lists();
    expect(after.length).toBe(before + 1);
    expect((after.at(-1)!.summary as { trigger: string }).trigger).toBe('manual');
    const status = await ctx.app.get(VenuesService).lbankListStatus('fixture');
    expect(status).toMatchObject({ crawlId: after.at(-1)!.id, stale: false, trigger: 'manual' });
  });

  it('a list older than LBANK_PAIRS_MAX_AGE_DAYS is stale: LBank UNKNOWN and the queue withheld', async () => {
    const saved = await lists();
    await ctx
      .repo(VenueCrawl)
      .update({ kind: 'lbank_spot_pairs' }, { finishedAt: new Date(Date.now() - 40 * DAY) });
    try {
      const r = await ctx.app.get(PipelineService).reprocess(batchId, { export: false });
      expect(r.scan!.queueStatus).toBe('WITHHELD_LBANK_UNAVAILABLE');
      expect(r.scan!.warnings.join(' ')).toMatch(/older than 35 days/);
      expect((await row(S.TRIP)).eligibilityReasons).toContain(
        'LBANK_STATUS_UNKNOWN:LBANK_FEED_STALE',
      );
    } finally {
      for (const c of saved)
        await ctx.repo(VenueCrawl).update({ id: c.id }, { finishedAt: c.finishedAt });
      await ctx.app.get(PipelineService).reprocess(batchId, { export: false });
    }
  });
});
