import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { D } from '../src/common/utils/decimal.js';
import { slotOf } from '../src/common/utils/time.js';
import { ForwardEvent } from '../src/modules/forward-test/entities/forward-event.entity.js';
import { ForwardLegacyClosure } from '../src/modules/forward-test/entities/forward-legacy-closure.entity.js';
import { ForwardOutcome } from '../src/modules/forward-test/entities/forward-outcome.entity.js';
import { ForwardCaptureService } from '../src/modules/forward-test/forward-capture.service.js';
import { ForwardRetirementService } from '../src/modules/forward-test/forward-retirement.service.js';
import { ForwardTestService } from '../src/modules/forward-test/forward-test.service.js';
import { CrawlBatch } from '../src/modules/ingestion/entities/crawl-batch.entity.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';
import { CandleStoreService } from '../src/modules/lbank-observation/candle-store.service.js';
import { ObsEvent } from '../src/modules/lbank-observation/entities/obs-event.entity.js';
import { ObsIntakeRun } from '../src/modules/lbank-observation/entities/obs-intake-run.entity.js';
import { ObservationResult } from '../src/modules/lbank-observation/entities/observation-result.entity.js';
import { Observation } from '../src/modules/lbank-observation/entities/observation.entity.js';
import { SpotCandle } from '../src/modules/lbank-observation/entities/spot-candle.entity.js';
import {
  type FuturesContract,
  parseKlineResponse,
} from '../src/modules/lbank-observation/kline.js';
import {
  type KlineFetch,
  LBANK_MARKET_SOURCE,
  type LbankMarketSource,
  type ListFetch,
} from '../src/modules/lbank-observation/lbank-market.source.js';
import { ObservationIntakeService } from '../src/modules/lbank-observation/observation-intake.service.js';
import { ObservationReadService } from '../src/modules/lbank-observation/observation-read.service.js';
import { ObservationUpdateService } from '../src/modules/lbank-observation/observation-update.service.js';
import { PipelineService } from '../src/modules/pipeline/pipeline.service.js';
import { CutoverService } from '../src/modules/star-events/cutover.service.js';
import type {
  TriggerBatch,
  TriggerRow,
} from '../src/modules/star-events/published-queue.service.js';
import type { ResolvedPair } from '../src/modules/strategy/index.js';
import { VenueCrawl } from '../src/modules/venues/entities/venue-crawl.entity.js';

import { resetDb, testConfig } from './utils/helpers.js';

/**
 * LBank Spot Price Observation against PostgreSQL (docs/lbank-spot-observation.md): cutover routing
 * enforced by the database, intake exactly once, candle collection shared per pair, the exact
 * 168-hour window, missing data, eligibility evidence, reads, and the legacy wind-down. LBank is a
 * programmable fake; every value is SYNTHETIC.
 */
const P = 'fixture';
const MIN = 60_000;
const H = 3_600_000;
const t = (s: string) => new Date(s);
const CUTOVER = t('2030-01-02T00:00:00.000Z');

/** A fake LBank that follows the recorded API conventions (OPEN = previous CLOSE, filled minutes). */
class FakeLbank implements LbankMarketSource {
  readonly id = 'fake';
  readonly isLive = false;
  nowMs = 0;
  unsupported = new Set<string>();
  /** symbol → minute ranges [from, to) the API serves no bar for. */
  gaps = new Map<string, Array<[number, number]>>();
  listedFrom = new Map<string, number>();
  /** symbol → minute → [high, low] overrides (others are flat at 1). */
  shape = new Map<string, Map<number, [string, string]>>();
  spot: string[] = [];
  futures: FuturesContract[] = [];
  requests: Array<{ symbol: string; fromMs: number; size: number }> = [];

  private inGap(symbol: string, m: number) {
    return (this.gaps.get(symbol) ?? []).some(([f, to]) => m >= f && m < to);
  }

  async klines(symbol: string, fromMs: number, size: number): Promise<KlineFetch> {
    this.requests.push({ symbol, fromMs, size });
    const ts = this.nowMs;
    let body: string;
    if (this.unsupported.has(symbol)) {
      body = `{"result":"false","msg":"currency pair nonsupport","error_code":10008,"ts":${ts}}`;
    } else {
      const rows: string[] = [];
      const first = Math.max(Math.floor(fromMs / MIN) * MIN, this.listedFrom.get(symbol) ?? 0);
      for (let m = first; m <= Math.floor(ts / MIN) * MIN && rows.length < size; m += MIN) {
        if (this.inGap(symbol, m)) continue;
        const [h, l] = this.shape.get(symbol)?.get(m) ?? ['1', '1'];
        rows.push(`[${m / 1000},1,${h},${l},1,5]`);
      }
      body = `{"msg":"Success","result":"true","data":[${rows.join(',')}],"error_code":0,"ts":${ts}}`;
    }
    return {
      url: `fake://${symbol}`,
      requestedAt: new Date(ts),
      durationMs: 0,
      response: parseKlineResponse(body),
    };
  }

  async spotPairs(): Promise<ListFetch<string>> {
    return {
      ok: true,
      url: 'fake://pairs',
      fetchedAt: new Date(this.nowMs),
      items: [...this.spot],
      sha256: 'x',
    };
  }

  async futuresContracts(): Promise<ListFetch<FuturesContract>> {
    return {
      ok: true,
      url: 'fake://futures',
      fetchedAt: new Date(this.nowMs),
      items: [...this.futures],
      sha256: 'y',
    };
  }
}

let app: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
let db: DataSource;
const lbank = new FakeLbank();

beforeAll(async () => {
  const mod = await Test.createTestingModule({
    imports: [AppModule.forRoot(testConfig({ LBANK_CANDLE_RETENTION_DAYS: '0' }), { http: false })],
  })
    .overrideProvider(LBANK_MARKET_SOURCE)
    .useValue(lbank)
    .compile();
  mod.useLogger(false);
  await mod.init();
  app = mod;
  db = mod.get(DataSource);
});
afterAll(async () => app.close());
beforeEach(async () => {
  await resetDb(db);
  await app.get(IngestionService).ensureProvider();
  Object.assign(lbank, {
    nowMs: 0,
    unsupported: new Set(),
    gaps: new Map(),
    listedFrom: new Map(),
    shape: new Map(),
    spot: ['abc_usdt', 'def_usdt', 'thin_usdt'],
    futures: [{ symbol: 'ABCUSDT', base: 'ABC', quote: 'USDT', volume24h: '1000' }],
    requests: [],
  });
});

async function setCutover() {
  return app.get(CutoverService).set(P, CUTOVER, { now: t('2030-01-01T12:00:00Z'), setBy: 'test' });
}

async function batch(crawledAt: string): Promise<TriggerBatch> {
  const at = t(crawledAt);
  const repo = db.getRepository(CrawlBatch);
  // One batch per hourly slot (as the crawler stores them); sightings of one slot share it.
  const existing = await repo.findOneBy({ providerId: P, slotTime: slotOf(at) });
  if (existing)
    return {
      id: existing.id,
      providerId: P,
      slotTime: existing.slotTime,
      crawledAt: existing.crawledAt,
      status: 'COMPLETE',
      isLive: false,
    };
  const b = await repo.save(
    repo.create({
      providerId: P,
      slotTime: slotOf(at),
      isLive: false,
      startedAt: at,
      finishedAt: at,
      crawledAt: at,
      status: 'COMPLETE',
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
    crawledAt: at,
    status: 'COMPLETE',
    isLive: false,
  };
}

const usdt = (sym: string): ResolvedPair => ({
  marketPair: `${sym.toUpperCase()}/USDT`,
  baseSymbol: sym.toUpperCase(),
  quoteSymbol: 'USDT',
  mapping: 'OK',
  trading: 'TRADING',
  tradingSource: 'listing',
  volumeUsd: '100000',
  lastUpdated: null,
  marketUrl: `https://www.lbank.com/en-US/trade/${sym}_usdt/?icode=670BP`,
  evidence: ["listed in CMC's LBank Spot markets (synthetic)"],
  decisionIds: [],
});

function row(
  cmcId: number,
  sym: string,
  stars: number,
  observedAt: string,
  over: Partial<TriggerRow> = {},
): TriggerRow {
  const at = t(observedAt);
  return {
    cmcId,
    stars,
    inQueue: true,
    eligibilityStatus: 'ELIGIBLE',
    lbankStatus: 'VERIFIED',
    price: new D('1.002'),
    currentStatus: 'OK',
    sourceUpdatedAt: new Date(at.getTime() - 2 * MIN),
    observedAt: at,
    identityUnique: true,
    symbol: sym.toUpperCase(),
    name: `${sym} (synthetic)`,
    slug: sym,
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
    multiple7d: stars >= 2 ? new D('2') : new D('1.2'),
    multiple30d: stars >= 3 ? new D('2') : new D('1.2'),
    pass3d: 'YES',
    pass7d: stars >= 2 ? 'YES' : 'NO',
    pass30d: stars >= 3 ? 'YES' : 'NO',
    queueOrder: 1,
    weightedPassPoints: stars === 3 ? 100 : stars === 2 ? 85 : 60,
    scoreComplete: true,
    weightedStrength: new D('1.5'),
    rankingRulesetVersion: 'weighted_star_v1',
    lbankPairs: [usdt(sym)],
    rulesetVersion: 'vmc-tier1-2',
    configVersion: 'test',
    inputsHash: 'test',
    scanSnapshot: { synthetic: true },
    ...over,
  };
}

async function intake(r: TriggerRow) {
  const b = await batch(r.observedAt!.toISOString());
  return app
    .get(ObservationIntakeService)
    .intake(b, 'PUBLISHED', [r], CUTOVER, { now: new Date(r.observedAt!.getTime() + 5 * MIN) });
}

async function runJob(atIso: string) {
  lbank.nowMs = t(atIso).getTime();
  return app.get(ObservationUpdateService).run(P, { now: t(atIso), trigger: 'cli' });
}

const obsOf = async (cmcId: number, stars?: number) => {
  const e = await db
    .getRepository(ObsEvent)
    .findOneByOrFail(stars ? { cmcId, starCount: stars } : { cmcId });
  return db.getRepository(Observation).findOneByOrFail({ eventId: e.id });
};

describe('cutover and routing', () => {
  it('routes each sighting to exactly one tracker at a UTC-midnight cutover, enforced by the database', async () => {
    const cut = app.get(CutoverService);
    await expect(
      cut.set(P, t('2030-01-02T03:30:00Z'), { now: t('2030-01-01T12:00:00Z'), setBy: 't' }),
    ).rejects.toThrow(/UTC/);
    await expect(
      cut.set(P, CUTOVER, { now: t('2030-01-01T23:00:00Z'), setBy: 't' }),
    ).rejects.toThrow(/future/);
    expect(await setCutover()).toMatchObject({ cutoverAt: CUTOVER.toISOString(), passed: false });

    // Legacy before, LBank observation from the cutover instant on.
    const legacy = await app
      .get(ForwardCaptureService)
      .capture(
        await batch('2030-01-01T23:59:59.999Z'),
        'PUBLISHED',
        [row(1, 'abc', 2, '2030-01-01T23:59:59.999Z')],
        {
          now: t('2030-01-02T00:04:00Z'),
        },
      );
    expect(legacy.created).toHaveLength(1);
    const fresh = await intake(row(1, 'abc', 2, '2030-01-02T00:00:00.000Z'));
    expect(fresh.created).toHaveLength(1);

    // The database refuses an event in the wrong tracker, whatever code tries.
    await expect(
      app
        .get(ForwardCaptureService)
        .capture(
          await batch('2030-01-02T01:07:00Z'),
          'PUBLISHED',
          [row(2, 'def', 1, '2030-01-02T01:07:00Z')],
          {
            now: t('2030-01-02T01:10:00Z'),
          },
        ),
    ).rejects.toThrow(/legacy forward test takes no new events/);
    const early = await batch('2030-01-01T22:07:00Z');
    const r = await app
      .get(ObservationIntakeService)
      .intake(early, 'PUBLISHED', [row(2, 'def', 1, '2030-01-01T22:07:00Z')], CUTOVER, {
        now: t('2030-01-01T22:10:00Z'),
      });
    expect(r.rejected[0]!.reasons).toContain('BEFORE_CUTOVER');
    await expect(
      db.query(
        `INSERT INTO lbank_obs_event (provider_id, cmc_id, detected_utc_date, star_count, detected_at, source_updated_at, source_batch_id, slot_time, is_live, cmc_price_usd, symbol, name, pass_3d, pass_7d, pass_30d, lbank_pairs, ruleset_version, config_version, inputs_hash, scan_snapshot)
         VALUES ($1, 3, '2030-01-01', 1, '2030-01-01T10:00:00Z', '2030-01-01T10:00:00Z', $2, '2030-01-01T10:00:00Z', false, 1, 'X', 'X', 'YES', 'NO', 'NO', '[]', 'r', 'c', 'h', '{}')`,
        [P, early.id],
      ),
    ).rejects.toThrow(/before the cutover/);

    expect(await db.getRepository(ForwardEvent).count()).toBe(1);
    expect(await db.getRepository(ObsEvent).count()).toBe(1);
    // A cutover is fixed once it has passed (database guard; the real clock is past 2026 here).
    await db
      .query(`UPDATE signal_cutover SET cutover_at = '2026-01-01T00:00:00Z'`)
      .catch(() => undefined);
    await expect(db.query(`UPDATE signal_cutover SET note = 'x'`)).rejects.toThrow(
      /can no longer change/,
    );
  });

  it('opens one event per (coin, UTC date, stars) with its observation, exactly once', async () => {
    await setCutover();
    const A = await intake(row(1, 'abc', 2, '2030-01-02T10:00:00Z'));
    const dupe = await intake(row(1, 'abc', 2, '2030-01-02T11:00:00Z'));
    const B = await intake(row(1, 'abc', 3, '2030-01-02T15:00:00Z'));
    await intake(row(1, 'abc', 2, '2030-01-02T18:00:00Z'));
    const C = await intake(row(1, 'abc', 2, '2030-01-03T09:00:00Z'));
    expect([A.created.length, dupe.created.length, B.created.length, C.created.length]).toEqual([
      1, 0, 1, 1,
    ]);
    expect(dupe.ignored[0]!.eventId).toBe(A.created[0]!.eventId);
    expect(await db.getRepository(ObsEvent).count()).toBe(3);
    expect(await db.getRepository(Observation).count()).toBe(3);
    const a = await db.getRepository(ObsEvent).findOneByOrFail({ id: A.created[0]!.eventId });
    expect(a.detectedAt.toISOString()).toBe('2030-01-02T10:00:00.000Z');

    // Concurrent intakes of one batch cannot duplicate an event or an observation.
    const b = await batch('2030-01-04T10:00:00Z');
    const svc = app.get(ObservationIntakeService);
    const rows = [
      row(2, 'def', 1, '2030-01-04T10:00:00Z'),
      row(3, 'thin', 1, '2030-01-04T10:00:00Z', { stars: 0, inQueue: false }),
    ];
    await Promise.all(
      [1, 2, 3].map(() =>
        svc.intake(b, 'PUBLISHED', rows, CUTOVER, { now: t('2030-01-04T10:03:00Z') }),
      ),
    );
    expect(await db.getRepository(ObsEvent).countBy({ cmcId: 2 })).toBe(1);
    expect(await db.getRepository(Observation).count()).toBe(4);
    // No missed row: every queue row is created, ignored or rejected with reasons.
    for (const run of await db.getRepository(ObsIntakeRun).find())
      expect(run.created + run.ignored + run.rejected).toBe(run.queueRows);
    const check = await app.get(ObservationReadService).routingCheck();
    expect(check).toMatchObject({
      intakeRowsUnaccounted: 0,
      eventsWithoutObservation: 0,
      legacyEventsAfterCutover: 0,
      duplicateKeysAcrossTrackers: 0,
    });
  });
});

describe('LBank Spot measurement', () => {
  it('measures the two extremes over exactly t0 + 168 h from shared candles, then freezes the result', async () => {
    await setCutover();
    const t0 = t('2030-01-02T00:07:00.078Z');
    const entry = t('2030-01-02T00:08:00.000Z').getTime();
    const end = t('2030-01-09T00:07:00.000Z').getTime(); // the bar here straddles the cutoff
    lbank.shape.set(
      'abc_usdt',
      new Map([
        [entry - 30 * MIN, ['7', '1']], // before the signal: never counted
        [entry + 100 * MIN, ['1.25', '1']], // highest High after entry
        [entry + 3000 * MIN, ['1', '0.8']], // lowest Low
        [end, ['9', '0.01']], // extends past t0 + 168 h: never counted
      ]),
    );
    await db.getRepository(VenueCrawl).save(
      db.getRepository(VenueCrawl).create({
        providerId: P,
        kind: 'lbank_futures_pairs',
        cmcId: null,
        batchId: null,
        startedAt: t('2030-01-01T20:00:00Z'),
        finishedAt: t('2030-01-01T20:00:05Z'),
        status: 'COMPLETE',
        expectedCount: 1,
        fetchedCount: 1,
        requests: 1,
        pairs: [
          {
            exchange: 'lbank',
            exchangeName: 'LBank',
            marketPair: 'ABC/USDT',
            category: 'perpetual',
            baseSymbol: 'ABC',
            baseCurrencyId: 1,
            quoteSymbol: 'USDT',
            quoteCurrencyId: 825,
            volumeUsd: null,
            volumePercent: null,
            priceUsd: null,
            lastUpdated: null,
            marketUrl: 'https://www.lbank.com/futures/abcusdt/',
            tradingStatus: null,
            type: 'cex',
            flags: [],
          },
        ],
        summary: null,
        source: 'test',
        sourceParams: {},
        responseSha256: ['test'],
        error: null,
        notes: [],
      }),
    );
    await intake(row(1, 'abc', 3, t0.toISOString(), { price: new D('1.003') }));

    await runJob('2030-01-02T00:20:00Z');
    let o = await obsOf(1);
    expect(o.status).toBe('ACTIVE');
    expect(o.mappingStatus).toBe('OK');
    expect(o.pairSymbol).toBe('abc_usdt');
    expect(o.entryAt!.toISOString()).toBe('2030-01-02T00:08:00.000Z');
    expect(o.entryPrice!.toFixed()).toBe('1');
    expect(o.entryDelayMs).toBe(59_922);
    expect(o.eligibility).toBe('SPOT_AND_FUTURES');
    expect(o.spotStatus).toBe('YES');
    expect(o.futuresStatus).toBe('YES');
    expect(o.maxRisePct!.toFixed()).toBe('0');

    await runJob('2030-01-09T00:20:00Z');
    o = await obsOf(1);
    expect(o.status).toBe('FINAL');
    expect(o.reasons).toEqual([]);
    expect(o.expectedBars).toBe(10_079);
    expect(o.coveredBars).toBe(10_079);
    expect(o.missingBars).toBe(0);
    expect(o.boundaryUnobservedMs).toBe(78);
    expect(o.highPrice!.toFixed()).toBe('1.25');
    expect(o.highBarAt!.getTime()).toBe(entry + 100 * MIN);
    expect(o.lowPrice!.toFixed()).toBe('0.8');
    expect(o.lowBarAt!.getTime()).toBe(entry + 3000 * MIN);
    expect(o.maxRisePct!.toFixed()).toBe('25');
    expect(o.maxDropPct!.toFixed()).toBe('-20');
    expect(o.extremeOrder).toBe('HIGH_FIRST');
    expect(o.lowBeforeHighPrice!.toFixed()).toBe('1');
    expect(o.finalizedAt).not.toBeNull();
    expect(o.seriesSha256).toMatch(/^[0-9a-f]{64}$/);
    const results = await db.getRepository(ObservationResult).findBy({ observationId: o.id });
    expect(results.map((r) => [r.resultVersion, r.status])).toEqual([[1, 'FINAL']]);
    // Stored candles stop at what the window needs: 60 look-back bars (23:08 … 00:07, the last one
    // opened 78 ms before t0) and the 10 079 window bars; the bar straddling the cutoff is not stored.
    expect(await db.getRepository(SpotCandle).count()).toBe(60 + 10_079);

    // Frozen: neither the observation nor its result can change; the event is immutable.
    await expect(
      db.query(`UPDATE lbank_observation SET max_rise_pct = 99 WHERE id = $1`, [o.id]),
    ).rejects.toThrow(/frozen/);
    await expect(db.query(`DELETE FROM lbank_observation_result`)).rejects.toThrow(/append-only/);
    await expect(db.query(`UPDATE lbank_obs_event SET cmc_price_usd = 2`)).rejects.toThrow(
      /immutable/,
    );
    const runs = (await runJob('2030-01-09T01:20:00Z')).finalized;
    expect(runs).toBe(0);
  });

  it('overlapping events of one pair share one set of candles', async () => {
    await setCutover();
    await intake(row(1, 'abc', 1, '2030-01-02T00:07:00Z'));
    await intake(row(1, 'abc', 2, '2030-01-02T06:07:00Z'));
    await runJob('2030-01-02T12:00:00Z');
    const stored = await db.getRepository(SpotCandle).count();
    // t0 on a minute: that bar is the entry. One hour of look-back, then every closed minute (11:58
    // is the last one closed at 12:00:00 with the 5 s margin).
    expect(stored).toBe(
      (t('2030-01-02T11:59:00Z').getTime() - t('2030-01-02T00:07:00Z').getTime()) / MIN + 60,
    );
    expect(lbank.requests.filter((r) => r.symbol === 'abc_usdt' && r.fromMs > 1000)).toHaveLength(
      1,
    );
    const [a, b] = [await obsOf(1, 1), await obsOf(1, 2)];
    expect([a.status, b.status]).toEqual(['ACTIVE', 'ACTIVE']);
    expect(b.entryAt!.toISOString()).toBe('2030-01-02T06:07:00.000Z');
    expect([a.entryDelayMs, b.entryDelayMs]).toEqual([0, 0]);

    // Retention: never a bar an unfinished observation needs; old bars once every one is final.
    const candles = app.get(CandleStoreService);
    expect(await candles.prune(t('2030-01-20T00:00:00Z'), 7)).toBe(0);
    await db.query(`UPDATE lbank_observation SET finalized_at = '2030-01-09T12:00:00Z'`);
    expect(await candles.prune(t('2030-01-20T00:00:00Z'), 7)).toBe(stored);
    expect(await candles.prune(t('2030-01-20T00:00:00Z'), 0)).toBe(0);
  });

  it('missing minutes keep an observation out of FINAL; delisted, illiquid and ambiguous cases say so', async () => {
    await setCutover();
    const t0 = '2030-01-02T00:07:00Z';
    // A 30-minute hole inside the window that never comes back.
    lbank.gaps.set('abc_usdt', [
      [t('2030-01-03T00:00:00Z').getTime(), t('2030-01-03T00:30:00Z').getTime()],
    ]);
    lbank.unsupported.add('def_usdt');
    await intake(row(1, 'abc', 1, t0));
    await intake(row(2, 'def', 1, t0));
    await intake(
      row(4, 'ghi', 1, t0, {
        lbankPairs: [
          usdt('ghi'),
          {
            ...usdt('ghi'),
            marketPair: 'GHI2/USDT',
            marketUrl: 'https://www.lbank.com/en-US/trade/ghi2_usdt/',
          },
        ],
      }),
    );
    await intake(
      row(5, 'jkl', 1, t0, {
        lbankPairs: [
          {
            ...usdt('jkl'),
            quoteSymbol: 'USDC',
            marketUrl: 'https://www.lbank.com/en-US/trade/jkl_usdc/',
          },
        ],
      }),
    );

    await runJob('2030-01-02T00:30:00Z');
    expect((await obsOf(2)).status).toBe('DATA_UNAVAILABLE');
    expect((await obsOf(2)).reasons).toContain('PAIR_UNSUPPORTED_BY_API');
    expect((await obsOf(2)).eligibility).toBe('SPOT_UNAVAILABLE');
    expect((await obsOf(4)).status).toBe('MAPPING_AMBIGUOUS');
    expect((await obsOf(5)).status).toBe('DATA_UNAVAILABLE');
    expect((await obsOf(5)).reasons).toEqual(['NO_USDT_PAIR']);

    await runJob('2030-01-09T00:30:00Z');
    let o = await obsOf(1);
    expect(o.status).toBe('ACTIVE'); // gaps are retried for a day after the window
    expect(o.missingBars).toBe(30);
    expect(o.missingRanges).toEqual([['2030-01-03T00:00:00.000Z', '2030-01-03T00:30:00.000Z']]);
    await runJob('2030-01-10T00:30:00Z');
    o = await obsOf(1);
    expect(o.status).toBe('PARTIAL');
    expect(o.reasons).toContain('MISSING_BARS');
    expect(o.maxRisePct).not.toBeNull(); // provisional extremes stay visible
    const summary = await app.get(ObservationReadService).summary();
    expect(summary.summary.final.events).toBe(0); // never in final statistics
    expect(summary.summary.byStatus.PARTIAL.events).toBe(1);
  });

  it('classifies Spot / Futures from evidence before and after the signal; unknown stays unknown', async () => {
    await setCutover();
    // No CMC futures list before the signal: Futures UNKNOWN even though LBank lists ABCUSDT now.
    await intake(row(1, 'abc', 1, '2030-01-02T00:07:00Z'));
    await runJob('2030-01-02T00:20:00Z');
    const o = await obsOf(1);
    expect(o.futuresStatus).toBe('UNKNOWN');
    expect(o.eligibility).toBe('SPOT_FUTURES_UNKNOWN');
    expect((o.eligibilityEvidence as { futures: { reasons: string[] } }).futures.reasons).toEqual([
      'FUTURES_LIST:LIST_NOT_FETCHED',
    ]);
  });

  it('lists, filters, sorts, summarizes and exports observations', async () => {
    await setCutover();
    await intake(row(1, 'abc', 3, '2030-01-02T00:07:00Z'));
    await intake(row(2, 'def', 1, '2030-01-02T00:07:00Z'));
    lbank.unsupported.add('def_usdt');
    // LBank's own "nonsupport" answer 13 minutes after the signal is evidence at the signal (the
    // same answer a week later would not be: that observation would stay SPOT_UNKNOWN).
    await runJob('2030-01-02T00:20:00Z');
    await runJob('2030-01-09T00:20:00Z');
    const read = app.get(ObservationReadService);
    const all = await read.list({});
    expect(all.total).toBe(2);
    expect((await read.list({ status: 'FINAL' })).rows.map((r) => r.symbol)).toEqual(['ABC']);
    expect(
      (await read.list({ eligibility: 'SPOT_UNAVAILABLE' })).rows.map((r) => r.symbol),
    ).toEqual(['DEF']);
    expect((await read.list({ stars: 3 })).total).toBe(1);
    expect((await read.list({ coverage: 'complete' })).total).toBe(1);
    expect((await read.list({ search: 'de' })).rows.map((r) => r.symbol)).toEqual(['DEF']);
    expect((await read.list({ sort: 'rise', dir: 'desc' })).rows[0]!.symbol).toBe('ABC');
    const abc = (await read.list({ search: 'abc' })).rows[0]!;
    expect(abc.cmcPriceUsd).toBe('1.002');
    expect(abc.entry!.price).toBe('1');
    expect(abc.provisional).toBe(false);
    const s = await read.summary();
    expect(s.summary.final).toMatchObject({ events: 1, coins: 1 });
    expect(s.summary.unmeasured).toEqual({ events: 1, coins: 1 });
    expect(s.priceSource).toMatch(/LBank Spot/);
    const csv = await read.csv({});
    expect(csv.split('\n')[0]).toMatch(/^observation_id,event_id,cmc_id/);
    expect(csv.trim().split('\n')).toHaveLength(3);
    expect(csv).toContain('SYNTHETIC');
  });
});

describe('legacy forward test wind-down', () => {
  async function legacyEvent(
    cmcId: number,
    at: string,
    status: ForwardEvent['status'],
    peak: 'EXACT' | 'LOWER_BOUND' | 'NONE',
  ) {
    const r = await app
      .get(ForwardCaptureService)
      .capture(await batch(at), 'PUBLISHED', [row(cmcId, `c${cmcId}`, 1, at)], {
        now: new Date(t(at).getTime() + 5 * MIN),
      });
    const id = r.created[0]!.eventId;
    await db.getRepository(ForwardEvent).update({ id }, { status, resultVersion: 1 });
    await db.getRepository(ForwardOutcome).insert({
      eventId: id,
      resultVersion: 1,
      revisionReason: 'first',
      rulesVersion: 'star-forward-2',
      status,
      coverageStatus: status === 'FINAL' ? 'COMPLETE' : 'INCOMPLETE',
      peakKind: peak,
      peakReturnPct: (peak === 'NONE' ? null : '12.5') as never,
      effectiveHorizonHours: '180' as never,
      day0State: 'EXACT',
      expectedDays: 8,
      completedDays: 8,
      coveredDays: peak === 'NONE' ? 0 : 7,
      missingDates: peak === 'EXACT' ? [] : ['2029-12-30'],
      invalidDates: [],
      reasons: peak === 'EXACT' ? [] : ['HIGH_MISSING'],
      highIds: [] as never,
      contentHash: 'x',
      computedAt: t(at),
    });
    return id;
  }

  it('records explicit terminal outcomes, retires once all are terminal, then stops updating', async () => {
    await setCutover();
    await legacyEvent(11, '2029-12-20T10:07:00Z', 'FINAL', 'EXACT');
    await legacyEvent(12, '2029-12-25T10:07:00Z', 'INCOMPLETE', 'LOWER_BOUND');
    await legacyEvent(13, '2029-12-26T10:07:00Z', 'AWAITING_FINAL_DAY', 'NONE');
    const retire = app.get(ForwardRetirementService);

    // Before the retries end (evaluation_end + 3 days) only the FINAL event is terminal.
    let s = await retire.evaluate(P, t('2030-01-03T00:00:00Z'), { write: true });
    expect(s).toMatchObject({ state: 'closing', events: 3, terminal: 1, pending: 2 });
    expect(await db.getRepository(ForwardLegacyClosure).count()).toBe(1);

    s = await retire.evaluate(P, t('2030-01-06T00:00:00Z'), { write: true });
    expect(s.state).toBe('retired');
    expect(s.retirement).toMatchObject({
      events: 3,
      closures: { FINAL: 1, INCOMPLETE: 1, DATA_UNAVAILABLE: 1 },
      reasons: { STATUS: 2, HIGH_MISSING: 2 },
    });
    const closures = await db
      .getRepository(ForwardLegacyClosure)
      .find({ order: { closure: 'ASC' } });
    expect(closures.map((c) => c.closure).sort()).toEqual([
      'DATA_UNAVAILABLE',
      'FINAL',
      'INCOMPLETE',
    ]);
    // The legacy events and outcomes themselves are untouched.
    expect(await db.getRepository(ForwardEvent).count()).toBe(3);
    expect(await db.getRepository(ForwardOutcome).count()).toBe(3);

    const after = await app
      .get(ForwardTestService)
      .afterPublication(P, (await batch('2030-01-06T01:07:00Z')).id, {
        now: t('2030-01-06T01:10:00Z'),
        pipelineRunId: null,
      });
    expect(after.update).toEqual({ skipped: 'the legacy forward test is retired' });
    expect(after.capture).toMatchObject({ skipped: expect.stringMatching(/after the cutover/) });
    expect(await app.get(PipelineService).startForwardUpdate()).toMatchObject({
      started: false,
      reason: expect.stringMatching(/retired/),
    });
  });
});

describe('fixture mode end to end', () => {
  it('after the cutover the hourly run opens LBank observation events only, and the job measures them', async () => {
    const { FixtureCmcMarket } = await import('../src/modules/sources/fixture/fixture-cmc.js');
    const { FixtureLbankSource } =
      await import('../src/modules/lbank-observation/lbank-market.source.js');
    const clock = { at: new Date() };
    const market = new FixtureCmcMarket(new Date().toISOString().slice(0, 10));
    const mod = await Test.createTestingModule({
      imports: [AppModule.forRoot(testConfig(), { http: false })],
    })
      .overrideProvider(LBANK_MARKET_SOURCE)
      .useValue(new FixtureLbankSource(async () => market, { now: () => clock.at }))
      .compile();
    mod.useLogger(false);
    await mod.init();
    try {
      const mdb = mod.get(DataSource);
      await resetDb(mdb);
      await mod.get(IngestionService).ensureProvider();
      const now = new Date();
      const cutover = new Date(Math.floor(now.getTime() / 86_400_000) * 86_400_000 + 86_400_000);
      await mod
        .get(CutoverService)
        .set(P, cutover, { now: new Date(cutover.getTime() - 3 * H), setBy: 'test' });

      const pipeline = mod.get(PipelineService);
      clock.at = new Date(cutover.getTime() + 7 * MIN);
      pipeline.clock = { now: () => clock.at };
      const r = await pipeline.runSlot(clock.at);
      expect(r.stages.observe).toBe('succeeded');
      const events = await mdb.getRepository(ObsEvent).find();
      expect(events.length).toBeGreaterThan(0);
      expect(await mdb.getRepository(ForwardEvent).count()).toBe(0);
      expect(await mdb.getRepository(Observation).count()).toBe(events.length);

      clock.at = new Date(cutover.getTime() + 25 * MIN);
      const run = await mod.get(ObservationUpdateService).run(P, { now: clock.at, trigger: 'cli' });
      expect(run.status).toBe('succeeded');
      const observed = await mdb.getRepository(Observation).find();
      const measured = observed.filter((o) => o.entryAt !== null);
      expect(measured.length).toBeGreaterThan(0);
      for (const o of measured) {
        expect(o.status).toBe('ACTIVE');
        expect(o.entryAt!.getTime()).toBeGreaterThanOrEqual(o.t0.getTime());
        expect(o.entryDelayMs!).toBeLessThanOrEqual(60_000);
        expect(o.isLive).toBe(false);
      }
      const check = await mod.get(ObservationReadService).routingCheck();
      expect(check).toMatchObject({
        ok: true,
        batchesAfterCutover: 1,
        legacyEventsAfterCutover: 0,
      });
    } finally {
      await mod.close();
    }
  });
});
