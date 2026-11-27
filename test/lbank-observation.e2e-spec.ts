import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { D, forStorage } from '../src/common/utils/decimal.js';
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
import { CandleArchive } from '../src/modules/lbank-observation/entities/candle-archive.entity.js';
import { FuturesBook } from '../src/modules/lbank-observation/entities/futures-book.entity.js';
import { FuturesObservation } from '../src/modules/lbank-observation/entities/futures-observation.entity.js';
import { FuturesPoll } from '../src/modules/lbank-observation/entities/futures-poll.entity.js';
import { ObsEvent } from '../src/modules/lbank-observation/entities/obs-event.entity.js';
import { ObsIntakeRun } from '../src/modules/lbank-observation/entities/obs-intake-run.entity.js';
import { ObservationResult } from '../src/modules/lbank-observation/entities/observation-result.entity.js';
import { Observation } from '../src/modules/lbank-observation/entities/observation.entity.js';
import { ObsRulesChange } from '../src/modules/lbank-observation/entities/rules-change.entity.js';
import { SpotCandle } from '../src/modules/lbank-observation/entities/spot-candle.entity.js';
import { SpotPair } from '../src/modules/lbank-observation/entities/spot-pair.entity.js';
import { SpotTrade } from '../src/modules/lbank-observation/entities/spot-trade.entity.js';
import { FuturesQuoteService } from '../src/modules/lbank-observation/futures-quote.service.js';
import { emptyFold } from '../src/modules/lbank-observation/futures-rules.js';
import { FuturesSamplerService } from '../src/modules/lbank-observation/futures-sampler.service.js';
import {
  type FuturesContract,
  type FuturesMarketRow,
  parseKlineResponse,
  parseTradesResponse,
} from '../src/modules/lbank-observation/kline.js';
import {
  type FuturesBookFetch,
  type FuturesMarketFetch,
  type KlineFetch,
  LBANK_MARKET_SOURCE,
  type LbankMarketSource,
  type ListFetch,
  type TradesFetch,
} from '../src/modules/lbank-observation/lbank-market.source.js';
import { ObservationIntakeService } from '../src/modules/lbank-observation/observation-intake.service.js';
import { ObservationReadService } from '../src/modules/lbank-observation/observation-read.service.js';
import { pctChange } from '../src/modules/lbank-observation/observation-rules.js';
import { ObservationUpdateService } from '../src/modules/lbank-observation/observation-update.service.js';
import {
  OBSERVATION_RULES_V1,
  OBSERVATION_RULES_VERSION,
} from '../src/modules/lbank-observation/observation.constants.js';
import { ObservationService } from '../src/modules/lbank-observation/observation.service.js';
import { TradeStoreService } from '../src/modules/lbank-observation/trade-store.service.js';
import { PipelineRun } from '../src/modules/pipeline/entities/pipeline-run.entity.js';
import { PipelineStage } from '../src/modules/pipeline/entities/pipeline-stage.entity.js';
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
 * LBank Spot Price Observation (rules v2) against PostgreSQL (docs/lbank-spot-observation.md):
 * cutover routing enforced by the database, intake exactly once, the proven observation start,
 * candles and trade checks shared per pair, the reference trade, trade-verified extremes over
 * exactly [start, start + 168 h), gaps, outages, finality, the v1 → v2 audit, retention with
 * archives, reads and export, and the legacy wind-down. LBank is a programmable fake that follows
 * the recorded API (kline OPEN = previous CLOSE; trades strictly after `time`, ≤ 600 per page);
 * every value is SYNTHETIC.
 */
const P = 'fixture';
const MIN = 60_000;
const H = 3_600_000;
const t = (s: string) => new Date(s);
const CUTOVER = t('2030-01-02T00:00:00.000Z');

interface FakeTrade {
  id: string;
  time: number;
  price: string;
  qty: string;
}

/** A fake LBank that follows the recorded API conventions. */
class FakeLbank implements LbankMarketSource {
  readonly id = 'fake';
  readonly isLive = false;
  nowMs = 0;
  unsupported = new Set<string>();
  /** symbol → minute ranges [from, to) the kline API serves no bar for. */
  gaps = new Map<string, Array<[number, number]>>();
  /** symbol → minute ranges [from, to) without trades (zero-volume bars). */
  quiet = new Map<string, Array<[number, number]>>();
  listedFrom = new Map<string, number>();
  /** symbol → minute → [high, low]: trades at both (others are one trade at 1). */
  shape = new Map<string, Map<number, [string, string]>>();
  /** symbol → minute → the minute's exact trades (offsets from the minute start). */
  minuteTrades = new Map<string, Map<number, FakeTrade[]>>();
  /** symbol → minute → the candle as LBank would send it (e.g. a High that is the carried OPEN). */
  barOverride = new Map<string, Map<number, [string, string, string, string, string]>>();
  klinesDown = new Set<string>();
  tradesDown = new Set<string>();
  spot: string[] = [];
  futures: FuturesContract[] = [];
  requests: Array<{ symbol: string; fromMs: number; size: number }> = [];
  tradeRequests: Array<{ symbol: string; afterMs: number; size: number }> = [];

  private inRanges(map: Map<string, Array<[number, number]>>, symbol: string, m: number) {
    return (map.get(symbol) ?? []).some(([f, to]) => m >= f && m < to);
  }

  /** The trades of minute m, ascending (LBank's order inside one millisecond kept). */
  tradesOf(symbol: string, m: number): FakeTrade[] {
    if (this.inRanges(this.quiet, symbol, m)) return [];
    const own = this.minuteTrades.get(symbol)?.get(m);
    if (own) return own;
    const s = this.shape.get(symbol)?.get(m);
    if (s)
      return [
        { id: `${symbol}-${m}-h`, time: m + 10_000, price: s[0], qty: '2' },
        { id: `${symbol}-${m}-l`, time: m + 20_000, price: s[1], qty: '2' },
        { id: `${symbol}-${m}-c`, time: m + 40_000, price: '1', qty: '1' },
      ];
    return [{ id: `${symbol}-${m}`, time: m + 30_000, price: '1', qty: '5' }];
  }

  private barOf(symbol: string, m: number): [string, string, string, string, string] {
    const o = this.barOverride.get(symbol)?.get(m);
    if (o) return o;
    const tr = this.tradesOf(symbol, m);
    if (!tr.length) return ['1', '1', '1', '1', '0'];
    const ps = tr.map((x) => new D(x.price));
    const hi = ps.reduce((a, b) => (b.gt(a) ? b : a));
    const lo = ps.reduce((a, b) => (b.lt(a) ? b : a));
    const vol = tr.reduce((s, x) => s.plus(x.qty), new D(0));
    return ['1', hi.toFixed(), lo.toFixed(), tr.at(-1)!.price, vol.toFixed()];
  }

  async klines(symbol: string, fromMs: number, size: number): Promise<KlineFetch> {
    this.requests.push({ symbol, fromMs, size });
    if (this.klinesDown.has(symbol)) throw new Error('connect ECONNREFUSED (simulated outage)');
    const ts = this.nowMs;
    let body: string;
    if (this.unsupported.has(symbol)) {
      body = `{"result":"false","msg":"currency pair nonsupport","error_code":10008,"ts":${ts}}`;
    } else {
      const rows: string[] = [];
      const first = Math.max(Math.floor(fromMs / MIN) * MIN, this.listedFrom.get(symbol) ?? 0);
      for (let m = first; m <= Math.floor(ts / MIN) * MIN && rows.length < size; m += MIN) {
        if (this.inRanges(this.gaps, symbol, m)) continue;
        const [o, h, l, c, v] = this.barOf(symbol, m);
        rows.push(`[${m / 1000},${o},${h},${l},${c},${v}]`);
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

  async trades(symbol: string, afterMs: number, size: number): Promise<TradesFetch> {
    this.tradeRequests.push({ symbol, afterMs, size });
    if (this.tradesDown.has(symbol)) throw new Error('connect ECONNREFUSED (simulated outage)');
    const ts = this.nowMs;
    let body: string;
    if (this.unsupported.has(symbol))
      body = `{"result":"false","msg":"currency pair nonsupport","error_code":10008,"ts":${ts}}`;
    else if (afterMs > ts)
      body = `{"result":"false","msg":"Illegal parameter","error_code":10003,"ts":${ts}}`;
    else {
      const cap = Math.min(size, 600);
      const rows: string[] = [];
      for (let m = Math.floor(afterMs / MIN) * MIN; m <= ts && rows.length < cap; m += MIN)
        for (const x of this.tradesOf(symbol, m))
          if (x.time > afterMs && x.time <= ts && rows.length < cap)
            rows.push(
              `{"quoteQty":0,"price":${x.price},"qty":${x.qty},"id":"${x.id}","time":${x.time},"isBuyerMaker":false}`,
            );
      body = `{"msg":"Success","result":"true","data":[${rows.join(',')}],"error_code":0,"ts":${ts}}`;
    }
    return {
      url: `fake://trades/${symbol}`,
      requestedAt: new Date(ts),
      durationMs: 0,
      response: parseTradesResponse(body),
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

  /** contract → the snapshot path: the latest entry at or before the send time is served. */
  futuresPath = new Map<string, Array<{ atMs: number; price: string; turnover: string }>>();
  futuresDown = false;
  /** Queue / rate-limit wait before the request is sent, and send → response latency (ms). */
  futuresSendDelayMs = 0;
  futuresLatencyMs = 0;
  /** The next request: this many attempts fail (timeouts) before one is answered. */
  futuresFailAttempts = 0;
  /** Contracts left out of the response (missing or invalid price). */
  futuresOmit = new Set<string>();
  bookDown = false;
  bookRequests: string[] = [];

  async futuresMarketData(): Promise<FuturesMarketFetch> {
    const url = 'fake://lbkperp/marketData';
    const first = this.nowMs + this.futuresSendDelayMs;
    const failedAttempts = Array.from({ length: this.futuresFailAttempts }, (_, i) => ({
      sentAt: new Date(first + i * 2_000),
      failedAt: new Date(first + i * 2_000 + 1_000),
      message: 'The operation was aborted due to timeout',
    }));
    const sentMs = first + this.futuresFailAttempts * 2_000;
    this.futuresFailAttempts = 0;
    const requestStartedAt = new Date(sentMs);
    const fetchedAt = new Date(sentMs + this.futuresLatencyMs);
    if (this.futuresDown)
      return {
        url,
        requestStartedAt,
        fetchedAt,
        failedAttempts: [
          ...failedAttempts,
          { sentAt: requestStartedAt, failedAt: fetchedAt, message: 'HTTP 503' },
        ],
        ok: false,
        error: 'HTTP 503 after 3 attempts',
      };
    const rows: FuturesMarketRow[] = [];
    for (const [symbol, path] of this.futuresPath) {
      if (this.futuresOmit.has(symbol)) continue;
      const p = [...path].reverse().find((x) => x.atMs <= sentMs);
      if (!p) continue;
      rows.push({
        symbol,
        serverMs: Math.floor(sentMs / 1000) * 1000,
        lastPrice: p.price,
        turnover24h: p.turnover,
        volume24h: p.turnover,
        high24h: null,
        low24h: null,
        markPrice: null,
        instrumentStatus: '2',
      });
    }
    return {
      url,
      requestStartedAt,
      fetchedAt,
      failedAttempts,
      ok: true,
      rows,
      invalid: 0,
      sha256: `md${sentMs}`,
      body: JSON.stringify({
        data: rows.map((r) => ({
          symbol: r.symbol,
          lastTime: r.serverMs / 1000,
          lastPrice: r.lastPrice,
          turnover: r.turnover24h,
          volume: r.volume24h,
        })),
        error_code: 0,
        msg: 'Success',
      }),
    };
  }

  async futuresOrderBook(symbol: string, depth: number): Promise<FuturesBookFetch> {
    this.bookRequests.push(symbol);
    const at = new Date(this.nowMs);
    const base = {
      url: `fake://lbkperp/marketOrder?symbol=${symbol}&depth=${depth}`,
      requestStartedAt: at,
      fetchedAt: at,
      failedAttempts: [],
    };
    if (this.bookDown) return { ...base, ok: false, error: 'HTTP 503' };
    return {
      ...base,
      ok: true,
      bids: [{ price: '0.99', volume: '10', orders: '1' }],
      asks: [{ price: '1.01', volume: '12', orders: '2' }],
      sha256: 'book',
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
    quiet: new Map(),
    listedFrom: new Map(),
    shape: new Map(),
    minuteTrades: new Map(),
    barOverride: new Map(),
    klinesDown: new Set(),
    tradesDown: new Set(),
    spot: ['abc_usdt', 'def_usdt', 'thin_usdt', 'mno_usdt'],
    futures: [{ symbol: 'ABCUSDT', base: 'ABC', quote: 'USDT', volume24h: '1000' }],
    requests: [],
    tradeRequests: [],
    futuresPath: new Map(),
    futuresDown: false,
    futuresSendDelayMs: 0,
    futuresLatencyMs: 0,
    futuresFailAttempts: 0,
    futuresOmit: new Set(),
    bookDown: false,
    bookRequests: [],
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

/**
 * Publish one queue row as the pipeline would: with `scanCommitAt`, a pipeline run whose scan stage
 * finished then (SCAN_COMMIT); without, the intake's post-commit clock (crawl + 6 min, EVENT_COMMIT).
 */
async function intake(r: TriggerRow, opts: { scanCommitAt?: string } = {}) {
  const at = r.observedAt!.getTime();
  const b = await batch(r.observedAt!.toISOString());
  let pipelineRunId: string | null = null;
  if (opts.scanCommitAt) {
    const run = await db.getRepository(PipelineRun).save(
      db.getRepository(PipelineRun).create({
        kind: `test-${at}-${r.cmcId}-${r.stars}`,
        slotTime: b.slotTime,
        providerId: P,
        status: 'running',
        startedAt: new Date(at),
        isLiveData: false,
      }),
    );
    await db.getRepository(PipelineStage).insert({
      runId: run.id,
      stage: 'scan',
      status: 'succeeded',
      startedAt: new Date(at + 1_000),
      finishedAt: t(opts.scanCommitAt),
    });
    pipelineRunId = run.id;
  }
  return app.get(ObservationIntakeService).intake(b, 'PUBLISHED', [r], CUTOVER, {
    now: new Date(
      Math.max(at + 5 * MIN, opts.scanCommitAt ? t(opts.scanCommitAt).getTime() + 1 : 0),
    ),
    pipelineRunId,
    clock: () => new Date(at + 6 * MIN),
  });
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

/** A minute's exact trades (and so its candle), as LBank would serve them. */
function minute(
  symbol: string,
  m: number,
  trades: Array<[offsetMs: number, price: string, qty?: string]>,
) {
  const map = lbank.minuteTrades.get(symbol) ?? new Map<number, FakeTrade[]>();
  map.set(
    m,
    trades.map(([off, price, qty], i) => ({
      id: `${symbol}-${m}-${i}`,
      time: m + off,
      price,
      qty: qty ?? '1',
    })),
  );
  lbank.minuteTrades.set(symbol, map);
}

async function futuresList(at: string) {
  await db.getRepository(VenueCrawl).save(
    db.getRepository(VenueCrawl).create({
      providerId: P,
      kind: 'lbank_futures_pairs',
      cmcId: null,
      batchId: null,
      startedAt: t(at),
      finishedAt: new Date(t(at).getTime() + 5_000),
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
}

/** RFC 4180 cells of one CSV line (quoted cells may hold commas). */
function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted && ch === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

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

  it('opens one event per (coin, UTC date, stars), for a higher or a lower count, exactly once', async () => {
    await setCutover();
    const A = await intake(row(1, 'abc', 2, '2030-01-02T10:00:00Z'));
    const dupe = await intake(row(1, 'abc', 2, '2030-01-02T11:00:00Z'));
    const up = await intake(row(1, 'abc', 3, '2030-01-02T15:00:00Z'));
    const down = await intake(row(1, 'abc', 1, '2030-01-02T16:00:00Z'));
    const again = await intake(row(1, 'abc', 2, '2030-01-02T18:00:00Z'));
    const nextDay = await intake(row(1, 'abc', 2, '2030-01-03T09:00:00Z'));
    expect([A, dupe, up, down, again, nextDay].map((x) => x.created.length)).toEqual([
      1, 0, 1, 1, 0, 1,
    ]);
    expect(dupe.ignored[0]!.eventId).toBe(A.created[0]!.eventId);
    expect(await db.getRepository(ObsEvent).count()).toBe(4);
    expect(await db.getRepository(Observation).count()).toBe(4);
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
    expect(await db.getRepository(Observation).count()).toBe(5);
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

  it('the window starts at the proven publication; key, UTC date and routing stay on the crawl time', async () => {
    await setCutover();
    // Crawled before the cutover, published after midnight: the legacy forward test's (by crawl time).
    const crawledBefore = row(7, 'abc', 2, '2030-01-01T23:07:00.050Z');
    const svc = app.get(ObservationIntakeService);
    const skipped = await svc.intakeBatch((await batch('2030-01-01T23:07:00.050Z')).id, {
      now: t('2030-01-02T00:03:00Z'),
    });
    expect(skipped).toMatchObject({ skipped: expect.stringMatching(/legacy forward test/) });
    const legacy = await app
      .get(ForwardCaptureService)
      .capture(await batch('2030-01-01T23:07:00.050Z'), 'PUBLISHED', [crawledBefore], {
        now: t('2030-01-02T00:03:00Z'),
      });
    expect(legacy.created).toHaveLength(1);

    // Crawled at 23:07, published 55 min later on the next UTC day: the key keeps the crawl date.
    const late = await intake(row(1, 'abc', 2, '2030-01-02T23:07:00.051Z'), {
      scanCommitAt: '2030-01-03T00:02:10.000Z',
    });
    const e = await db.getRepository(ObsEvent).findOneByOrFail({ id: late.created[0]!.eventId });
    expect(e.detectedUtcDate).toBe('2030-01-02');
    let o = await obsOf(1, 2);
    expect(o.t0.toISOString()).toBe('2030-01-02T23:07:00.051Z');
    expect(o.actionableSource).toBe('SCAN_COMMIT');
    expect(o.observationStart!.toISOString()).toBe('2030-01-03T00:02:10.000Z');
    expect(o.observationEnd!.toISOString()).toBe('2030-01-10T00:02:10.000Z');
    expect(o.rulesVersion).toBe(OBSERVATION_RULES_VERSION);
    expect(o.actionableEvidence).toMatchObject({
      crawlAt: '2030-01-02T23:07:00.051Z',
      cmcQuoteAt: '2030-01-02T23:05:00.051Z',
      afterCrawlMs: 55 * MIN + 9_949,
    });
    // The same stars crawled on the next UTC day are a new key (and a second, overlapping window).
    const next = await intake(row(1, 'abc', 2, '2030-01-03T00:07:00.040Z'), {
      scanCommitAt: '2030-01-03T00:07:03.100Z',
    });
    expect(next.created).toHaveLength(1);
    expect(await db.getRepository(ObsEvent).countBy({ cmcId: 1 })).toBe(2);

    // Without a scan record: the event's own commit, labelled uncertain.
    await intake(row(2, 'def', 1, '2030-01-03T05:07:00.000Z'));
    o = await obsOf(2);
    expect(o.actionableSource).toBe('EVENT_COMMIT');
    expect(o.observationStart!.toISOString()).toBe('2030-01-03T05:13:00.000Z');
    expect(o.actionableEvidence).toMatchObject({ uncertain: true });

    // An observation without a start (as before the change) gets one from the server's records.
    await db.query(
      `UPDATE lbank_observation SET observation_start = NULL, observation_end = NULL, actionable_at = NULL, actionable_source = NULL WHERE id = $1`,
      [o.id],
    );
    await runJob('2030-01-03T06:00:00Z');
    o = await obsOf(2);
    expect(o.actionableSource).toBe('JOB_FIRST_SEEN');
    expect(o.observationStart!.toISOString()).toBe('2030-01-03T06:00:00.000Z');
    expect((await app.get(ObservationReadService).routingCheck()).ok).toBe(true);
    // Never earlier than the crawl (database check).
    await expect(
      db.query(
        `UPDATE lbank_observation SET observation_start = t0 - interval '1 second', observation_end = t0 - interval '1 second' + interval '168 hours' WHERE id = $1`,
        [o.id],
      ),
    ).rejects.toThrow(/lbank_observation_start_after_crawl/);
  });
});

describe('LBank Spot measurement (rules v2)', () => {
  it('reference = first verified trade after the start; extremes = verified trades in exactly 168 h; frozen when final', async () => {
    await setCutover();
    await futuresList('2030-01-01T20:00:00Z');
    const S = t('2030-01-02T00:15:32.457Z').getTime();
    const sm = t('2030-01-02T00:15:00Z').getTime();
    const end = S + 168 * H;
    const em = Math.floor(end / MIN) * MIN;
    // Start minute: a trade before the start (never counted), then the reference.
    minute('abc_usdt', sm, [
      [10_000, '7'],
      [40_123, '1.01', '3'],
    ]);
    // A candle whose High is only its carried OPEN: its trades are at most 1.1.
    const A = sm + 100 * MIN;
    minute('abc_usdt', A, [
      [5_000, '1', '1'],
      [6_000, '1.1', '1'],
    ]);
    lbank.barOverride.set('abc_usdt', new Map([[A, ['1.3', '1.3', '1', '1.1', '2']]]));
    const B = sm + 2000 * MIN; // the real highest trade
    minute('abc_usdt', B, [[12_345, '1.25', '4']]);
    // Last minute: trades before the end count; at the end and after do not.
    minute('abc_usdt', em, [
      [32_000, '0.7'],
      [32_457, '0.1'],
      [50_000, '9'],
    ]);
    // Before the signal: never counted.
    lbank.shape.set('abc_usdt', new Map([[sm - 30 * MIN, ['70', '0.01']]]));
    await intake(row(1, 'abc', 3, '2030-01-02T00:07:00.078Z', { price: new D('1.003') }), {
      scanCommitAt: '2030-01-02T00:15:32.457Z',
    });

    await runJob('2030-01-02T00:20:00Z'); // evidence lists are read near the signal (≤ 2 h)
    await runJob('2030-01-02T03:20:00Z');
    let o = await obsOf(1);
    expect(o.status).toBe('ACTIVE');
    expect(o.reasons).toContain('WINDOW_OPEN');
    expect(o.referenceStatus).toBe('VERIFIED');
    expect(o.referencePrice!.toFixed()).toBe('1.01');
    expect(o.referenceAt!.toISOString()).toBe('2030-01-02T00:15:40.123Z');
    expect(o.referenceDelayMs).toBe(7_666);
    expect(o.referenceDelayed).toBe(false);
    expect(o.highestPrice!.toFixed()).toBe('1.1'); // provisional, trade-verified (not the 1.3 OPEN)
    expect(o.eligibility).toBe('SPOT_AND_FUTURES');
    expect(o.dataThrough!.toISOString()).toBe('2030-01-02T03:19:00.000Z');
    expect(o.lastSourceFetchAt!.toISOString()).toBe('2030-01-02T03:20:00.000Z');

    await runJob(new Date(end + 10 * MIN).toISOString());
    o = await obsOf(1);
    expect(o.status).toBe('FINAL');
    expect(o.reasons).toEqual([]);
    expect(o.minutesExpected).toBe(10_081);
    expect(o.minutesPresent).toBe(10_081);
    expect(o.gaps).toEqual([]);
    expect(o.highestPrice!.toFixed()).toBe('1.25');
    expect(o.highestAt!.getTime()).toBe(B + 12_345);
    expect(o.lowestPrice!.toFixed()).toBe('0.7');
    expect(o.lowestAt!.getTime()).toBe(em + 32_000);
    expect(o.highestReturnPct!.toFixed()).toBe(forStorage(pctChange(new D('1.25'), new D('1.01'))));
    expect(o.lowestReturnPct!.toFixed()).toBe(forStorage(pctChange(new D('0.7'), new D('1.01'))));
    expect(o.extremesOrder).toBe('HIGH_FIRST');
    expect(o.lowBeforeHighestPrice!.toFixed()).toBe('1');
    expect(o.extremesProven).toBe(true);
    expect(o.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(o.finalizedAt).not.toBeNull();
    // Only the minutes the rules needed were read trade by trade, never the whole window.
    const checked = await db.query(`SELECT count(*)::int AS n FROM lbank_spot_trade_minute`);
    expect(checked[0].n).toBeLessThanOrEqual(8);
    expect(lbank.tradeRequests.length).toBeLessThanOrEqual(12);
    const results = await db.getRepository(ObservationResult).findBy({ observationId: o.id });
    expect(results.map((r) => [r.resultVersion, r.status, r.rulesVersion])).toEqual([
      [1, 'FINAL', OBSERVATION_RULES_VERSION],
    ]);
    expect(results[0]!.referencePrice!.toFixed()).toBe('1.01');
    // Candles: one look-back hour (23:15 …) and every minute touching the window, nothing after.
    expect(await db.getRepository(SpotCandle).count()).toBe(60 + 10_081);

    // Frozen: neither the observation nor its result can change; trades are immutable.
    await expect(
      db.query(`UPDATE lbank_observation SET highest_return_pct = 99 WHERE id = $1`, [o.id]),
    ).rejects.toThrow(/frozen/);
    await expect(db.query(`DELETE FROM lbank_observation_result`)).rejects.toThrow(/append-only/);
    await expect(db.query(`UPDATE lbank_spot_trade SET price = 2`)).rejects.toThrow(/immutable/);
    await expect(db.query(`UPDATE lbank_spot_trade_minute SET error = 'x'`)).rejects.toThrow(
      /verified minute is immutable/,
    );
    expect((await runJob(new Date(end + 70 * MIN).toISOString())).finalized).toBe(0);
  });

  it('trades.do boundary: a trade exactly at the start is the reference; one exactly at the end is not counted', async () => {
    await setCutover();
    await futuresList('2030-01-01T20:00:00Z');
    const S = t('2030-01-02T00:15:32.457Z').getTime();
    const sm = t('2030-01-02T00:15:00Z').getTime();
    const end = S + 168 * H;
    const em = Math.floor(end / MIN) * MIN;
    minute('abc_usdt', sm, [
      [32_456, '7'], // 1 ms before the start: never counted
      [32_457, '1'], // exactly at the start: the reference
      [40_000, '1.02'],
    ]);
    minute('abc_usdt', em, [
      [32_456, '0.9'], // 1 ms before the end: counted
      [32_457, '0.1'], // exactly at the end: not counted
      [50_000, '9'], // after the end: not counted
    ]);
    await intake(row(1, 'abc', 3, '2030-01-02T00:07:00.078Z', { price: new D('1.003') }), {
      scanCommitAt: '2030-01-02T00:15:32.457Z',
    });
    await runJob('2030-01-02T00:20:00Z');
    let o = await obsOf(1);
    expect(o.observationStart!.getTime()).toBe(S);
    expect(o.referenceTradeId).toBe(`abc_usdt-${sm}-1`);
    expect(o.referenceAt!.getTime()).toBe(S);
    expect(o.referenceDelayMs).toBe(0);
    // Each minute is read from time = minute − 1 ms: LBank returns trades strictly after `time`.
    const after = () =>
      lbank.tradeRequests.filter((r) => r.symbol === 'abc_usdt').map((r) => r.afterMs);
    expect(after()).toContain(sm - 1);

    await runJob(new Date(end + 10 * MIN).toISOString());
    o = await obsOf(1);
    expect(o.status).toBe('FINAL');
    expect(after()).toContain(em - 1);
    expect(o.lowestTradeId).toBe(`abc_usdt-${em}-0`);
    expect(o.lowestPrice!.toFixed()).toBe('0.9');
    expect(o.lowestAt!.getTime()).toBe(end - 1);
    expect(o.highestPrice!.toFixed()).toBe('1.02'); // not the pre-start 7 nor the post-end 9
  });

  it('overlapping events share candles and trade checks; each has its own window; archives keep the path', async () => {
    await setCutover();
    await intake(row(1, 'abc', 1, '2030-01-02T00:07:00Z'), {
      scanCommitAt: '2030-01-02T00:07:05.000Z',
    });
    await intake(row(1, 'abc', 2, '2030-01-02T06:07:00Z'), {
      scanCommitAt: '2030-01-02T06:07:04.000Z',
    });
    await runJob('2030-01-02T12:00:00Z');
    const stored = await db.getRepository(SpotCandle).count();
    expect(stored).toBe(
      (t('2030-01-02T11:59:00Z').getTime() - t('2030-01-01T23:07:00Z').getTime()) / MIN,
    );
    const [a, b] = [await obsOf(1, 1), await obsOf(1, 2)];
    expect([a.status, b.status]).toEqual(['ACTIVE', 'ACTIVE']);
    expect(a.referenceAt!.toISOString()).toBe('2030-01-02T00:07:30.000Z');
    expect(b.referenceAt!.toISOString()).toBe('2030-01-02T06:07:30.000Z');
    expect([a.referenceDelayMs, b.referenceDelayMs]).toEqual([25_000, 26_000]);

    const read = app.get(ObservationReadService);
    const ov = (await read.overlaps(a.id))!;
    expect(ov.coin).toEqual({ cmcId: 1, events: 2 });
    expect(ov.overlaps.map((x) => [x.id, x.relation, x.overlapHours])).toEqual([
      [b.id, 'same_utc_day', '162.0'],
    ]);
    expect(ov.overlaps[0]!.overlapStart).toBe('2030-01-02T06:07:04.000Z');
    expect((await read.overlaps(b.id))!.overlaps.map((x) => x.id)).toEqual([a.id]);
    expect(await read.overlaps('00000000-0000-4000-8000-000000000000')).toBeNull();

    // Retention: never a candle an unfinished observation needs; afterwards whole UTC days are
    // archived (gzip CSV + SHA-256) before the raw rows go, and read back from the archive.
    const candles = app.get(CandleStoreService);
    const pair = await db.getRepository(SpotPair).findOneByOrFail({ symbol: 'abc_usdt' });
    const before = await candles.loadBars(
      pair.id,
      t('2030-01-01T00:00:00Z').getTime(),
      t('2030-01-03T00:00:00Z').getTime(),
    );
    expect(await candles.prune(t('2030-01-20T00:00:00Z'), 7)).toEqual({
      deleted: 0,
      archivedDays: 0,
    });
    await db.query(`UPDATE lbank_observation SET finalized_at = '2030-01-09T12:00:00Z'`);
    expect(await candles.prune(t('2030-01-20T00:00:00Z'), 7)).toEqual({
      deleted: stored,
      archivedDays: 2,
    });
    expect(await db.getRepository(SpotCandle).count()).toBe(0);
    const after = await candles.loadBars(
      pair.id,
      t('2030-01-01T00:00:00Z').getTime(),
      t('2030-01-03T00:00:00Z').getTime(),
    );
    expect(after.map((x) => [x.openMs, x.close.toFixed(), x.volume.toFixed()])).toEqual(
      before.map((x) => [x.openMs, x.close.toFixed(), x.volume.toFixed()]),
    );
    expect(await db.getRepository(CandleArchive).count()).toBe(2);
    await expect(db.query(`DELETE FROM lbank_spot_candle_archive`)).rejects.toThrow(/immutable/);
    expect(await candles.prune(t('2030-01-20T00:00:00Z'), 0)).toEqual({
      deleted: 0,
      archivedDays: 0,
    });
  });

  it('gaps, outages, delisting, ambiguity and a quiet window each end with their own explicit status', async () => {
    await setCutover();
    const t0 = '2030-01-02T00:07:00Z';
    const commit = '2030-01-02T00:07:06.000Z';
    // abc: a 30-minute hole inside the window that never comes back.
    lbank.gaps.set('abc_usdt', [
      [t('2030-01-03T00:00:00Z').getTime(), t('2030-01-03T00:30:00Z').getTime()],
    ]);
    lbank.unsupported.add('def_usdt');
    // thin: listed and answering, but not one trade in the window.
    lbank.quiet.set('thin_usdt', [[0, t('2030-02-01T00:00:00Z').getTime()]]);
    // mno: LBank is down at first (candles and trades): an outage, never a quiet market.
    lbank.klinesDown.add('mno_usdt');
    lbank.tradesDown.add('mno_usdt');
    await intake(row(1, 'abc', 1, t0), { scanCommitAt: commit });
    await intake(row(2, 'def', 1, t0), { scanCommitAt: commit });
    await intake(row(3, 'thin', 1, t0), { scanCommitAt: commit });
    await intake(row(6, 'mno', 1, t0), { scanCommitAt: commit });
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
      { scanCommitAt: commit },
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
      { scanCommitAt: commit },
    );

    let run = await runJob('2030-01-02T00:30:00Z');
    expect(run.status).toBe('partial'); // the trades outage is a failure, never "no trades"
    expect((await obsOf(2)).status).toBe('DATA_UNAVAILABLE');
    expect((await obsOf(2)).reasons).toContain('PAIR_UNSUPPORTED_BY_API');
    expect((await obsOf(4)).status).toBe('MAPPING_AMBIGUOUS');
    expect((await obsOf(5)).reasons).toEqual(['NO_USDT_PAIR']);
    let m = await obsOf(6);
    expect(m.status).toBe('ACTIVE');
    expect(m.referenceStatus).toBe('PENDING');
    expect(m.reasons).toEqual(expect.arrayContaining(['REFERENCE_PENDING', 'FETCH_ERROR']));
    expect(m.lastFetchError).toMatch(/ECONNREFUSED/);
    expect(m.minutesPresent).toBe(0);
    expect(m.gaps[0]).toMatchObject({ state: 'FETCH_FAILED' }); // not "no trades", not "no bar"
    expect(m.lastSourceFetchAt).toBeNull();

    // Candles are back, trades still down: the reference minute cannot be verified yet.
    lbank.klinesDown.clear();
    run = await runJob('2030-01-02T01:00:00Z');
    expect(run.status).toBe('partial'); // the trades are still failing
    m = await obsOf(6);
    expect(m.minutesPresent).toBeGreaterThan(0);
    expect(m.referenceStatus).toBe('PENDING');
    expect(m.gaps).toContainEqual(
      expect.objectContaining({ state: 'FETCH_FAILED', detail: 'reference search: FETCH_FAILED' }),
    );
    const q = await obsOf(3);
    expect([q.status, q.referenceStatus]).toEqual(['ACTIVE', 'PENDING']); // quiet so far, window open

    // The outage ends: the same minutes are read again and the reference is recovered.
    lbank.tradesDown.clear();
    run = await runJob('2030-01-02T01:30:00Z');
    expect(run.status).toBe('succeeded');
    expect(run.fetchedNewData).toBe(true);
    m = await obsOf(6);
    expect(m.referenceStatus).toBe('VERIFIED');
    expect(m.referenceAt!.toISOString()).toBe('2030-01-02T00:07:30.000Z');

    await runJob('2030-01-09T00:30:00Z');
    let o = await obsOf(1);
    expect(o.status).toBe('ACTIVE'); // gaps are retried for a day after the window
    expect(o.minutesMissing).toBe(30);
    expect(o.gaps).toContainEqual({
      from: '2030-01-03T00:00:00.000Z',
      to: '2030-01-03T00:30:00.000Z',
      state: 'NO_BAR',
    });
    expect((await obsOf(6)).status).toBe('FINAL');
    expect((await obsOf(3)).status).toBe('NO_TRADES');
    expect((await obsOf(3)).highestReturnPct).toBeNull();
    await runJob('2030-01-10T00:30:00Z');
    o = await obsOf(1);
    expect(o.status).toBe('PARTIAL');
    expect(o.reasons).toContain('MISSING_BARS');
    expect(o.highestReturnPct).not.toBeNull(); // values over the covered part stay visible
    const summary = await app.get(ObservationReadService).summary();
    expect(summary.summary.final.events).toBe(1); // mno only
    expect(summary.summary.partial.events).toBe(1);
    expect(summary.summary.noTrades.events).toBe(1);
    expect(summary.summary.unmeasured.events).toBe(3);
  });

  it('reads a minute’s trades completely: pages by time − 1, de-duplicates, refuses what cannot be proven', async () => {
    await setCutover();
    await intake(row(1, 'abc', 1, '2030-01-02T00:07:00Z'), {
      scanCommitAt: '2030-01-02T00:07:05Z',
    });
    lbank.nowMs = t('2030-01-02T02:00:00Z').getTime();
    const pair = await db.getRepository(SpotPair).findOneByOrFail({ symbol: 'abc_usdt' });
    const store = app.get(TradeStoreService);
    const m = t('2030-01-02T01:00:00Z').getTime();
    // 700 trades, 3 per millisecond around the page boundary: two pages, nothing lost or doubled.
    minute(
      'abc_usdt',
      m,
      Array.from(
        { length: 700 },
        (_, i) => [1_000 + Math.floor(i / 3), '1', '1'] as [number, string, string],
      ),
    );
    const bar = (v: string) => ({
      openMs: m,
      open: new D('1'),
      high: new D('1'),
      low: new D('1'),
      close: new D('1'),
      volume: new D(v),
    });
    let r = await store.checkMinute(pair, bar('700'), t('2030-01-02T02:00:00Z'));
    expect([r.check.status, r.check.tradeCount, r.requests]).toEqual(['VERIFIED', 700, 2]);
    expect(await db.getRepository(SpotTrade).count()).toBe(700);
    // More than a page in one millisecond cannot be paged past: unverified, no endless loop.
    const m2 = m + MIN;
    minute(
      'abc_usdt',
      m2,
      Array.from({ length: 650 }, () => [500, '1', '1'] as [number, string, string]),
    );
    r = await store.checkMinute(pair, { ...bar('650'), openMs: m2 }, t('2030-01-02T02:00:00Z'));
    expect(r.check.status).toBe('PAGING_INCOMPLETE');
    expect(r.check.error).toMatch(/one millisecond/);
    // Fewer trades than the candle counts: unverified; more: verified, the surplus recorded.
    const m3 = m + 2 * MIN;
    minute('abc_usdt', m3, [[1_000, '1', '3']]);
    r = await store.checkMinute(pair, { ...bar('5'), openMs: m3 }, t('2030-01-02T02:00:00Z'));
    expect(r.check.status).toBe('TRADES_BELOW_CANDLE');
    const m4 = m + 3 * MIN;
    minute('abc_usdt', m4, [[1_000, '1', '6']]);
    r = await store.checkMinute(pair, { ...bar('5'), openMs: m4 }, t('2030-01-02T02:00:00Z'));
    expect(r.check.status).toBe('VERIFIED');
    const [row4] = await db.query(
      `SELECT candle_surplus::text AS s FROM lbank_spot_trade_minute WHERE minute_at = $1`,
      [new Date(m4)],
    );
    expect(row4.s).toBe('1');
  });

  it('classifies Spot / Futures from evidence before and after the signal; unknown stays unknown', async () => {
    await setCutover();
    // No CMC futures list before the signal: Futures UNKNOWN even though LBank lists ABCUSDT now.
    await intake(row(1, 'abc', 1, '2030-01-02T00:07:00Z'), {
      scanCommitAt: '2030-01-02T00:07:05Z',
    });
    await runJob('2030-01-02T00:20:00Z');
    const o = await obsOf(1);
    expect(o.futuresStatus).toBe('UNKNOWN');
    expect(o.eligibility).toBe('SPOT_FUTURES_UNKNOWN');
    expect((o.eligibilityEvidence as { futures: { reasons: string[] } }).futures.reasons).toEqual([
      'FUTURES_LIST:LIST_NOT_FETCHED',
    ]);
  });

  it('lists, filters, sorts, summarizes and exports the displayed (v2) values; UI text names the same rules', async () => {
    await setCutover();
    const commit = '2030-01-02T00:07:05.000Z';
    // ABC: one isolated low print in a minute of its own (flagged, kept).
    minute('abc_usdt', t('2030-01-03T00:00:00Z').getTime(), [[26_747, '0.5', '7']]);
    await intake(row(1, 'abc', 3, '2030-01-02T00:07:00Z'), { scanCommitAt: commit });
    await intake(row(2, 'def', 1, '2030-01-02T00:07:00Z'), { scanCommitAt: commit });
    lbank.unsupported.add('def_usdt');
    // Every checked minute is counted once as verified or not, including the spike-context checks.
    for (const at of ['2030-01-02T00:20:00Z', '2030-01-09T00:20:00Z']) {
      const { trades } = await runJob(at);
      expect(trades.minutesChecked).toBeGreaterThan(0);
      expect(trades.verified + trades.failed).toBe(trades.minutesChecked);
    }
    const read = app.get(ObservationReadService);
    const all = await read.list({});
    expect(all.total).toBe(2);
    expect((await read.list({ status: 'FINAL' })).rows.map((r) => r.symbol)).toEqual(['ABC']);
    expect(
      (await read.list({ eligibility: 'SPOT_UNAVAILABLE' })).rows.map((r) => r.symbol),
    ).toEqual(['DEF']);
    expect((await read.list({ stars: 3 })).total).toBe(1);
    expect((await read.list({ coverage: 'complete' })).total).toBe(1);
    expect((await read.list({ flags: 'spike' })).rows.map((r) => r.symbol)).toEqual(['ABC']);
    expect((await read.list({ flags: 'none' })).rows.map((r) => r.symbol)).toEqual(['DEF']);
    expect((await read.list({ search: 'de' })).rows.map((r) => r.symbol)).toEqual(['DEF']);
    expect((await read.list({ sort: 'lowest', dir: 'asc' })).rows[0]!.symbol).toBe('ABC');
    const abc = (await read.list({ search: 'abc' })).rows[0]!;
    expect(abc.cmcPriceUsd).toBe('1.002');
    expect(abc.reference).toMatchObject({ status: 'VERIFIED', price: '1', delayMs: 25_000 });
    expect(abc.lowest).toMatchObject({ price: '0.5', pct: '-50' });
    expect(abc.highest).toMatchObject({ price: '1', pct: '0' });
    expect(abc.flags).toEqual(expect.arrayContaining(['SINGLE_TRADE_LOW']));
    expect(abc.window).toMatchObject({ start: '2030-01-02T00:07:05.000Z', source: 'SCAN_COMMIT' });
    expect(abc.provisional).toBe(false);
    expect(abc.rulesVersion).toBe(OBSERVATION_RULES_VERSION);
    const detail = (await read.detail(abc.id))!;
    expect(detail.flagsEvidence).toMatchObject({
      singleTradeLow: { minuteTrades: 1, previousTrade: { price: '1' }, nextTrade: { price: '1' } },
    });
    const s = await read.summary();
    expect(s.rulesVersion).toBe(OBSERVATION_RULES_VERSION);
    expect(s.summary.final).toMatchObject({ events: 1, coins: 1 });
    expect(s.summary.final.flagged.singleTrade).toEqual({ events: 1, coins: 1 });
    expect(s.summary.unmeasured).toEqual({ events: 1, coins: 1 });
    expect(s.priceSource).toMatch(/LBank Spot trades/);
    expect(s.lastRun).toMatchObject({ fetchedNewData: true });
    const csv = await read.csv({});
    const [head, ...lines] = csv.trim().split('\n');
    expect(head).toMatch(/^observation_id,event_id,cmc_id/);
    for (const col of [
      'observation_start_utc',
      'reference_trade_id',
      'highest_return_pct',
      'lowest_return_pct',
      'flags',
      'rules_version',
    ])
      expect(head!.split(',')).toContain(col);
    expect(lines).toHaveLength(2);
    expect(csv).toContain(OBSERVATION_RULES_VERSION);
    expect(csv).toContain('SYNTHETIC');
    // The help modal states the same rules version and the star rule (rises or falls).
    const guides = readFileSync('front/src/components/guides.tsx', 'utf8');
    expect(guides).toContain(OBSERVATION_RULES_VERSION);
    expect(guides).toMatch(/higher or lower/);
  });

  it('rules v1 rows move to v2 with an audit row; a finalized v1 result stays and reopens only through the log', async () => {
    await setCutover();
    await futuresList('2030-01-01T20:00:00Z');
    lbank.spot.push('def_usdt');
    // As on production: the queue was published by a pipeline run whose scan stage is recorded.
    await intake(row(1, 'abc', 1, '2030-01-02T00:07:00.078Z'), {
      scanCommitAt: '2030-01-02T00:15:32.457Z',
    });
    await intake(row(2, 'def', 1, '2030-01-02T00:07:00.078Z'), {
      scanCommitAt: '2030-01-02T00:15:32.457Z',
    });
    // Rows as rules v1 wrote them (crawl-time window, candle-OPEN entry); one already FINAL.
    for (const cmcId of [1, 2]) {
      const o = await obsOf(cmcId);
      const ev = await db.getRepository(ObsEvent).findOneByOrFail({ id: o.eventId });
      await db.query(`DELETE FROM lbank_observation WHERE id = $1`, [o.id]);
      const finalV1 = cmcId === 2;
      await db.query(
        `INSERT INTO lbank_observation (id, event_id, provider_id, is_live, t0, window_end, pair_id, pair_symbol, quote_asset,
           mapping_status, mapping_evidence, spot_status, futures_status, eligibility, eligibility_evidence,
           entry_at, entry_price, entry_delay_ms, entry_stale, high_price, high_bar_at, low_price, low_bar_at,
           max_rise_pct, max_drop_pct, extreme_order, expected_bars, covered_bars, traded_bars, missing_bars,
           missing_ranges, start_unobserved_ms, boundary_unobserved_ms, status, reasons, rules_version,
           result_version, finalized_at)
         VALUES ($1, $2, $3, false, $4, $4::timestamptz + interval '168 hours', $5, $6, 'USDT', 'OK', '{"reasons":[]}',
           'YES', 'NO', 'SPOT_ONLY', '{}', '2030-01-02T00:08:00Z', 1.05, 59922, false, 1.05, '2030-01-02T00:08:00Z',
           0.9, '2030-01-02T05:00:00Z', 0, -14.28, 'HIGH_FIRST', 10079, 10079, 10079, 0, '[]', 59922, 78,
           $7, '{}', $8, $9, $10)`,
        [
          o.id,
          ev.id,
          P,
          ev.detectedAt,
          o.pairId,
          o.pairSymbol,
          finalV1 ? 'FINAL' : 'ACTIVE',
          OBSERVATION_RULES_V1,
          finalV1 ? 1 : 0,
          finalV1 ? '2030-01-09T00:20:00Z' : null,
        ],
      );
      if (finalV1)
        await db.query(
          `INSERT INTO lbank_observation_result (observation_id, result_version, status, eligibility, reasons, rules_version,
             entry_price, max_rise_pct, max_drop_pct, expected_bars, covered_bars, traded_bars, missing_bars, missing_ranges, computed_at)
           VALUES ($1, 1, 'FINAL', 'SPOT_ONLY', '{}', $2, 1.05, 0, -14.28, 10079, 10079, 10079, 0, '[]', '2030-01-09T00:20:00Z')`,
          [o.id, OBSERVATION_RULES_V1],
        );
    }
    const v1Final = await obsOf(2);
    // The database refuses a silent rules change and any edit of a frozen v1 result.
    await expect(
      db.query(`UPDATE lbank_observation SET rules_version = $1 WHERE id = $2`, [
        OBSERVATION_RULES_VERSION,
        v1Final.id,
      ]),
    ).rejects.toThrow(/rules change needs its lbank_obs_rules_change row/);
    await expect(
      db.query(`UPDATE lbank_observation SET max_rise_pct = 5 WHERE id = $1`, [v1Final.id]),
    ).rejects.toThrow(/frozen/);

    const run = await runJob('2030-01-09T00:40:00Z');
    expect(run.rulesChanged).toBe(2);
    expect(run.timingAssigned).toBe(2); // backfilled from the pipeline's scan stage
    const changes = await db.getRepository(ObsRulesChange).find({ order: { fromStatus: 'ASC' } });
    expect(
      changes.map((c) => [c.fromRulesVersion, c.toRulesVersion, c.fromStatus, c.fromResultVersion]),
    ).toEqual([
      [OBSERVATION_RULES_V1, OBSERVATION_RULES_VERSION, 'ACTIVE', 0],
      [OBSERVATION_RULES_V1, OBSERVATION_RULES_VERSION, 'FINAL', 1],
    ]);
    expect(changes[1]!.previous).toMatchObject({ maxRisePct: '0', entry: { price: '1.05' } });
    for (const cmcId of [1, 2]) {
      const o = await obsOf(cmcId);
      expect(o.rulesVersion).toBe(OBSERVATION_RULES_VERSION);
      expect(o.entryPrice!.toFixed()).toBe('1.05'); // the v1 values stay as an audit record
      expect(o.maxRisePct!.toFixed()).toBe('0');
      expect(o.actionableSource).toBe('SCAN_COMMIT');
      expect(o.observationStart!.toISOString()).toBe('2030-01-02T00:15:32.457Z');
      expect(o.referenceStatus).toBe('VERIFIED');
      // The v2 window (from the scan commit) has ended: a v2 result, frozen.
      expect(o.status).toBe('FINAL');
    }
    // The v1 result row is kept; the corrected v2 result is the next version.
    const results = await db.getRepository(ObservationResult).find({
      where: { observationId: v1Final.id },
      order: { resultVersion: 'ASC' },
    });
    expect(results.map((r) => [r.resultVersion, r.rulesVersion, r.status])).toEqual([
      [1, OBSERVATION_RULES_V1, 'FINAL'],
      [2, OBSERVATION_RULES_VERSION, 'FINAL'],
    ]);
    expect(results[0]!.maxDropPct!.toFixed()).toBe('-14.28');
    expect(results[1]!.lowestReturnPct!.toFixed()).toBe('0');
    await expect(
      db.query(`UPDATE lbank_observation SET entry_price = 2 WHERE id = $1`, [v1Final.id]),
    ).rejects.toThrow(/frozen|audit record/);
    const d = (await app.get(ObservationReadService).detail(v1Final.id))!;
    expect(d.legacyV1).toMatchObject({ entryPrice: '1.05', maxRisePct: '0' });
    expect(d.rulesChanges).toHaveLength(1);
    expect(d.displayedRulesVersion).toBe(OBSERVATION_RULES_VERSION);
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
      // The real clock throughout: the pipeline records its stage times with it, and the observation
      // start is the recorded scan commit. The cutover is this UTC day's midnight.
      const now = new Date();
      const cutover = new Date(Math.floor(now.getTime() / 86_400_000) * 86_400_000);
      await mod
        .get(CutoverService)
        .set(P, cutover, { now: new Date(cutover.getTime() - 3 * H), setBy: 'test' });

      const pipeline = mod.get(PipelineService);
      clock.at = now;
      const r = await pipeline.runSlot(now);
      expect(r.stages.observe).toBe('succeeded');
      const events = await mdb.getRepository(ObsEvent).find();
      expect(events.length).toBeGreaterThan(0);
      expect(await mdb.getRepository(ForwardEvent).count()).toBe(0);
      expect(await mdb.getRepository(Observation).count()).toBe(events.length);

      clock.at = new Date(Date.now() + 25 * MIN);
      const run = await mod.get(ObservationUpdateService).run(P, { now: clock.at, trigger: 'cli' });
      expect(run.status).toBe('succeeded');
      const observed = await mdb.getRepository(Observation).find();
      const measured = observed.filter((o) => o.referenceStatus === 'VERIFIED');
      expect(measured.length).toBeGreaterThan(0);
      for (const o of measured) {
        expect(o.status).toBe('ACTIVE');
        expect(o.rulesVersion).toBe(OBSERVATION_RULES_VERSION);
        expect(o.actionableSource).toBe('SCAN_COMMIT');
        expect(o.observationStart!.getTime()).toBeGreaterThan(o.t0.getTime());
        expect(o.referenceAt!.getTime()).toBeGreaterThanOrEqual(o.observationStart!.getTime());
        expect(o.referenceDelayMs).toBe(o.referenceAt!.getTime() - o.observationStart!.getTime());
        expect(o.highestReturnPct!.gte(0)).toBe(true);
        expect(o.lowestReturnPct!.lte(0)).toBe(true);
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

describe('LBank Futures observed quote (lbank-futures-quote-1)', () => {
  const quotes = () => app.get(FuturesQuoteService);
  const sampler = () => app.get(FuturesSamplerService);
  const S = t('2030-01-02T00:15:32.457Z').getTime(); // the actionable start (scan commit)
  const at = (msAt: number) => {
    lbank.nowMs = msAt;
    const clock = { now: () => new Date(lbank.nowMs) };
    quotes().clock = clock;
    sampler().clock = clock;
  };
  const tick = async (msAt: number) => {
    at(msAt);
    return sampler().tick();
  };
  const publishAt = async (msAt: number, trigger: 'PUBLICATION' | 'RETRY' = 'PUBLICATION') => {
    at(msAt);
    const e = await db.getRepository(ObsEvent).findOneByOrFail({ cmcId: 1 });
    await quotes().capture(e.sourceBatchId, trigger, 99); // 99: no automatic retry in tests
  };
  const futOf = async (cmcId: number, stars?: number) =>
    db
      .getRepository(FuturesObservation)
      .findOneByOrFail({ observationId: (await obsOf(cmcId, stars)).id });
  const refOf = async (cmcId: number, kind = 'ENTRY', stars?: number) =>
    (
      await db.query(
        `SELECT r.*, r.last_price::text AS price FROM lbank_futures_reference r WHERE r.futures_observation_id = $1 AND r.kind = $2`,
        [(await futOf(cmcId, stars)).id, kind],
      )
    )[0] as
      | {
          id: string;
          price: string;
          source: string;
          poll_id: string;
          request_started_at: Date;
          response_received_at: Date;
          stored_at: Date;
          quote_refreshed_at: Date | null;
          failed_attempts_before: number;
        }
      | undefined;
  const setup = async () => {
    await setCutover();
    await futuresList('2030-01-01T20:00:00Z'); // CMC: ABCUSDT is CMC id 1 (URL-pinned)
    sampler().clearBuffer();
  };
  const intakeAbc = (
    stars = 3,
    crawl = '2030-01-02T00:07:00.078Z',
    scan = '2030-01-02T00:15:32.457Z',
  ) => intake(row(1, 'abc', stars, crawl, { price: new D('1.003') }), { scanCommitAt: scan });

  it('publication between ticks: the first valid lastPrice of a request sent after the start, timed to its response', async () => {
    await setup();
    // A pre-signal trade at 1.000; turnover then FALLS and the price stays unchanged.
    lbank.futuresPath.set('ABCUSDT', [
      { atMs: S - 30_000, price: '1.000', turnover: '100' },
      { atMs: S + 30_000, price: '1.000', turnover: '90' },
    ]);
    await intakeAbc();
    const spotBefore = await obsOf(1);
    lbank.futuresSendDelayMs = 120; // queue / rate-limit wait
    lbank.futuresLatencyMs = 530; // network
    await publishAt(S + 15); // fired 15 ms after the scan commit, between minute ticks
    const r = (await refOf(1))!;
    expect(new D(r.price).toFixed()).toBe('1'); // the API's own digits are kept ('1.000')
    expect(r).toMatchObject({ source: 'PUBLICATION', failed_attempts_before: 0 });
    expect(r.request_started_at.getTime()).toBe(S + 135);
    expect(r.response_received_at.getTime()).toBe(S + 665);
    expect(r.stored_at).toBeInstanceOf(Date);
    // LBank's lastTime is the snapshot's refresh second, never a trade time.
    expect(r.quote_refreshed_at!.getTime()).toBe(Math.floor((S + 135) / 1000) * 1000);
    const f = await futOf(1);
    expect(f).toMatchObject({
      rulesVersion: 'lbank-futures-quote-1',
      mappingStatus: 'OK',
      contract: 'ABCUSDT',
      status: 'ACTIVE',
    });
    expect(f.referencePrice!.toFixed()).toBe('1');

    // API and CSV: same values; delay = response receipt − start (not send, not storage, not a tick).
    const read = app.get(ObservationReadService);
    const row = (await read.list({ search: 'abc' })).rows[0]!;
    expect(row.futuresSampled).toMatchObject({
      method: 'OBSERVED_QUOTE',
      quote: {
        price: '1',
        delayMs: 665,
        publicationToRequestMs: 135,
        requestToResponseMs: 530,
        source: 'PUBLICATION',
      },
    });
    const csv = (await read.csv({ search: 'abc' })).trim().split('\n');
    const head = csvCells(csv[0]!);
    const cells = csvCells(csv[1]!);
    expect(cells).toHaveLength(head.length);
    const c = (k: string) => cells[head.indexOf(k)];
    expect(c('futures_method')).toBe('OBSERVED_QUOTE');
    expect(c('futures_first_observed_price')).toBe('1');
    expect(c('futures_first_observed_delay_ms')).toBe('665');
    expect(c('futures_publication_to_request_ms')).toBe('135');
    expect(c('futures_request_to_response_ms')).toBe('530');
    expect(c('futures_reference_trade_after_utc')).toBe(''); // old-method columns stay empty

    // Order-book context: separate, after the quote.
    await quotes().books([f.id]);
    const books = await db.getRepository(FuturesBook).findBy({ futuresObservationId: f.id });
    expect(books.map((x) => [x.ok, x.bestBid?.toFixed(), x.bestAsk?.toFixed()])).toEqual([
      [true, '0.99', '1.01'],
    ]);
    // Spot untouched.
    expect({ ...(await obsOf(1)), updatedAt: null }).toEqual({ ...spotBefore, updatedAt: null });
  });

  it('a request sent before the start never qualifies, even when answered after it; old snapshots never do', async () => {
    await setup();
    lbank.futuresPath.set('ABCUSDT', [
      { atMs: S - 3 * H, price: '0.5', turnover: '1' },
      { atMs: S - 1_000, price: '0.9', turnover: '2' },
      { atMs: S + 2_000, price: '1.1', turnover: '3' },
    ]);
    await tick(S - 3 * H); // an old snapshot of the contract (not needed yet: not stored)
    await intakeAbc();
    lbank.futuresLatencyMs = 900;
    await tick(S - 300); // sent 300 ms before the start, answered 600 ms after it
    expect(await refOf(1)).toBeUndefined();
    lbank.futuresLatencyMs = 400;
    await publishAt(S + 2_500);
    const r = (await refOf(1))!;
    expect(new D(r.price).toFixed()).toBe('1.1');
    expect(r.request_started_at.getTime()).toBe(S + 2_500);
  });

  it('earliest receipt wins across concurrent requests, retries and replays; a later one never replaces it', async () => {
    await setup();
    lbank.futuresPath.set('ABCUSDT', [{ atMs: S - 1, price: '1', turnover: '5' }]);
    await intakeAbc();
    // R1: sent first but slow (answer at +5 s). R2: sent later, answered first (+2.5 s).
    at(S + 100);
    lbank.futuresLatencyMs = 4_900;
    const r1 = await quotes().recordRequest(await lbank.futuresMarketData(), {
      trigger: 'PUBLICATION',
      queuedAt: new Date(S + 100),
      batchId: null,
      keepBody: true,
    });
    lbank.futuresPath.set('ABCUSDT', [{ atMs: S - 1, price: '1.2', turnover: '5' }]);
    at(S + 2_000);
    lbank.futuresLatencyMs = 500;
    const r2 = await quotes().recordRequest(await lbank.futuresMarketData(), {
      trigger: 'RETRY',
      queuedAt: new Date(S + 2_000),
      batchId: null,
      keepBody: true,
    });
    const [row] = await quotes().quoteRows();
    await quotes().ensureRows();
    const rows = await quotes().quoteRows();
    // Concurrent settles with both responses, in both orders.
    await Promise.all([
      quotes().settle(rows, r1!),
      quotes().settle(rows, r2!),
      quotes().settle(rows, r1!),
    ]);
    let ref = (await refOf(1))!;
    expect(ref.response_received_at.getTime()).toBe(S + 2_500);
    expect(new D(ref.price).toFixed()).toBe('1.2');
    // A replay of the slower response does not move it; neither can a direct update to a later receipt.
    await quotes().settle(rows, r1!);
    ref = (await refOf(1))!;
    expect(ref.poll_id).toBe(r2!.pollId);
    await expect(
      db.query(
        `UPDATE lbank_futures_reference SET response_received_at = response_received_at + interval '1 second' WHERE id = $1`,
        [ref.id],
      ),
    ).rejects.toThrow(/only an earlier response/);
    await expect(
      db.query(`DELETE FROM lbank_futures_reference WHERE id = $1`, [ref.id]),
    ).rejects.toThrow(/never deleted/);
    expect(row === undefined || row.id !== undefined).toBe(true);
  });

  it('API failure and timeouts are logged with their times; the first valid quote keeps its real (late) delay', async () => {
    await setup();
    lbank.futuresPath.set('ABCUSDT', [{ atMs: S - 1, price: '1', turnover: '5' }]);
    await intakeAbc();
    lbank.futuresFailAttempts = 2; // two timeouts inside the publication request …
    lbank.futuresDown = true; // … then it fails for good
    await publishAt(S + 10);
    lbank.futuresDown = false;
    const failed = await db.getRepository(FuturesPoll).findBy({ ok: false });
    expect(failed.map((x) => [x.trigger, x.attempt])).toEqual([
      ['PUBLICATION', 1],
      ['PUBLICATION', 2],
      ['PUBLICATION', 3],
    ]);
    expect(failed.every((x) => x.requestStartedAt && x.fetchedAt >= x.requestStartedAt)).toBe(true);
    expect(await refOf(1)).toBeUndefined();
    expect((await futOf(1)).status).toBe('PENDING');
    // The contract is missing from the next answer (invalid price): still no quote.
    lbank.futuresOmit.add('ABCUSDT');
    await publishAt(S + 7_000, 'RETRY');
    expect(await refOf(1)).toBeUndefined();
    lbank.futuresOmit.clear();
    lbank.futuresLatencyMs = 300;
    await tick(S + 60_000); // the minute sampler gets the first valid price
    const r = (await refOf(1))!;
    expect(r).toMatchObject({ source: 'TICK', failed_attempts_before: 3 });
    expect(new D(r.price).toFixed()).toBe('1');
    const q = (await app.get(ObservationReadService).list({ search: 'abc' })).rows[0]!
      .futuresSampled!.quote!;
    expect(q.delayMs).toBe(60_300); // the real delay, not backdated
    expect(q.source).toBe('TICK');
  });

  it('mapping without a CMC Futures list as of the crawl: unknown, never guessed', async () => {
    await setCutover();
    sampler().clearBuffer();
    lbank.futuresPath.set('ABCUSDT', [{ atMs: S - 1, price: '1', turnover: '1' }]);
    await intakeAbc();
    await publishAt(S + 10);
    expect(await futOf(1)).toMatchObject({ status: 'MAPPING_UNKNOWN', referencePrice: null });
    expect(await refOf(1)).toBeUndefined();
  });

  it('mapping: no contract anywhere, a ticker-only contract, a contract missing from the response', async () => {
    await setup();
    lbank.futuresPath.set('XYZUSDT', [{ atMs: S - 1, price: '5', turnover: '1' }]);
    lbank.futuresOmit.add('ABCUSDT'); // CMC attributes ABCUSDT to coin 1, but it is not in this answer
    lbank.futuresPath.set('ABCUSDT', [{ atMs: S - 1, price: '1', turnover: '1' }]);
    await intakeAbc();
    await intake(row(2, 'def', 2, '2030-01-02T00:07:00.078Z'), {
      scanCommitAt: '2030-01-02T00:15:32.457Z',
    });
    await intake(row(3, 'xyz', 1, '2030-01-02T00:07:00.078Z'), {
      scanCommitAt: '2030-01-02T00:15:32.457Z',
    });
    await publishAt(S + 10);
    expect((await futOf(2)).status).toBe('NO_CONTRACT');
    expect(await futOf(3)).toMatchObject({
      status: 'MAPPING_AMBIGUOUS',
      reasons: ['FUTURES_TICKER_ONLY'],
      referencePrice: null,
    });
    expect(await futOf(1)).toMatchObject({
      status: 'PENDING',
      mappingStatus: 'PENDING',
      reasons: ['FUTURES_NOT_IN_LBANK_LIST'],
    });
    lbank.futuresOmit.clear();
    await publishAt(S + 3_000, 'RETRY');
    expect(await futOf(1)).toMatchObject({ status: 'ACTIVE', contract: 'ABCUSDT' });
    expect((await refOf(1))!.request_started_at.getTime()).toBe(S + 3_000);
  });

  it('overlapping events of one contract: each has its own start and its own first observed quote', async () => {
    await setup();
    const S2 = t('2030-01-02T06:07:05.000Z').getTime();
    lbank.futuresPath.set('ABCUSDT', [
      { atMs: S - 1, price: '1', turnover: '5' },
      { atMs: S2 - 1, price: '2', turnover: '4' },
    ]);
    await intakeAbc(3);
    await publishAt(S + 10);
    await intake(row(1, 'abc', 2, '2030-01-02T06:07:00.000Z', { price: new D('2') }), {
      scanCommitAt: '2030-01-02T06:07:05.000Z',
    });
    at(S2 + 10);
    const e2 = await db.getRepository(ObsEvent).findOneByOrFail({ cmcId: 1, starCount: 2 });
    await quotes().capture(e2.sourceBatchId, 'PUBLICATION', 99);
    expect(new D((await refOf(1, 'ENTRY', 3))!.price).toFixed()).toBe('1');
    expect(new D((await refOf(1, 'ENTRY', 2))!.price).toFixed()).toBe('2');
    expect((await refOf(1, 'ENTRY', 2))!.request_started_at.getTime()).toBe(S2 + 10);
  });

  it('observed extremes stay inside [start, end); a response at the end is excluded; CLOSED, never FINAL', async () => {
    await setup();
    const end = S + 168 * H;
    lbank.futuresPath.set('ABCUSDT', [
      { atMs: S - 1, price: '1', turnover: '5' },
      { atMs: S + 50_000, price: '1.4', turnover: '4' },
      { atMs: S + 110_000, price: '0.8', turnover: '4' },
      { atMs: end - 2_000, price: '3', turnover: '4' },
    ]);
    await intakeAbc();
    await publishAt(S + 10);
    lbank.futuresLatencyMs = 0;
    await tick(S + 60_000);
    await tick(S + 120_000);
    lbank.futuresLatencyMs = 2_000;
    await tick(end - 2_000); // answered exactly at the end: outside the window
    lbank.futuresLatencyMs = 0;
    await tick(end + 1_000); // sent after the end: the window is over
    const f = await futOf(1);
    expect(f.status).toBe('CLOSED');
    expect(f.finalizedAt).not.toBeNull();
    expect(f.highestPrice!.toFixed()).toBe('1.4');
    expect(f.lowestPrice!.toFixed()).toBe('0.8');
    expect(f.highestReturnPct!.toFixed()).toBe(
      forStorage(new D('1.4').div('1').minus(1).times(100)),
    );
  });

  it('older-method events: their reference is untouched, the first post-fix quote is kept apart, and the snapshot storage defect is fixed', async () => {
    await setup();
    lbank.futuresPath.set('ABCUSDT', [{ atMs: S - 3 * H, price: '0.7', turnover: '1' }]);
    await intakeAbc();
    // An event of the earlier method, with its reference and an old snapshot of its contract.
    const o = await obsOf(1);
    const legacy = await db.getRepository(FuturesObservation).save(
      db.getRepository(FuturesObservation).create({
        observationId: o.id,
        providerId: P,
        rulesVersion: 'lbank-futures-sampled-1',
        mappingStatus: 'OK',
        contract: 'ABCUSDT',
        status: 'ACTIVE',
        reasons: ['WINDOW_OPEN'],
        referencePrice: new D('0.95') as never,
        referenceAfter: new Date(S + 60_000),
        referenceBefore: new Date(S + 121_000),
        // Its fold as the earlier method left it (the reference lives in the fold).
        fold: {
          ...emptyFold(),
          anchorMs: S - 3 * H,
          prev: { serverMs: S + 120_000, turnover: '1' },
          firstAfterStartMs: S + 60_000,
          samplesInWindow: 2,
          bracketedInWindow: 1,
          reference: {
            price: '0.95',
            afterMs: S + 60_000,
            beforeMs: S + 121_000,
            sampleMs: S + 120_000,
          },
          highest: {
            price: '0.95',
            afterMs: S + 60_000,
            beforeMs: S + 121_000,
            sampleMs: S + 120_000,
          },
          lowest: {
            price: '0.95',
            afterMs: S + 60_000,
            beforeMs: S + 121_000,
            sampleMs: S + 120_000,
          },
          throughMs: S + 120_000,
        } as never,
      }),
    );
    await db.query(
      `INSERT INTO lbank_futures_sample (contract, server_at, fetched_at, last_price, turnover_24h, volume_24h, response_sha256)
       VALUES ('ABCUSDT', $1, $1, 0.7, 1, 1, 'old')`,
      [new Date(S - 3 * H)],
    );
    lbank.futuresPath.set('ABCUSDT', [{ atMs: S - 3 * H, price: '0.96', turnover: '1' }]);
    await db.query(
      `UPDATE lbank_futures_observation SET mapping_status = 'PENDING' WHERE id = $1`,
      [legacy.id],
    );
    await tick(S + 3 * H); // contract not needed (mapping pending): only buffered
    await db.query(`UPDATE lbank_futures_observation SET mapping_status = 'OK' WHERE id = $1`, [
      legacy.id,
    ]);
    await tick(S + 3 * H + 60_000); // needed again: both buffered snapshots are stored (fix)
    const samples = await db.query(
      `SELECT server_at FROM lbank_futures_sample WHERE contract = 'ABCUSDT' ORDER BY server_at`,
    );
    expect(samples).toHaveLength(3);
    const f = await db.getRepository(FuturesObservation).findOneByOrFail({ id: legacy.id });
    expect(f.rulesVersion).toBe('lbank-futures-sampled-1');
    expect(f.referencePrice!.toFixed()).toBe('0.95'); // the old reference is kept as recorded
    const pf = (await refOf(1, 'POST_FIX'))!;
    expect(new D(pf.price).toFixed()).toBe('0.96');
    expect(pf.response_received_at.getTime()).toBe(S + 3 * H); // first post-fix observation, true time
    expect(await refOf(1, 'ENTRY')).toBeUndefined(); // never presented as an entry quote
    const v = (await app.get(ObservationReadService).list({ search: 'abc' })).rows[0]!
      .futuresSampled!;
    expect(v.method).toBe('LEGACY_TURNOVER_BRACKET');
    expect(v.postFixQuote?.delayMs).toBe(3 * H);
  });
});

describe('reference latency (follow-up runs, timeline, change token)', () => {
  it('a follow-up is due when the start minute closes, and stops once the reference is verified', async () => {
    await setCutover();
    const S = t('2030-01-02T00:15:32.457Z').getTime();
    const sm = Math.floor(S / MIN) * MIN;
    minute('abc_usdt', sm, [[40_123, '1.01', '3']]);
    await intake(row(1, 'abc', 3, '2030-01-02T00:07:00.078Z'), {
      scanCommitAt: '2030-01-02T00:15:32.457Z',
    });
    const svc = app.get(ObservationService);
    // Start minute 00:15 closes at 00:16:00; its candle is final 5 s later (+1 s slack).
    expect(await svc.nextFollowUpAt(S + 10_000)).toBe(t('2030-01-02T00:16:06.000Z').getTime());
    // Already closed and still pending (e.g. a failed request): retried a minute later.
    expect(await svc.nextFollowUpAt(sm + 2 * MIN)).toBe(sm + 2 * MIN + 60_000);
    // Only young starts are followed (the cron covers the rest).
    expect(await svc.nextFollowUpAt(S + 61 * MIN)).toBeNull();

    await runJob('2030-01-02T00:16:06Z');
    const o = await obsOf(1);
    expect(o.referenceStatus).toBe('VERIFIED');
    expect(await svc.nextFollowUpAt(S + 40_000)).toBeNull();

    const read = app.get(ObservationReadService);
    const d = (await read.detail(o.id)) as unknown as {
      timeline: {
        publishedAt: string;
        startMinuteReadableAt: string;
        marketDelayMs: number;
        processingDelayMs: number;
        referenceCheck: { status: string; checkedAt: string; run: { trigger: string } | null };
      };
    };
    expect(d.timeline.publishedAt).toBe('2030-01-02T00:15:32.457Z');
    expect(d.timeline.startMinuteReadableAt).toBe('2030-01-02T00:16:05.000Z');
    expect(d.timeline.marketDelayMs).toBe(7_666);
    expect(d.timeline.referenceCheck.status).toBe('VERIFIED');
    expect(d.timeline.referenceCheck.run?.trigger).toBe('cli');
    // Market delay (start → trade) and processing delay (trade → verified) are separate numbers.
    expect(d.timeline.processingDelayMs).toBe(
      Date.parse(d.timeline.referenceCheck.checkedAt) - t('2030-01-02T00:15:40.123Z').getTime(),
    );
    const v1 = await read.version();
    await runJob('2030-01-02T00:30:00Z');
    const v2 = await read.version();
    expect(v2.lastRunId).not.toBe(v1.lastRunId);
  });
});
