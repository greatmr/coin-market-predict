import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, In, IsNull } from 'typeorm';

import { redact } from '../../common/security/redact.js';
import { type DValue, forStorage } from '../../common/utils/decimal.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { ProviderService } from '../sources/provider.service.js';

import { CandleStoreService, type SyncReport } from './candle-store.service.js';
import { ObsEvent } from './entities/obs-event.entity.js';
import { ObsRun } from './entities/obs-run.entity.js';
import { ObservationResult } from './entities/observation-result.entity.js';
import { Observation } from './entities/observation.entity.js';
import { SpotPair } from './entities/spot-pair.entity.js';
import {
  LBANK_MARKET_SOURCE,
  LBANK_SPOT_PROVIDER_INFO,
  type LbankMarketSource,
} from './lbank-market.source.js';
import {
  type FetchedLists,
  ListingEvidenceService,
  futuresInput,
} from './listing-evidence.service.js';
import { type Assessment, assess } from './observation-assess.js';
import {
  type ListingDecision,
  futuresAtSignal,
  neededFromMs,
  observationWindow,
  resolveSpotPair,
} from './observation-rules.js';
import {
  CLOSED_BAR_MARGIN_MS,
  ENTRY_LOOKBACK_MS,
  EVIDENCE_MAX_LAG_MS,
  MAX_PAGES_PER_PAIR_PER_RUN,
  MINUTE_MS,
  OBSERVATION_RULES_VERSION,
  OBSERVATION_STATUSES,
  type ObservationStatus,
} from './observation.constants.js';

export interface ObsRunReport {
  runId: string;
  trigger: string;
  status: 'succeeded' | 'partial' | 'failed';
  observations: number;
  finalized: number;
  byStatus: Record<ObservationStatus, number>;
  pairs: { due: number; requests: number; stored: number; unsupported: number; errors: number };
  gaps: { retried: number; recovered: number };
  evidence: { checked: number; spotList: string | null; futuresList: string | null };
  reconciled: number;
  /** Candles deleted by LBANK_CANDLE_RETENTION_DAYS (none an unfinished observation needs). */
  pruned: number;
  failed: number;
  notes: string[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const store = (d: DValue | null) => (d === null ? null : d.toFixed());
const zero = () =>
  Object.fromEntries(OBSERVATION_STATUSES.map((s) => [s, 0])) as Record<ObservationStatus, number>;

/**
 * The observation job (docs/lbank-spot-observation.md § 7): for every observation that is not
 * final, (1) record Spot / Futures evidence near its signal, (2) bring its pair's shared candles up
 * to date (each pair at most once per LBANK_SYNC_INTERVAL_MINUTES unless an entry is still pending
 * or a window needs its last bars), (3) retry known gaps, (4) recompute entry, extremes, coverage,
 * eligibility and status from the stored bars, and (5) freeze terminal results. Runs under its own
 * lease, never the CMC pipeline's; never changes an event.
 */
@Injectable()
export class ObservationUpdateService {
  private readonly log = new Logger(ObservationUpdateService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(LBANK_MARKET_SOURCE) private readonly source: LbankMarketSource,
    private readonly candles: CandleStoreService,
    private readonly evidence: ListingEvidenceService,
    private readonly providers: ProviderService,
  ) {}

  async run(
    providerId: string,
    opts: { now: Date; trigger: 'schedule' | 'manual' | 'cli' },
  ): Promise<ObsRunReport> {
    const { now } = opts;
    if (this.source.isLive) await this.providers.ensureExists(LBANK_SPOT_PROVIDER_INFO);
    const runs = this.db.getRepository(ObsRun);
    await runs.update(
      { providerId, status: 'running' },
      { status: 'failed', finishedAt: now, error: 'interrupted before it finished' },
    );
    const run = await runs.save(
      runs.create({
        providerId,
        trigger: opts.trigger,
        startedAt: now,
        status: 'running',
        counts: null,
        notes: [],
        error: null,
      }),
    );
    const report: ObsRunReport = {
      runId: run.id,
      trigger: opts.trigger,
      status: 'succeeded',
      observations: 0,
      finalized: 0,
      byStatus: zero(),
      pairs: { due: 0, requests: 0, stored: 0, unsupported: 0, errors: 0 },
      gaps: { retried: 0, recovered: 0 },
      evidence: { checked: 0, spotList: null, futuresList: null },
      reconciled: 0,
      pruned: 0,
      failed: 0,
      notes: [],
    };
    const deadline = Date.now() + this.cfg.LBANK_OBSERVATION_MAX_MINUTES * 60_000;
    try {
      report.reconciled = await this.reconcile(providerId, now);
      const obs = await this.db.getRepository(Observation).find({
        where: { providerId, finalizedAt: IsNull() },
        order: { t0: 'ASC' },
      });
      report.observations = obs.length;
      const events = new Map(
        obs.length
          ? (
              await this.db.getRepository(ObsEvent).findBy({ id: In(obs.map((o) => o.eventId)) })
            ).map((e) => [e.id, e])
          : [],
      );
      await this.recordEvidence(providerId, obs, events, now, report);

      const byPair = new Map<number, Observation[]>();
      for (const o of obs)
        if (o.pairId !== null) byPair.set(o.pairId, [...(byPair.get(o.pairId) ?? []), o]);
      const pairs = new Map(
        byPair.size
          ? (await this.db.getRepository(SpotPair).findBy({ id: In([...byPair.keys()]) })).map(
              (p) => [p.id, p],
            )
          : [],
      );
      for (const [pairId, list] of byPair) {
        const pair = pairs.get(pairId)!;
        if (Date.now() < deadline) await this.syncPair(pair, list, now, report);
        else if (!report.notes.some((n) => n.startsWith('time bound')))
          report.notes.push(
            `time bound of ${this.cfg.LBANK_OBSERVATION_MAX_MINUTES} min reached: the remaining pairs are fetched next run`,
          );
        await this.evaluatePair(pair, list, events, now, report);
      }
      // Observations without a pair (mapping ambiguous / none) are evaluated on their own.
      const unpaired = obs.filter((o) => o.pairId === null);
      if (unpaired.length) await this.evaluatePair(null, unpaired, events, now, report);

      report.pruned = await this.candles
        .prune(now, this.cfg.LBANK_CANDLE_RETENTION_DAYS)
        .catch((err: unknown) => {
          report.notes.push(`candle retention failed: ${redact(err).slice(0, 200)}`);
          return 0;
        });
      report.status = report.failed || report.pairs.errors ? 'partial' : 'succeeded';
      report.notes.push(
        `${report.observations} observations: ${report.finalized} finalized; pairs due ${report.pairs.due}, ${report.pairs.requests} requests, ${report.pairs.stored} bars stored, ${report.pairs.unsupported} unsupported, ${report.pairs.errors} errors; gaps retried ${report.gaps.retried} (+${report.gaps.recovered} bars); ${report.pruned} old candles pruned`,
      );
      await runs.update(
        { id: run.id },
        {
          status: report.status,
          finishedAt: new Date(),
          counts: JSON.parse(JSON.stringify({ ...report, notes: undefined })) as never,
          notes: report.notes,
        },
      );
      this.log.log(
        `LBank observation run (${opts.trigger}): ${report.status}; ${report.notes.at(-1)}`,
      );
      return report;
    } catch (err) {
      const error = redact(err).slice(0, 2000);
      await runs.update({ id: run.id }, { status: 'failed', finishedAt: new Date(), error });
      throw err;
    }
  }

  /**
   * No-missed-event check: an event without its observation (impossible through the intake, which
   * writes both in one transaction) gets one here and is counted, so it can never go unobserved.
   */
  private async reconcile(providerId: string, now: Date): Promise<number> {
    const orphans: Array<{ id: string }> = await this.db.query(
      `SELECT e.id FROM lbank_obs_event e LEFT JOIN lbank_observation o ON o.event_id = e.id
        WHERE e.provider_id = $1 AND o.id IS NULL`,
      [providerId],
    );
    if (!orphans.length) return 0;
    for (const { id } of orphans) {
      const e = await this.db.getRepository(ObsEvent).findOneByOrFail({ id });
      const w = observationWindow(e.detectedAt);
      const mapping = resolveSpotPair(e.lbankPairs);
      const pairId =
        mapping.status === 'OK'
          ? await this.candles.ensurePair(
              this.db.manager,
              mapping.symbol!,
              mapping.base!,
              mapping.quote!,
            )
          : null;
      await this.db
        .createQueryBuilder()
        .insert()
        .into(Observation)
        .values({
          eventId: e.id,
          providerId,
          isLive: e.isLive,
          t0: e.detectedAt,
          windowEnd: new Date(w.cutoffMs),
          pairId,
          pairSymbol: mapping.symbol,
          quoteAsset: mapping.quote,
          mappingStatus: mapping.status,
          mappingEvidence: {
            ...mapping.evidence,
            reasons: mapping.reasons,
            decidedAt: now.toISOString(),
            reconciled: true,
          } as never,
          spotStatus: 'UNKNOWN',
          futuresStatus: 'UNKNOWN',
          eligibility: 'PENDING',
          eligibilityEvidence: {} as never,
          expectedBars: w.expectedBars,
          coveredBars: 0,
          tradedBars: 0,
          missingBars: 0,
          missingRanges: [] as never,
          startUnobservedMs: w.startUnobservedMs,
          boundaryUnobservedMs: w.boundaryUnobservedMs,
          status: 'ACTIVE',
          reasons: mapping.reasons,
          rulesVersion: OBSERVATION_RULES_VERSION,
          resultVersion: 0,
        })
        .orIgnore()
        .updateEntity(false)
        .execute();
    }
    this.log.warn(`reconciled ${orphans.length} events that had no observation`);
    return orphans.length;
  }

  /** Spot / Futures list evidence for observations that have none yet (once per observation). */
  private async recordEvidence(
    providerId: string,
    obs: Observation[],
    events: Map<string, ObsEvent>,
    now: Date,
    report: ObsRunReport,
  ): Promise<void> {
    const todo = obs.filter((o) => !o.eligibilityCheckedAt);
    if (!todo.length) return;
    const fresh = todo.filter((o) => now.getTime() - o.t0.getTime() <= EVIDENCE_MAX_LAG_MS);
    const lists: FetchedLists = fresh.length
      ? await this.evidence.fetchLists()
      : { spot: null, futures: null };
    report.evidence.spotList = lists.spot
      ? 'error' in lists.spot
        ? `error: ${lists.spot.error}`
        : 'ok'
      : null;
    report.evidence.futuresList = lists.futures
      ? 'error' in lists.futures
        ? `error: ${lists.futures.error}`
        : 'ok'
      : null;
    const byT0 = new Map<number, Observation[]>();
    for (const o of todo) byT0.set(o.t0.getTime(), [...(byT0.get(o.t0.getTime()) ?? []), o]);
    for (const [t0, group] of byT0) {
      const cmc = await this.evidence.cmcFuturesAt(
        providerId,
        new Date(t0),
        group.map((o) => ({
          cmcId: events.get(o.eventId)!.cmcId,
          symbol: events.get(o.eventId)!.symbol,
        })),
      );
      for (const o of group) {
        const e = events.get(o.eventId)!;
        const inLag = now.getTime() - o.t0.getTime() <= EVIDENCE_MAX_LAG_MS;
        const spot = inLag ? lists.spot : null;
        const fut = inLag ? lists.futures : null;
        const futContracts = fut && !('error' in fut) ? fut.contracts : null;
        const cmcAt = cmc.get(e.cmcId)!;
        const futures: ListingDecision = futuresAtSignal(
          futuresInput(cmcAt, futContracts, e.symbol),
        );
        const relevant = futContracts
          ? [...futContracts.values()].filter(
              (c) => cmcAt.contracts.includes(c.symbol) || c.base === e.symbol.toUpperCase(),
            )
          : [];
        const evidence = {
          checkedAt: now.toISOString(),
          evidenceLagMs: now.getTime() - o.t0.getTime(),
          lbankSpotList: !spot
            ? {
                notFetched: inLag
                  ? 'list not fetched'
                  : `signal older than ${EVIDENCE_MAX_LAG_MS / 3_600_000} h at the first check`,
              }
            : 'error' in spot
              ? { fetchId: spot.fetchId, error: spot.error.slice(0, 300) }
              : {
                  fetchId: spot.fetchId,
                  fetchedAt: spot.fetchedAt.toISOString(),
                  listed: o.pairSymbol ? spot.symbols.has(o.pairSymbol) : null,
                },
          lbankFutures: !fut
            ? {
                notFetched: inLag
                  ? 'list not fetched'
                  : 'signal older than the evidence lag at the first check',
              }
            : 'error' in fut
              ? { fetchId: fut.fetchId, error: fut.error.slice(0, 300) }
              : {
                  fetchId: fut.fetchId,
                  fetchedAt: fut.fetchedAt.toISOString(),
                  contracts: relevant,
                },
          cmcFutures: cmcAt,
          futures,
        };
        await this.db.getRepository(Observation).update(
          { id: o.id },
          {
            eligibilityEvidence: evidence as never,
            eligibilityCheckedAt: now,
            futuresStatus: futures.status,
            spotListFetchId: spot ? spot.fetchId : null,
            futuresListFetchId: fut ? fut.fetchId : null,
          },
        );
        o.eligibilityEvidence = evidence;
        o.eligibilityCheckedAt = now;
        o.futuresStatus = futures.status;
        report.evidence.checked++;
      }
    }
  }

  private pairDue(pair: SpotPair, list: Observation[], now: Date): boolean {
    if (!pair.lastFetchAt) return true;
    if (list.some((o) => !o.entryAt)) return true;
    const closedNow = now.getTime() - CLOSED_BAR_MARGIN_MS - MINUTE_MS;
    if (
      list.some(
        (o) =>
          o.windowEnd.getTime() <= closedNow &&
          (o.observedThrough?.getTime() ?? 0) <
            Math.floor(o.windowEnd.getTime() / MINUTE_MS) * MINUTE_MS,
      )
    )
      return true;
    return (
      now.getTime() - pair.lastFetchAt.getTime() >= this.cfg.LBANK_SYNC_INTERVAL_MINUTES * 60_000
    );
  }

  private async syncPair(
    pair: SpotPair,
    list: Observation[],
    now: Date,
    report: ObsRunReport,
  ): Promise<void> {
    if (!this.pairDue(pair, list, now)) return;
    report.pairs.due++;
    const synced = pair.syncedUntil?.getTime() ?? null;
    const needs = list
      .map((o) => neededFromMs(observationWindow(o.t0), synced))
      .filter((n): n is number => n !== null);
    if (needs.length) {
      const from = Math.min(...needs);
      const until = Math.min(
        Math.floor((now.getTime() - CLOSED_BAR_MARGIN_MS) / MINUTE_MS) * MINUTE_MS,
        Math.max(...list.map((o) => observationWindow(o.t0).endExclusiveMs)),
      );
      try {
        await this.candles.ensureFirstBar(pair);
      } catch {
        // listing evidence only; retried next run
      }
      const r: SyncReport = await this.candles.sync(
        pair,
        from,
        until,
        now,
        MAX_PAGES_PER_PAIR_PER_RUN,
      );
      report.pairs.requests += r.requests;
      report.pairs.stored += r.stored;
      if (r.outcome === 'unsupported') report.pairs.unsupported++;
      if (r.outcome === 'error') {
        report.pairs.errors++;
        if (report.pairs.errors <= 3) report.notes.push(`${pair.symbol}: ${r.error}`);
      }
      if (r.anomalies.duplicates || r.anomalies.unordered || r.anomalies.invalid)
        report.notes.push(
          `${pair.symbol}: API anomalies ${JSON.stringify(r.anomalies)} (dropped, not stored)`,
        );
    }
    // Known gaps (minutes answered without a bar) are asked for again, oldest first, two per pair.
    let retried = 0;
    for (const o of list) {
      for (const [from, to] of o.missingRanges ?? []) {
        if (retried >= 2) break;
        const f = Date.parse(from);
        const t = Date.parse(to);
        if (!(t <= (pair.syncedUntil?.getTime() ?? 0))) continue;
        retried++;
        report.gaps.retried++;
        report.gaps.recovered += await this.candles.refetchGap(pair, f, t, now).catch(() => 0);
      }
    }
  }

  /** Recompute every listed observation of one pair from the pair's stored bars (loaded once). */
  private async evaluatePair(
    pair: SpotPair | null,
    list: Observation[],
    events: Map<string, ObsEvent>,
    now: Date,
    report: ObsRunReport,
  ): Promise<void> {
    let bars: Awaited<ReturnType<CandleStoreService['loadBars']>> = [];
    if (pair) {
      const from = Math.min(
        ...list.map((o) => observationWindow(o.t0).entryFromMs - ENTRY_LOOKBACK_MS),
      );
      const to = Math.max(...list.map((o) => observationWindow(o.t0).endExclusiveMs));
      bars = await this.candles.loadBars(pair.id, from, to);
    }
    for (const o of list) {
      const e = events.get(o.eventId);
      if (!e) continue;
      try {
        const ev = (o.eligibilityEvidence ?? {}) as {
          lbankSpotList?: { listed?: boolean | null };
          futures?: ListingDecision;
        };
        const a = assess({
          now,
          t0: o.t0,
          cmcPrice: e.cmcPriceUsd,
          mapping: o.mappingStatus,
          mappingReasons: ((o.mappingEvidence as { reasons?: string[] }).reasons ?? []) as string[],
          bars,
          syncedUntilMs: pair?.syncedUntil?.getTime() ?? null,
          unsupportedSince: pair?.unsupportedSince ?? null,
          spotListed:
            typeof ev.lbankSpotList?.listed === 'boolean' ? ev.lbankSpotList.listed : null,
          futures: ev.futures ?? { status: 'UNKNOWN', reasons: ['FUTURES_EVIDENCE_PENDING'] },
          fetchError: pair?.lastFetchStatus === 'error' ? pair.lastError : null,
        });
        await this.save(o, a, now);
        report.byStatus[a.status.status]++;
        if (a.status.terminal) report.finalized++;
      } catch (err) {
        report.failed++;
        const message = redact(err).slice(0, 300);
        if (report.failed <= 3) report.notes.push(`observation ${o.id}: ${message}`);
        await this.db
          .getRepository(Observation)
          .update({ id: o.id }, { lastAttemptAt: now, lastError: message })
          .catch(() => undefined);
      }
    }
  }

  private async save(o: Observation, a: Assessment, now: Date): Promise<void> {
    const e = a.entry.kind === 'ok' ? a.entry : null;
    const x = a.extremes;
    const missingRanges = a.cov.missingRanges.map(([f, t]) => [iso(f), iso(t)] as [string, string]);
    const fields = {
      spotStatus: a.spot.status,
      spotTrading: a.spot.trading,
      futuresStatus: a.futures.status,
      eligibility: a.eligibility,
      eligibilityEvidence: {
        ...(o.eligibilityEvidence ?? {}),
        spot: { status: a.spot.status, trading: a.spot.trading, reasons: a.spot.reasons },
      } as never,
      entryAt: e ? new Date(e.bar.openMs) : null,
      entryPrice: store(e?.price ?? null) as never,
      entryDelayMs: e ? e.delayMs : null,
      entryLastTradeAt: e && e.lastTradeBarMs !== null ? new Date(e.lastTradeBarMs) : null,
      entryStale: e ? e.stale : null,
      highPrice: store(x?.high ?? null) as never,
      highBarAt: x ? new Date(x.highBarMs) : null,
      lowPrice: store(x?.low ?? null) as never,
      lowBarAt: x ? new Date(x.lowBarMs) : null,
      maxRisePct: forStorage(a.risePct) as never,
      maxDropPct: forStorage(a.dropPct) as never,
      lowBeforeHighPrice: store(x?.lowBeforeHigh ?? null) as never,
      lowBeforeHighBarAt: x ? new Date(x.lowBeforeHighBarMs) : null,
      extremeOrder: x?.order ?? null,
      observedThrough: new Date(a.cov.observedThroughMs),
      coveredBars: a.cov.presentBars,
      tradedBars: a.cov.tradedBars,
      missingBars: a.cov.missingBars,
      missingRanges: missingRanges as never,
      status: a.status.status,
      reasons: a.status.reasons,
      rulesVersion: OBSERVATION_RULES_VERSION,
      lastUpdateAt: now,
      lastAttemptAt: now,
      lastError: null,
    };
    if (!a.status.terminal) {
      await this.db.getRepository(Observation).update({ id: o.id }, fields);
      o.missingRanges = missingRanges;
      return;
    }
    await this.db.transaction(async (m) => {
      const version = o.resultVersion + 1;
      await m.getRepository(ObservationResult).insert({
        observationId: o.id,
        resultVersion: version,
        status: a.status.status,
        eligibility: a.eligibility,
        reasons: a.status.reasons,
        rulesVersion: OBSERVATION_RULES_VERSION,
        entryAt: fields.entryAt,
        entryPrice: fields.entryPrice,
        entryDelayMs: fields.entryDelayMs,
        highPrice: fields.highPrice,
        highBarAt: fields.highBarAt,
        lowPrice: fields.lowPrice,
        lowBarAt: fields.lowBarAt,
        maxRisePct: fields.maxRisePct,
        maxDropPct: fields.maxDropPct,
        lowBeforeHighPrice: fields.lowBeforeHighPrice,
        lowBeforeHighBarAt: fields.lowBeforeHighBarAt,
        extremeOrder: fields.extremeOrder,
        expectedBars: a.cov.expectedBars,
        coveredBars: a.cov.presentBars,
        tradedBars: a.cov.tradedBars,
        missingBars: a.cov.missingBars,
        missingRanges: missingRanges as never,
        seriesSha256: a.seriesSha256,
        computedAt: now,
      });
      await m
        .getRepository(Observation)
        .update(
          { id: o.id },
          { ...fields, seriesSha256: a.seriesSha256, resultVersion: version, finalizedAt: now },
        );
    });
  }
}
