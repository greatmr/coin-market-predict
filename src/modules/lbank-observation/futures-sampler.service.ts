import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { DataSource } from 'typeorm';

import { redact } from '../../common/security/redact.js';
import { D } from '../../common/utils/decimal.js';
import { type Clock, systemClock } from '../../common/utils/time.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { LeaseService } from '../pipeline/lease.service.js';
import { CutoverService } from '../star-events/cutover.service.js';

import { FuturesObservation } from './entities/futures-observation.entity.js';
import { FuturesQuoteService, type PolledResponse } from './futures-quote.service.js';
import {
  FUTURES_RULES_VERSION,
  FUTURES_TERMINAL,
  type FuturesFoldState,
  type FuturesSample,
  emptyFold,
  evaluateFutures,
  foldFutures,
  mapFuturesContract,
} from './futures-rules.js';
import { LBANK_MARKET_SOURCE, type LbankMarketSource } from './lbank-market.source.js';

export const FUTURES_LEASE = 'lbank-futures-sampler';
const LEASE_TTL_MS = 5 * 60_000;
const CRON_NAME = 'lbank-futures-sampler';
/**
 * Snapshots kept in memory so a contract that becomes needed (its observation was mapped after the
 * start) still gets the snapshot from before its start: an observation is mapped by the observation
 * job within minutes of the intake (follow-up runs). Lost on restart: such an observation's start is
 * then unsampled and its Futures result HISTORY_UNAVAILABLE (never filled from elsewhere).
 */
const BUFFER_POLLS = 60;
/** Snapshots folded per observation per tick (a backlog continues next tick). */
const FOLD_BATCH = 20_000;

export interface FuturesTickReport {
  poll: { ok: boolean; serverAt: string | null; contracts: number; stored: number; error?: string };
  created: number;
  mapped: number;
  evaluated: number;
  finalized: number;
}

interface OpenRow {
  id: string;
  observation_id: string;
  mapping_status: string;
  contract: string | null;
  fold: FuturesFoldState | Record<string, never>;
  observation_start: Date | null;
  observation_end: Date | null;
  eligibility_evidence: Record<string, unknown> | null;
  eligibility_checked_at: Date | null;
  symbol: string;
  cmc_price_usd: string;
}

/**
 * LBank Futures sampled observation (rules `lbank-futures-sampled-1`, docs § 13): reads LBank's
 * official Futures `marketData` snapshot every LBANK_FUTURES_SAMPLE_CRON, stores the snapshots of the
 * contracts open observations need, and folds them into each observation's Futures result. Its own
 * lease; it never writes a Spot row and never reads a Spot price.
 */
@Injectable()
export class FuturesSamplerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(FuturesSamplerService.name);
  clock: Clock = systemClock;
  private running = false;
  /** Recent stored responses (each with its request id), newest last. */
  private buffer: PolledResponse[] = [];

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(LBANK_MARKET_SOURCE) private readonly source: LbankMarketSource,
    private readonly registry: SchedulerRegistry,
    private readonly leases: LeaseService,
    private readonly cutover: CutoverService,
    private readonly quotes: FuturesQuoteService,
  ) {}

  get providerId() {
    return this.cfg.DATA_SOURCE;
  }

  onApplicationBootstrap() {
    if (
      !this.cfg.SCHEDULER_ENABLED ||
      !this.cfg.LBANK_OBSERVATION_ENABLED ||
      !this.cfg.LBANK_FUTURES_ENABLED
    )
      return;
    const job = CronJob.from({
      cronTime: this.cfg.LBANK_FUTURES_SAMPLE_CRON,
      timeZone: 'UTC',
      onTick: () => void this.scheduledTick(),
      start: true,
    });
    this.registry.addCronJob(CRON_NAME, job);
    this.log.log(`LBank Futures sampler "${this.cfg.LBANK_FUTURES_SAMPLE_CRON}" UTC`);
  }

  onApplicationShutdown() {
    if (this.registry.doesExist('cron', CRON_NAME)) void this.registry.getCronJob(CRON_NAME).stop();
  }

  private async scheduledTick() {
    try {
      if (!(await this.cutover.get(this.providerId))) return;
      await this.tick();
    } catch (err) {
      this.log.error(`LBank Futures sampler failed: ${redact(err)}`);
    }
  }

  /** Tests and restarts: forget the buffered snapshots (as a process restart does). */
  clearBuffer() {
    this.buffer = [];
  }

  /** One sampling tick under the sampler lease (skipped while another holds it). */
  async tick(): Promise<FuturesTickReport | { skipped: string }> {
    if (this.running) return { skipped: 'a tick is already running in this process' };
    const holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    if (!(await this.leases.acquire(FUTURES_LEASE, holder, LEASE_TTL_MS)))
      return { skipped: 'another instance holds the Futures sampler lease' };
    this.running = true;
    try {
      return await this.run();
    } finally {
      this.running = false;
      await this.leases.release(FUTURES_LEASE, holder).catch(() => undefined);
    }
  }

  private async run(): Promise<FuturesTickReport> {
    const report: FuturesTickReport = {
      poll: { ok: false, serverAt: null, contracts: 0, stored: 0 },
      created: 0,
      mapped: 0,
      evaluated: 0,
      finalized: 0,
    };
    // New Futures rows use the observed-quote method; rows from before it keep theirs.
    report.created = await this.quotes.ensureRows();
    report.mapped = await this.mapPending();

    const queuedAt = this.clock.now();
    const fetch = await this.source.futuresMarketData();
    let serverMs: number | null = null;
    let inPoll = new Set<string>();
    let current: PolledResponse | null = null;
    if (!fetch.ok) {
      report.poll.error = fetch.error.slice(0, 300);
      await this.quotes.recordRequest(fetch, {
        trigger: 'TICK',
        queuedAt,
        batchId: null,
        keepBody: false,
      });
    } else {
      const rows = new Map(fetch.rows.map((r) => [r.symbol, r]));
      inPoll = new Set(rows.keys());
      serverMs = fetch.rows.length ? Math.max(...fetch.rows.map((r) => r.serverMs)) : null;
      const plan = await this.planStore(rows);
      current = await this.quotes.recordRequest(fetch, {
        trigger: 'TICK',
        queuedAt,
        batchId: null,
        keepBody: false,
        stored: plan.count,
      });
      if (current) {
        this.buffer.push(current);
        if (this.buffer.length > BUFFER_POLLS) this.buffer.shift();
        report.poll.stored = await this.storeNeeded(plan.lastStored);
      }
      report.poll = {
        ok: true,
        serverAt: serverMs === null ? null : new Date(serverMs).toISOString(),
        contracts: rows.size,
        stored: report.poll.stored,
      };
    }
    if (current) {
      // Events already running when the observed-quote method arrived: their first post-fix quote.
      await this.quotes.postFix(current);
      // Observed-quote rows: map with this response, choose the first observed quote if still none.
      await this.quotes.settle(await this.quotes.quoteRows(), current);
    }
    const ev = await this.evaluateOpen(serverMs, inPoll);
    const q = await this.quotes.evaluate(await this.quotes.quoteRows());
    report.evaluated = ev.evaluated + q.evaluated;
    report.finalized = ev.finalized + q.finalized;
    return report;
  }

  /** Map the contract once the observation job has recorded the listing evidence. */
  private async mapPending(): Promise<number> {
    const rows: Array<{
      id: string;
      eligibility_evidence: Record<string, unknown> | null;
      eligibility_checked_at: Date | null;
      symbol: string;
    }> = await this.db.query(
      `SELECT f.id, o.eligibility_evidence, o.eligibility_checked_at, e.symbol
         FROM lbank_futures_observation f
         JOIN lbank_observation o ON o.id = f.observation_id
         JOIN lbank_obs_event e ON e.id = o.event_id
        WHERE f.provider_id = $1 AND f.mapping_status = 'PENDING' AND f.finalized_at IS NULL
          AND f.rules_version = $2`,
      [this.providerId, FUTURES_RULES_VERSION],
    );
    let n = 0;
    for (const r of rows) {
      if (!r.eligibility_checked_at) continue;
      const m = mapFuturesContract({ evidence: r.eligibility_evidence, coinSymbol: r.symbol });
      await this.db.getRepository(FuturesObservation).update(
        { id: r.id },
        {
          mappingStatus: m.status,
          contract: m.contract,
          mappingEvidence: m.evidence as never,
          reasons: m.reasons,
          lastUpdateAt: this.clock.now(),
        },
      );
      n++;
    }
    return n;
  }

  /** Contracts open, mapped observations need (either method), with their latest stored snapshot. */
  private async needed(): Promise<Map<string, number | null>> {
    const rows: Array<{ contract: string; last: Date | null }> = await this.db.query(
      `SELECT c.contract, (SELECT max(s.server_at) FROM lbank_futures_sample s WHERE s.contract = c.contract) AS last
         FROM (SELECT DISTINCT f.contract FROM lbank_futures_observation f
                WHERE f.provider_id = $1 AND f.finalized_at IS NULL AND f.mapping_status = 'OK'
                  AND f.contract IS NOT NULL) c`,
      [this.providerId],
    );
    return new Map(rows.map((r) => [r.contract, r.last ? new Date(r.last).getTime() : null]));
  }

  /** How many snapshots this tick will store (logged on the request row). */
  private async planStore(
    currentRows: ReadonlyMap<string, { serverMs: number }>,
  ): Promise<{ count: number; lastStored: Map<string, number | null> }> {
    const lastStored = await this.needed();
    let count = 0;
    for (const [contract, last] of lastStored) {
      for (const p of this.buffer) {
        const r = p.rows.get(contract);
        if (r && (last === null || r.serverMs > last)) count++;
      }
      const r = currentRows.get(contract);
      if (r && (last === null || r.serverMs > last)) count++;
    }
    return { count, lastStored };
  }

  /**
   * Store every buffered snapshot (this tick's included) newer than the contract's latest stored
   * one, each with the request that returned it. Fixed 2026-11-27: an older snapshot of the contract
   * (another event's) used to stop the buffered ones being stored (CFG, PONS, THETA at 09:07 and
   * SOMI at 10:07 lost their 09:07 / 09:08 and 10:07 / 10:08 snapshots).
   */
  private async storeNeeded(lastStored: Map<string, number | null>): Promise<number> {
    let stored = 0;
    for (const [contract, last] of lastStored)
      for (const p of this.buffer) {
        const r = p.rows.get(contract);
        if (r && (last === null || r.serverMs > last))
          stored += await this.quotes.storeSamples(p, [contract]);
      }
    return stored;
  }

  /** Fold new snapshots into every open Futures observation and decide its status. */
  private async evaluateOpen(
    lastPollServerMs: number | null,
    inPoll: ReadonlySet<string>,
  ): Promise<{ evaluated: number; finalized: number }> {
    const open: OpenRow[] = await this.db.query(
      `SELECT f.id, f.observation_id, f.mapping_status, f.contract, f.fold,
              o.observation_start, o.observation_end, o.eligibility_evidence, o.eligibility_checked_at,
              e.symbol, e.cmc_price_usd::text AS cmc_price_usd
         FROM lbank_futures_observation f
         JOIN lbank_observation o ON o.id = f.observation_id
         JOIN lbank_obs_event e ON e.id = o.event_id
        WHERE f.provider_id = $1 AND f.finalized_at IS NULL AND f.rules_version = $2`,
      [this.providerId, FUTURES_RULES_VERSION],
    );
    const now = this.clock.now();
    let finalized = 0;
    for (const r of open) {
      const mapping =
        r.mapping_status === 'PENDING'
          ? mapFuturesContract({ evidence: null, coinSymbol: r.symbol })
          : mapFuturesContract({
              evidence: r.eligibility_checked_at ? r.eligibility_evidence : null,
              coinSymbol: r.symbol,
            });
      const window =
        r.observation_start && r.observation_end
          ? { startMs: r.observation_start.getTime(), endMs: r.observation_end.getTime() }
          : null;
      let fold: FuturesFoldState =
        r.fold && 'samplesInWindow' in r.fold ? (r.fold as FuturesFoldState) : emptyFold();
      if (mapping.status === 'OK' && r.contract && window && !fold.unsampledStart) {
        const samples = await this.samplesAfter(r.contract, fold, window.startMs);
        fold = foldFutures(fold, samples, window);
      }
      const e = evaluateFutures({
        nowMs: now.getTime(),
        mapping,
        window,
        fold,
        lastPollServerMs,
        contractInLastPoll: !!r.contract && inPoll.has(r.contract),
        cmcPriceUsd: new D(r.cmc_price_usd),
      });
      const terminal = e.terminal && FUTURES_TERMINAL.includes(e.status);
      const ref = fold.reference;
      const hi = ref ? fold.highest : null;
      const lo = ref ? fold.lowest : null;
      await this.db.getRepository(FuturesObservation).update(
        { id: r.id },
        {
          status: e.status,
          reasons: e.reasons,
          flags: e.flags,
          fold: fold as never,
          referencePrice: ref ? (ref.price as never) : null,
          referenceAfter: ref ? new Date(ref.afterMs) : null,
          referenceBefore: ref ? new Date(ref.beforeMs) : null,
          highestPrice: hi ? (hi.price as never) : null,
          highestAfter: hi ? new Date(hi.afterMs) : null,
          highestBefore: hi ? new Date(hi.beforeMs) : null,
          highestReturnPct: (e.highestReturnPct?.toFixed() ?? null) as never,
          lowestPrice: lo ? (lo.price as never) : null,
          lowestAfter: lo ? new Date(lo.afterMs) : null,
          lowestBefore: lo ? new Date(lo.beforeMs) : null,
          lowestReturnPct: (e.lowestReturnPct?.toFixed() ?? null) as never,
          samplesInWindow: fold.samplesInWindow,
          bracketedInWindow: fold.bracketedInWindow,
          maxGapMs: String(fold.maxGapMs),
          sampledThrough: fold.throughMs === null ? null : new Date(fold.throughMs),
          lastUpdateAt: now,
          finalizedAt: terminal ? now : null,
        },
      );
      if (terminal) finalized++;
    }
    return { evaluated: open.length, finalized };
  }

  /** The contract's snapshots not folded yet (the first fold starts at the last one ≤ the start). */
  private async samplesAfter(
    contract: string,
    fold: FuturesFoldState,
    startMs: number,
  ): Promise<FuturesSample[]> {
    const rows: Array<{
      server_at: Date;
      fetched_at: Date;
      last_price: string;
      turnover_24h: string;
    }> = fold.prev
      ? await this.db.query(
          `SELECT server_at, fetched_at, last_price::text, turnover_24h::text FROM lbank_futures_sample
            WHERE contract = $1 AND server_at > $2 ORDER BY server_at LIMIT ${FOLD_BATCH}`,
          [contract, new Date(fold.prev.serverMs)],
        )
      : await this.db.query(
          `SELECT server_at, fetched_at, last_price::text, turnover_24h::text FROM lbank_futures_sample
            WHERE contract = $1
              AND server_at >= coalesce((SELECT max(server_at) FROM lbank_futures_sample
                                          WHERE contract = $1 AND server_at <= $2), $2)
            ORDER BY server_at LIMIT ${FOLD_BATCH}`,
          [contract, new Date(startMs)],
        );
    return rows.map((x) => ({
      serverMs: x.server_at.getTime(),
      fetchedMs: x.fetched_at.getTime(),
      lastPrice: new D(x.last_price),
      turnover: new D(x.turnover_24h),
    }));
  }
}
