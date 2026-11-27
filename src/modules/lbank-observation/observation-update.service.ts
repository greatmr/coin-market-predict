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
import { ObsRulesChange } from './entities/rules-change.entity.js';
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
  type Bar,
  type ExtremeEval,
  type ListingDecision,
  type MinuteCheck,
  type PairSync,
  type Trade,
  barMap,
  futuresAtSignal,
  neededFromMs,
  observationWindow,
  resolveSpotPair,
} from './observation-rules.js';
import { actionableTiming } from './observation-timing.js';
import { newObservationValues, timingValues } from './observation-values.js';
import {
  CLOSED_BAR_MARGIN_MS,
  EVIDENCE_MAX_LAG_MS,
  FINALIZE_RETRY_MS,
  MAX_PAGES_PER_PAIR_PER_RUN,
  MAX_TRADE_MINUTES_PER_PAIR_PER_RUN,
  MINUTE_MS,
  OBSERVATION_RULES_V1,
  OBSERVATION_RULES_VERSION,
  OBSERVATION_STATUSES,
  type ObservationStatus,
  type ReferenceStatus,
  SPOT_LOOKBACK_MS,
} from './observation.constants.js';
import { TradeStoreService } from './trade-store.service.js';

export interface ObsRunReport {
  runId: string;
  trigger: string;
  status: 'succeeded' | 'partial' | 'failed';
  observations: number;
  finalized: number;
  byStatus: Record<ObservationStatus, number>;
  pairs: {
    due: number;
    requests: number;
    stored: number;
    answered: number;
    unsupported: number;
    errors: number;
  };
  trades: {
    minutesChecked: number;
    verified: number;
    failed: number;
    requests: number;
    outsideCandle: number;
  };
  gaps: { retried: number; recovered: number };
  evidence: { checked: number; spotList: string | null; futuresList: string | null };
  reconciled: number;
  /** Observations whose start was established in this run (and how it was proven). */
  timingAssigned: number;
  /** Observations moved to the current rules version in this run (audit rows written). */
  rulesChanged: number;
  /** Candles deleted by LBANK_CANDLE_RETENTION_DAYS after their day was archived. */
  pruned: number;
  archivedDays: number;
  /** New LBank data stored in this run (candles or trades); false = only recomputed. */
  fetchedNewData: boolean;
  failed: number;
  notes: string[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const store = (d: DValue | null | undefined) =>
  d === null || d === undefined ? null : d.toFixed();
const zero = () =>
  Object.fromEntries(OBSERVATION_STATUSES.map((s) => [s, 0])) as Record<ObservationStatus, number>;
const tradeJson = (t: Trade | null | undefined) =>
  t
    ? {
        id: t.id,
        time: iso(t.timeMs),
        ord: t.ord,
        price: t.price.toFixed(),
        qty: t.qty.toFixed(),
        buyerMaker: t.buyerMaker,
      }
    : null;
const latest = (...ds: Array<Date | null | undefined>) =>
  ds.reduce<Date | null>((a, d) => (d && (!a || d > a) ? d : a), null);
const extremeJson = (e: ExtremeEval | null) =>
  e
    ? {
        best: tradeJson(e.best),
        minute: e.bestMinuteMs === null ? null : iso(e.bestMinuteMs),
        proven: e.proven,
        checked: e.checked.slice(0, 25).map((c) => ({ ...c, minute: iso(c.minuteMs) })),
        blocking: e.blocking
          .slice(0, 25)
          .map((b) => ({ from: iso(b.fromMs), to: iso(b.toMs), kind: b.kind, state: b.state })),
      }
    : null;

const RULES_V2_REASON =
  'rules lbank-spot-obs-2 (2026-11-25): the window starts when the star signal was proven usable (scan commit), the reference is the first verified LBank Spot trade at or after it, and the extremes are verified trades; the v1 candle values stay on the row as an audit record';

/**
 * The observation job (docs/lbank-spot-observation.md § 7): (1) move rows of older rules to the
 * current rules with an audit row, (2) establish each observation's start from server records,
 * (3) record Spot / Futures evidence near the signal, (4) bring each pair's shared candles up to
 * date and re-request known gaps, (5) check the complete trade lists of the minutes the rules need
 * (reference, boundaries, candidate extremes; shared per pair, within a per-run budget), (6)
 * recompute every unfinished observation and freeze terminal results, (7) archive and prune old
 * candles. Its own lease, never the CMC pipeline's; never changes an event.
 */
@Injectable()
export class ObservationUpdateService {
  private readonly log = new Logger(ObservationUpdateService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(LBANK_MARKET_SOURCE) private readonly source: LbankMarketSource,
    private readonly candles: CandleStoreService,
    private readonly trades: TradeStoreService,
    private readonly evidence: ListingEvidenceService,
    private readonly providers: ProviderService,
  ) {}

  async run(
    providerId: string,
    opts: { now: Date; trigger: 'schedule' | 'manual' | 'cli' | 'follow-up' },
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
      pairs: { due: 0, requests: 0, stored: 0, answered: 0, unsupported: 0, errors: 0 },
      trades: { minutesChecked: 0, verified: 0, failed: 0, requests: 0, outsideCandle: 0 },
      gaps: { retried: 0, recovered: 0 },
      evidence: { checked: 0, spotList: null, futuresList: null },
      reconciled: 0,
      timingAssigned: 0,
      rulesChanged: 0,
      pruned: 0,
      archivedDays: 0,
      fetchedNewData: false,
      failed: 0,
      notes: [],
    };
    const deadline = Date.now() + this.cfg.LBANK_OBSERVATION_MAX_MINUTES * 60_000;
    try {
      report.reconciled = await this.reconcile(providerId, now);
      report.rulesChanged = await this.upgradeRules(providerId, now);
      report.timingAssigned = await this.assignTiming(providerId, now);
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
      const snapshots = await this.mappingSnapshots(obs.map((o) => o.eventId));

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
        const inTime = Date.now() < deadline;
        if (inTime) await this.syncPair(pair, list, now, report);
        else if (!report.notes.some((n) => n.startsWith('time bound')))
          report.notes.push(
            `time bound of ${this.cfg.LBANK_OBSERVATION_MAX_MINUTES} min reached: the remaining pairs are fetched next run`,
          );
        await this.evaluatePair(pair, list, events, snapshots, now, report, inTime ? deadline : 0);
      }
      // Observations without a pair (mapping ambiguous / none) are evaluated on their own.
      const unpaired = obs.filter((o) => o.pairId === null);
      if (unpaired.length)
        await this.evaluatePair(null, unpaired, events, snapshots, now, report, 0);

      const pruned = await this.candles
        .prune(now, this.cfg.LBANK_CANDLE_RETENTION_DAYS)
        .catch((err: unknown) => {
          report.notes.push(`candle retention failed: ${redact(err).slice(0, 200)}`);
          return { deleted: 0, archivedDays: 0 };
        });
      report.pruned = pruned.deleted;
      report.archivedDays = pruned.archivedDays;
      report.fetchedNewData = report.pairs.stored > 0 || report.trades.minutesChecked > 0;
      report.status =
        report.failed || report.pairs.errors || report.trades.failed ? 'partial' : 'succeeded';
      report.notes.push(
        `${report.observations} observations: ${report.finalized} finalized; ${report.fetchedNewData ? 'new LBank data fetched' : 'no new LBank data: recomputed only'}; pairs due ${report.pairs.due}, ${report.pairs.requests} candle requests, ${report.pairs.stored} candles stored, ${report.pairs.unsupported} unsupported, ${report.pairs.errors} errors; ${report.trades.minutesChecked} minutes of trades checked (${report.trades.verified} verified, ${report.trades.failed} not, ${report.trades.requests} requests); gaps retried ${report.gaps.retried} (+${report.gaps.recovered} candles); ${report.archivedDays} days archived, ${report.pruned} old candles pruned`,
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
          ...newObservationValues(e, providerId, pairId, mapping, now),
          mappingEvidence: {
            ...mapping.evidence,
            reasons: mapping.reasons,
            decidedAt: now.toISOString(),
            reconciled: true,
          } as never,
        })
        .orIgnore()
        .updateEntity(false)
        .execute();
    }
    this.log.warn(`reconciled ${orphans.length} events that had no observation`);
    return orphans.length;
  }

  /**
   * Observations of older rules move to the current rules: the values they showed are written to
   * the append-only `lbank_obs_rules_change` first (the freeze trigger refuses the change without
   * it); a finalized one is reopened (its result rows stay). Recomputed below in the same run.
   */
  private async upgradeRules(providerId: string, now: Date): Promise<number> {
    const old = await this.db.getRepository(Observation).find({
      where: { providerId, rulesVersion: OBSERVATION_RULES_V1 },
    });
    for (const o of old)
      await this.db.transaction(async (m) => {
        await m
          .createQueryBuilder()
          .insert()
          .into(ObsRulesChange)
          .values({
            observationId: o.id,
            fromRulesVersion: o.rulesVersion,
            toRulesVersion: OBSERVATION_RULES_VERSION,
            fromStatus: o.status,
            fromResultVersion: o.resultVersion,
            fromFinalizedAt: o.finalizedAt,
            previous: v1Snapshot(o) as never,
            reason: RULES_V2_REASON,
            changedAt: now,
          })
          .orIgnore()
          .updateEntity(false)
          .execute();
        await m.getRepository(Observation).update(
          { id: o.id },
          {
            rulesVersion: OBSERVATION_RULES_VERSION,
            status: 'ACTIVE',
            reasons: [],
            finalizedAt: null,
            lastUpdateAt: now,
          },
        );
      });
    if (old.length)
      this.log.log(`moved ${old.length} observations to ${OBSERVATION_RULES_VERSION} (audited)`);
    return old.length;
  }

  /** Establish the start of every observation that has none, from the server's own records. */
  private async assignTiming(providerId: string, now: Date): Promise<number> {
    const rows: Array<{
      id: string;
      t0: Date;
      source_updated_at: Date;
      intake_at: Date | null;
      pipeline_run_id: string | null;
      scan_status: string | null;
      scan_started: Date | null;
      scan_finished: Date | null;
      scan_attempts: number | null;
      observe_status: string | null;
      observe_finished: Date | null;
      scan_run_finished: Date | null;
      scan_run_attempts: number | null;
      queue_status: string | null;
    }> = await this.db.query(
      `SELECT o.id, o.t0, e.source_updated_at, i.intake_at, i.pipeline_run_id,
              ps.status AS scan_status, ps.started_at AS scan_started, ps.finished_at AS scan_finished,
              ps.attempts AS scan_attempts, po.status AS observe_status, po.finished_at AS observe_finished,
              sr.finished_at AS scan_run_finished, sr.attempts AS scan_run_attempts, sr.queue_status
         FROM lbank_observation o
         JOIN lbank_obs_event e ON e.id = o.event_id
         LEFT JOIN lbank_obs_intake_run i ON i.id = e.intake_run_id
         LEFT JOIN pipeline_stage ps ON ps.run_id = i.pipeline_run_id AND ps.stage = 'scan'
         LEFT JOIN pipeline_stage po ON po.run_id = i.pipeline_run_id AND po.stage = 'observe'
         LEFT JOIN scan_run sr ON sr.batch_id = e.source_batch_id
        WHERE o.provider_id = $1 AND o.observation_start IS NULL AND o.finalized_at IS NULL`,
      [providerId],
    );
    let n = 0;
    for (const r of rows) {
      const timing = actionableTiming({
        crawlAt: r.t0,
        cmcQuoteAt: r.source_updated_at,
        pipelineRunId: r.pipeline_run_id,
        scanStage: r.scan_status
          ? {
              status: r.scan_status,
              startedAt: r.scan_started,
              finishedAt: r.scan_finished,
              attempts: r.scan_attempts ?? 1,
            }
          : null,
        scanRun: {
          finishedAt: r.scan_run_finished,
          attempts: r.scan_run_attempts ?? 1,
          queueStatus: r.queue_status,
        },
        intakeAt: r.intake_at,
        // The observe stage's finish is recorded after the intake transaction committed.
        eventCommittedAt:
          r.observe_status === 'succeeded' && r.observe_finished ? r.observe_finished : null,
        jobSeenAt: now,
      });
      if (!timing) continue;
      await this.db.getRepository(Observation).update(
        { id: r.id },
        {
          ...timingValues(timing, { backfilled: true }),
        },
      );
      n++;
    }
    return n;
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

  /** When CMC's LBank Spot list behind each event's mapping was fetched (review signal input). */
  private async mappingSnapshots(eventIds: string[]): Promise<Map<string, Date | null>> {
    if (!eventIds.length) return new Map();
    const rows: Array<{ id: string; finished_at: Date | null }> = await this.db.query(
      `SELECT e.id, vc.finished_at FROM lbank_obs_event e
         LEFT JOIN scan_run sr ON sr.batch_id = e.source_batch_id
         LEFT JOIN venue_crawl vc ON vc.id = sr.lbank_crawl_id
        WHERE e.id = ANY($1)`,
      [eventIds],
    );
    return new Map(rows.map((r) => [r.id, r.finished_at]));
  }

  private pairDue(pair: SpotPair, list: Observation[], now: Date): boolean {
    if (!pair.lastFetchAt) return true;
    // A start whose reference is still searched, or a window that ended without its last candles.
    if (list.some((o) => o.observationStart && o.referenceStatus === 'PENDING')) return true;
    const closedNow = now.getTime() - CLOSED_BAR_MARGIN_MS - MINUTE_MS;
    if (
      list.some(
        (o) =>
          o.observationEnd &&
          o.observationEnd.getTime() <= closedNow &&
          (o.dataThrough?.getTime() ?? 0) <
            Math.ceil(o.observationEnd.getTime() / MINUTE_MS) * MINUTE_MS,
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
    const windows = list
      .filter((o) => o.observationStart)
      .map((o) => observationWindow(o.observationStart!));
    if (!windows.length || !this.pairDue(pair, list, now)) return;
    report.pairs.due++;
    const synced = pair.syncedUntil?.getTime() ?? null;
    const needs = windows
      .map((w) => neededFromMs(w, synced))
      .filter((n): n is number => n !== null);
    if (needs.length) {
      const from = Math.min(...needs);
      const until = Math.min(
        Math.floor((now.getTime() - CLOSED_BAR_MARGIN_MS) / MINUTE_MS) * MINUTE_MS,
        Math.max(...windows.map((w) => w.endMinuteExclusiveMs)),
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
      report.pairs.answered += r.answered;
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
    // Known gaps (minutes answered without a candle) are asked for again, oldest first, two per
    // pair per run — the first minutes of a window like any other — until the retries are over.
    let retried = 0;
    for (const o of list)
      for (const g of o.gaps ?? []) {
        if (retried >= 2) break;
        if (g.state !== 'NO_BAR') continue;
        const f = Date.parse(g.from);
        const t = Date.parse(g.to);
        if (!(t <= (pair.syncedUntil?.getTime() ?? 0))) continue;
        retried++;
        report.gaps.retried++;
        const added = await this.candles.refetchGap(pair, f, t, now).catch(() => 0);
        report.gaps.recovered += added;
        report.pairs.stored += added;
      }
  }

  /**
   * Recompute every listed observation of one pair from its stored candles and checked minutes,
   * checking the trades of the minutes the rules ask for in rounds (a candidate whose candle High
   * was a carried OPEN leads to the next one) within the pair's per-run budget.
   */
  private async evaluatePair(
    pair: SpotPair | null,
    list: Observation[],
    events: Map<string, ObsEvent>,
    snapshots: Map<string, Date | null>,
    now: Date,
    report: ObsRunReport,
    deadline: number,
  ): Promise<void> {
    const windows = list
      .filter((o) => o.observationStart)
      .map((o) => observationWindow(o.observationStart!));
    let bars: Bar[] = [];
    let checks = new Map<number, MinuteCheck>();
    if (pair && windows.length) {
      const from = Math.min(...windows.map((w) => w.startMinuteMs)) - SPOT_LOOKBACK_MS;
      const to = Math.max(...windows.map((w) => w.endMinuteExclusiveMs));
      bars = await this.candles.loadBars(pair.id, from, to);
      checks = await this.trades.loadChecks(pair.id, from, to);
    }
    const barsByMinute = barMap(bars);
    const sync: PairSync = {
      syncedUntilMs: pair?.syncedUntil?.getTime() ?? null,
      unsupported: !!pair?.unsupportedSince,
      lastFetchFailed: pair?.lastFetchStatus === 'error',
      closedNowMs: Math.floor((now.getTime() - CLOSED_BAR_MARGIN_MS) / MINUTE_MS) * MINUTE_MS,
    };
    const evaluate = (o: Observation): Assessment | null => {
      const e = events.get(o.eventId);
      if (!e) return null;
      const ev = (o.eligibilityEvidence ?? {}) as {
        lbankSpotList?: { listed?: boolean | null };
        futures?: ListingDecision;
      };
      const snap = snapshots.get(o.eventId) ?? null;
      return assess({
        now,
        t0: o.t0,
        start: o.observationStart,
        cmcPrice: e.cmcPriceUsd,
        mapping: o.mappingStatus,
        mappingReasons: ((o.mappingEvidence as { reasons?: string[] }).reasons ?? []) as string[],
        bars,
        barsByMinute,
        checks,
        sync,
        unsupportedSince: pair?.unsupportedSince ?? null,
        spotListed: typeof ev.lbankSpotList?.listed === 'boolean' ? ev.lbankSpotList.listed : null,
        futures: ev.futures ?? { status: 'UNKNOWN', reasons: ['FUTURES_EVIDENCE_PENDING'] },
        fetchError: pair?.lastFetchStatus === 'error' ? pair.lastError : null,
        mappingSnapshotOld:
          !!snap &&
          o.t0.getTime() - snap.getTime() > this.cfg.LBANK_PAIRS_REFRESH_DAYS * 86_400_000,
      });
    };

    if (pair && deadline) {
      const attempted = new Set<number>();
      let budget = MAX_TRADE_MINUTES_PER_PAIR_PER_RUN;
      for (let round = 0; round < 16 && budget > 0 && Date.now() < deadline; round++) {
        const needs = new Set<number>();
        for (const o of list) {
          let a: Assessment | null;
          try {
            a = evaluate(o);
          } catch {
            continue; // reported in the final pass
          }
          for (const m of a?.needs ?? []) {
            const bar = barsByMinute.get(m);
            if (
              !attempted.has(m) &&
              bar?.volume.gt(0) &&
              m + MINUTE_MS <= sync.closedNowMs &&
              checks.get(m)?.status !== 'VERIFIED'
            )
              needs.add(m);
          }
        }
        if (!needs.size) break;
        for (const m of needs) {
          if (budget <= 0 || Date.now() >= deadline) break;
          budget--;
          attempted.add(m);
          checks.set(m, await this.checkMinute(pair, barsByMinute.get(m)!, now, report));
        }
      }
      if (budget <= 0)
        report.notes.push(`${pair.symbol}: trade-check budget used up; continued next run`);
    }

    for (const o of list) {
      if (!events.get(o.eventId)) continue;
      try {
        const a = evaluate(o)!;
        const flagsEvidence = pair
          ? await this.flagContext(pair, o, a, barsByMinute, checks, now, report)
          : a.flagsEvidence;
        await this.save(o, a, flagsEvidence, pair, snapshots.get(o.eventId) ?? null, now);
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

  /** One minute's trade check, counted on the run the same way wherever it is made. */
  private async checkMinute(
    pair: SpotPair,
    bar: Bar,
    now: Date,
    report: ObsRunReport,
  ): Promise<MinuteCheck> {
    const r = await this.trades.checkMinute(pair, bar, now);
    const t = report.trades;
    const at = `${pair.symbol} ${iso(bar.openMs)}`;
    t.minutesChecked++;
    t.requests += r.requests;
    t.outsideCandle += r.outsideCandle;
    if (r.check.status === 'VERIFIED') t.verified++;
    else if (++t.failed <= 3)
      report.notes.push(
        `${at}: trades ${r.check.status}${r.check.error ? ` (${r.check.error.slice(0, 120)})` : ''}`,
      );
    if (r.outsideCandle)
      report.notes.push(
        `${at}: ${r.outsideCandle} trades outside the candle range (candidate bound)`,
      );
    return r.check;
  }

  /**
   * Context for a single-trade extreme (the spike flag): the trades just before and after it, so a
   * reviewer can judge an isolated print. Fetched once per extreme trade and kept.
   */
  private async flagContext(
    pair: SpotPair,
    o: Observation,
    a: Assessment,
    bars: Map<number, Bar>,
    checks: Map<number, MinuteCheck>,
    now: Date,
    report: ObsRunReport,
  ): Promise<Record<string, unknown>> {
    const out = { ...a.flagsEvidence };
    const prior = (o.flagsEvidence ?? {}) as Record<string, { tradeId?: string } | undefined>;
    for (const [key, e] of [
      ['singleTradeHigh', a.highest],
      ['singleTradeLow', a.lowest],
    ] as const) {
      const ev = out[key] as Record<string, unknown> | undefined;
      if (!ev || !e?.best) continue;
      const kept = prior[key] as (Record<string, unknown> & { tradeId?: string }) | undefined;
      if (kept?.tradeId === e.best.id && 'nextTrade' in kept) {
        out[key] = { ...ev, previousTrade: kept.previousTrade, nextTrade: kept.nextTrade };
        continue;
      }
      // The previous trade: the last trade of the nearest earlier traded minute (checked).
      let previous: unknown = null;
      for (
        let m = e.bestMinuteMs! - MINUTE_MS;
        m >= e.bestMinuteMs! - SPOT_LOOKBACK_MS * 24;
        m -= MINUTE_MS
      ) {
        const bar = bars.get(m);
        if (!bar) {
          previous = { unknown: `no stored candle at ${iso(m)}` };
          break;
        }
        if (!bar.volume.gt(0)) continue;
        let c = checks.get(m);
        if (!c || c.status !== 'VERIFIED') {
          c = await this.checkMinute(pair, bar, now, report);
          checks.set(m, c);
        }
        previous = c.status === 'VERIFIED' ? tradeJson(c.trades.at(-1)) : { unknown: c.status };
        break;
      }
      const next = await this.trades.nextTrade(pair, e.best.timeMs);
      report.trades.requests++;
      out[key] = {
        ...ev,
        previousTrade: previous,
        nextTrade:
          next && 'error' in next
            ? { unknown: next.error }
            : next
              ? {
                  id: next.id,
                  time: iso(next.timeMs),
                  price: next.price.toFixed(),
                  qty: next.qty.toFixed(),
                }
              : null,
      };
    }
    return out;
  }

  private async save(
    o: Observation,
    a: Assessment,
    flagsEvidence: Record<string, unknown>,
    pair: SpotPair | null,
    mappingSnapshotAt: Date | null,
    now: Date,
  ): Promise<void> {
    const ref = a.reference?.status === 'VERIFIED' ? a.reference : null;
    const hi = a.highest?.best ?? null;
    const lo = a.lowest?.best ?? null;
    const lbh = a.lowBeforeHigh?.best ?? null;
    const terminal = a.status.terminal;
    const gaps: Array<{ from: string; to: string; state: string; detail?: string }> = [
      ...(a.cov?.gaps ?? []).map((g) => ({ from: iso(g.fromMs), to: iso(g.toMs), state: g.state })),
      ...[a.highest, a.lowest, a.lowBeforeHigh]
        .flatMap((e) => e?.blocking ?? [])
        .filter((b) => b.kind === 'check')
        .map((b) => ({
          from: iso(b.fromMs),
          to: iso(b.toMs),
          state: 'TRADES_UNVERIFIED',
          detail: b.state === 'CHECK_PENDING' ? 'NOT_CHECKED_YET' : b.state,
        })),
      ...(a.reference?.status === 'PENDING' && a.reference.why !== 'FUTURE'
        ? [
            {
              from: iso(a.reference.minuteMs),
              to: iso(a.reference.minuteMs + MINUTE_MS),
              state:
                a.reference.why === 'CHECK_PENDING' ||
                a.reference.why === 'TRADES_BELOW_CANDLE' ||
                a.reference.why === 'PAGING_INCOMPLETE'
                  ? 'TRADES_UNVERIFIED'
                  : a.reference.why,
              detail: `reference search: ${a.reference.why}`,
            },
          ]
        : []),
    ];
    const uniqueGaps = [
      ...new Map(gaps.map((g) => [`${g.from}|${g.state}|${g.detail ?? ''}`, g])).values(),
    ];
    const referenceStatus: ReferenceStatus =
      a.reference?.status === 'VERIFIED'
        ? 'VERIFIED'
        : a.reference?.status === 'NO_TRADE'
          ? 'NO_TRADE'
          : terminal && a.w
            ? 'UNVERIFIED'
            : 'PENDING';
    const fields = {
      spotStatus: a.spot.status,
      spotTrading: a.spot.trading,
      futuresStatus: a.futures.status,
      eligibility: a.eligibility,
      eligibilityEvidence: {
        ...(o.eligibilityEvidence ?? {}),
        spot: { status: a.spot.status, trading: a.spot.trading, reasons: a.spot.reasons },
      } as never,
      referenceStatus,
      referenceTradeId: ref?.trade.id ?? null,
      referenceAt: ref ? new Date(ref.trade.timeMs) : null,
      referencePrice: store(ref?.trade.price) as never,
      referenceQty: store(ref?.trade.qty) as never,
      referenceDelayMs: ref ? ref.delayMs : null,
      referenceDelayed: ref ? ref.delayed : null,
      referenceEvidence: (ref
        ? {
            trade: tradeJson(ref.trade),
            minute: iso(ref.minuteMs),
            silentMinutes: ref.silentMinutes,
            sameMs: ref.sameMs.map(tradeJson),
            rule: 'the first LBank Spot trade with time >= observation_start (and < its end), from a minute whose complete trade list was checked against its candle; every minute before it was a zero-volume candle or a checked minute without an in-window trade',
          }
        : a.reference?.status === 'PENDING'
          ? { pending: { minute: iso(a.reference.minuteMs), why: a.reference.why } }
          : a.reference?.status === 'NO_TRADE'
            ? { noTrade: 'every minute of the window verified without a trade' }
            : {}) as never,
      highestPrice: store(hi?.price) as never,
      highestAt: hi ? new Date(hi.timeMs) : null,
      highestTradeId: hi?.id ?? null,
      highestReturnPct: forStorage(a.highestPct) as never,
      lowestPrice: store(lo?.price) as never,
      lowestAt: lo ? new Date(lo.timeMs) : null,
      lowestTradeId: lo?.id ?? null,
      lowestReturnPct: forStorage(a.lowestPct) as never,
      lowBeforeHighestPrice: store(lbh?.price) as never,
      lowBeforeHighestAt: lbh ? new Date(lbh.timeMs) : null,
      lowBeforeHighestTradeId: lbh?.id ?? null,
      extremesOrder: a.order,
      extremesProven: !!a.highest?.proven && !!a.lowest?.proven && !!a.lowBeforeHigh?.proven,
      extremesEvidence: {
        highest: extremeJson(a.highest),
        lowest: extremeJson(a.lowest),
        lowBeforeHighest: extremeJson(a.lowBeforeHigh),
      } as never,
      flags: a.flags,
      flagsEvidence: {
        ...flagsEvidence,
        mappingSnapshot: {
          cmcLbankSpotListFetchedAt: mappingSnapshotAt?.toISOString() ?? null,
          ageAtSignalHours: mappingSnapshotAt
            ? Math.round((o.t0.getTime() - mappingSnapshotAt.getTime()) / 3_600_000)
            : null,
          refreshDays: this.cfg.LBANK_PAIRS_REFRESH_DAYS,
        },
      } as never,
      minutesExpected: a.cov?.minutesExpected ?? (a.w ? a.w.minutes : null),
      minutesPresent: a.cov?.minutesPresent ?? 0,
      minutesTraded: a.cov?.minutesTraded ?? 0,
      minutesMissing: a.cov?.minutesMissing ?? 0,
      gaps: uniqueGaps as never,
      dataThrough: a.cov ? new Date(a.cov.dataThroughMs) : null,
      lastSourceFetchAt: pair ? latest(pair.lastSuccessAt, pair.tradesLastSuccessAt) : null,
      lastFetchAttemptAt: pair ? latest(pair.lastFetchAt, pair.tradesLastAttemptAt) : null,
      lastFetchError: pair
        ? pair.lastFetchStatus === 'error' || pair.lastFetchStatus === 'unsupported'
          ? pair.lastError
          : pair.tradesLastError
        : null,
      retryUntil: a.w ? new Date(a.w.endMs + FINALIZE_RETRY_MS) : null,
      status: a.status.status,
      reasons: a.status.reasons,
      lastUpdateAt: now,
      lastAttemptAt: now,
      lastError: null,
    };
    if (!terminal) {
      await this.db.getRepository(Observation).update({ id: o.id }, fields);
      o.gaps = uniqueGaps;
      o.referenceStatus = referenceStatus;
      o.dataThrough = fields.dataThrough;
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
        entryAt: null,
        entryPrice: null,
        entryDelayMs: null,
        highPrice: null,
        highBarAt: null,
        lowPrice: null,
        lowBarAt: null,
        maxRisePct: null,
        maxDropPct: null,
        lowBeforeHighPrice: null,
        lowBeforeHighBarAt: null,
        extremeOrder: null,
        expectedBars: null,
        coveredBars: null,
        tradedBars: null,
        missingBars: null,
        missingRanges: null,
        seriesSha256: null,
        computedAt: now,
        actionableAt: o.actionableAt,
        actionableSource: o.actionableSource,
        observationStart: o.observationStart,
        observationEnd: o.observationEnd,
        referenceStatus,
        referenceTradeId: fields.referenceTradeId,
        referenceAt: fields.referenceAt,
        referencePrice: fields.referencePrice,
        referenceDelayMs: fields.referenceDelayMs,
        highestPrice: fields.highestPrice,
        highestAt: fields.highestAt,
        highestTradeId: fields.highestTradeId,
        highestReturnPct: fields.highestReturnPct,
        lowestPrice: fields.lowestPrice,
        lowestAt: fields.lowestAt,
        lowestTradeId: fields.lowestTradeId,
        lowestReturnPct: fields.lowestReturnPct,
        lowBeforeHighestPrice: fields.lowBeforeHighestPrice,
        lowBeforeHighestAt: fields.lowBeforeHighestAt,
        extremesOrder: fields.extremesOrder,
        flags: fields.flags,
        gaps: uniqueGaps as never,
        minutesExpected: fields.minutesExpected,
        minutesPresent: fields.minutesPresent,
        minutesTraded: fields.minutesTraded,
        minutesMissing: fields.minutesMissing,
        evidenceSha256: a.evidenceSha256,
        detail: {
          referenceEvidence: fields.referenceEvidence,
          extremesEvidence: fields.extremesEvidence,
          flagsEvidence: fields.flagsEvidence,
          actionableEvidence: o.actionableEvidence,
          dataThrough: fields.dataThrough?.toISOString() ?? null,
        } as never,
      });
      await m.getRepository(Observation).update(
        { id: o.id },
        {
          ...fields,
          evidenceSha256: a.evidenceSha256,
          resultVersion: version,
          finalizedAt: now,
        },
      );
    });
  }
}

/** The values a rules-v1 row showed (written to the audit row before it moves to new rules). */
function v1Snapshot(o: Observation): Record<string, unknown> {
  const d = (v: DValue | null) => (v === null ? null : v.toFixed());
  const t = (v: Date | null) => (v ? v.toISOString() : null);
  return {
    rulesVersion: o.rulesVersion,
    status: o.status,
    reasons: o.reasons,
    eligibility: o.eligibility,
    spotStatus: o.spotStatus,
    futuresStatus: o.futuresStatus,
    t0: t(o.t0),
    windowEnd: t(o.windowEnd),
    entry: {
      at: t(o.entryAt),
      price: d(o.entryPrice),
      delayMs: o.entryDelayMs,
      lastTradeBarAt: t(o.entryLastTradeAt),
      stale: o.entryStale,
      rule: 'OPEN of the first 1-minute bar opening at or after the crawl time (the previous CLOSE)',
    },
    high: { price: d(o.highPrice), barAt: t(o.highBarAt) },
    low: { price: d(o.lowPrice), barAt: t(o.lowBarAt) },
    maxRisePct: d(o.maxRisePct),
    maxDropPct: d(o.maxDropPct),
    lowBeforeHigh: { price: d(o.lowBeforeHighPrice), barAt: t(o.lowBeforeHighBarAt) },
    extremeOrder: o.extremeOrder,
    coverage: {
      expectedBars: o.expectedBars,
      coveredBars: o.coveredBars,
      tradedBars: o.tradedBars,
      missingBars: o.missingBars,
      missingRanges: o.missingRanges,
      observedThrough: t(o.observedThrough),
      startUnobservedMs: o.startUnobservedMs,
      boundaryUnobservedMs: o.boundaryUnobservedMs,
    },
    seriesSha256: o.seriesSha256,
    resultVersion: o.resultVersion,
    finalizedAt: t(o.finalizedAt),
    lastUpdateAt: t(o.lastUpdateAt),
  };
}
