import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, type EntityManager, In, MoreThanOrEqual, Not } from 'typeorm';

import { safeBigintToNumber } from '../../common/entities/bigint.js';
import { redact } from '../../common/security/redact.js';
import { DAY_MS, addDays, eachDay, isoDate } from '../../common/utils/dates.js';
import { dec, forStorage, sha256 } from '../../common/utils/decimal.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import {
  DailyMetricsService,
  type DailyRefreshReport,
} from '../daily-metrics/daily-metrics.service.js';
import { CmcAsset } from '../ingestion/entities/cmc-asset.entity.js';

import { ForwardEvent } from './entities/forward-event.entity.js';
import { ForwardHigh } from './entities/forward-high.entity.js';
import { ForwardOutcome } from './entities/forward-outcome.entity.js';
import { ForwardUpdateRun } from './entities/forward-update-run.entity.js';
import {
  type EventWindow,
  type ForwardOutcome as Outcome,
  type OutcomeHigh,
  classifyHigh,
  dayComplete,
  evaluateOutcome,
} from './forward-rules.js';
import {
  FETCH_MAX_MINUTES,
  FORWARD_EVENT_STATUSES,
  FORWARD_REASON,
  FORWARD_RULES_VERSION,
  type ForwardEventStatus,
  type ForwardUpdateStatus,
  MISSING_DATA_RETRY_DAYS,
} from './forward.constants.js';

export interface UpdateReport {
  updateRunId: string;
  status: ForwardUpdateStatus;
  updateDate: string;
  trigger: string;
  events: number;
  byStatus: Record<ForwardEventStatus, number>;
  newlyFinal: number;
  highs: { inserted: number; superseded: number; unchanged: number };
  outcomes: { versions: number; unchanged: number };
  coverage: {
    completedDays: number;
    coveredDays: number;
    missingDays: number;
    invalidDays: number;
    day0Unresolved: number;
  };
  /** Targeted daily-row fetch for tracked assets the daily stage does not cover. */
  fetch: DailyRefreshReport | null;
  failedEvents: number;
  notes: string[];
}

/** The current High row of one included date, with the source revision it came from. */
interface CurrentHigh extends OutcomeHigh {
  sourceRevisionId: number;
}

/** One effective daily row of a tracked asset with the revision fields the forward test reads. */
interface DailyHighRow {
  date_utc: string;
  revision_id: string;
  revision: number;
  high_usd: string | null;
  time_high: Date | null;
  period_start: Date | null;
  period_end: Date | null;
  invalid_reasons: string[];
  source: string;
  retrieved_at: Date;
}

const STATUS_ZERO = () =>
  Object.fromEntries(FORWARD_EVENT_STATUSES.map((s) => [s, 0])) as Record<
    ForwardEventStatus,
    number
  >;

/** The stored window of an event (fixed at detection). */
export function storedWindow(e: ForwardEvent): EventWindow {
  return {
    detectedAt: e.detectedAt,
    detectedUtcDate: e.detectedUtcDate,
    deadline168h: e.deadline168h,
    evaluationEnd: e.evaluationEnd,
    effectiveHorizonHours: e.effectiveHorizonHours,
    dates: eachDay(e.detectedUtcDate, isoDate(e.evaluationEnd)),
  };
}

/**
 * The daily High update (PDF p.5–7, p.10). Once per closed UTC day — retried while Highs are
 * missing — every event that is not FINAL (and FINAL events still inside the revision window)
 * gets its eligible High observations upserted from the crawler's stored daily rows and its
 * outcome recomputed; a changed outcome becomes the next version. Tracked assets that the daily
 * stage does not refresh (no longer screen candidates) get the same daily-history request, the
 * smallest capture the forward test needs. Safe to rerun: no duplicate rows, no new event.
 */
@Injectable()
export class ForwardUpdateService {
  private readonly log = new Logger(ForwardUpdateService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly daily: DailyMetricsService,
  ) {}

  /** Due after each UTC day closes, after a failed run, and to retry missing Highs. */
  async due(providerId: string, now: Date): Promise<{ due: boolean; reason: string }> {
    const updateDate = addDays(isoDate(now), -1);
    const last = await this.db.getRepository(ForwardUpdateRun).findOne({
      where: { providerId, status: Not('running') },
      order: { startedAt: 'DESC' },
    });
    if (!last) return { due: true, reason: 'first daily update' };
    if (last.updateDate < updateDate) return { due: true, reason: `UTC day ${updateDate} closed` };
    if (last.status === 'failed') return { due: true, reason: 'the previous update failed' };
    // Measured from the attempt's start: the same clock as `now` (finished_at is wall time).
    const retryAt = last.startedAt.getTime() + this.retryMs;
    if (last.status === 'partial' && now.getTime() >= retryAt)
      return { due: true, reason: 'retry: some included Highs were missing' };
    return {
      due: false,
      reason:
        last.status === 'partial'
          ? `missing Highs are retried after ${new Date(retryAt).toISOString()}`
          : `already updated for ${updateDate}`,
    };
  }

  private get retryMs() {
    return this.cfg.TIER1_DAILY_RETRY_HOURS * 3_600_000;
  }

  async update(
    providerId: string,
    opts: {
      now: Date;
      trigger: 'schedule' | 'manual';
      pipelineRunId?: string | null;
      fetch?: boolean;
    },
  ): Promise<UpdateReport> {
    const { now } = opts;
    const runs = this.db.getRepository(ForwardUpdateRun);
    // Updates run under the pipeline lease: a run still marked running was interrupted.
    await runs.update(
      { providerId, status: 'running' },
      { status: 'failed', finishedAt: now, error: 'interrupted before it finished' },
    );
    const run = await runs.save(
      runs.create({
        providerId,
        pipelineRunId: opts.pipelineRunId ?? null,
        trigger: opts.trigger,
        updateDate: addDays(isoDate(now), -1),
        startedAt: now,
        status: 'running',
        notes: [],
      }),
    );
    const report: UpdateReport = {
      updateRunId: run.id,
      status: 'running',
      updateDate: run.updateDate,
      trigger: opts.trigger,
      events: 0,
      byStatus: STATUS_ZERO(),
      newlyFinal: 0,
      highs: { inserted: 0, superseded: 0, unchanged: 0 },
      outcomes: { versions: 0, unchanged: 0 },
      coverage: {
        completedDays: 0,
        coveredDays: 0,
        missingDays: 0,
        invalidDays: 0,
        day0Unresolved: 0,
      },
      fetch: null,
      failedEvents: 0,
      notes: [],
    };
    try {
      const revisionFloor = new Date(now.getTime() - this.cfg.TIER1_DAILY_LOOKBACK_DAYS * DAY_MS);
      const events = await this.db.getRepository(ForwardEvent).find({
        where: [
          { providerId, status: Not('FINAL') },
          // FINAL events stay open to late source revisions while their days can still be revised.
          { providerId, status: 'FINAL', evaluationEnd: MoreThanOrEqual(revisionFloor) },
        ],
        order: { detectedAt: 'ASC' },
      });
      if (opts.fetch !== false) report.fetch = await this.fetchMissing(providerId, events, now);
      if (report.fetch?.stoppedBy)
        report.notes.push(
          `daily rows: fetch stopped (${report.fetch.stoppedBy.replace(/_/g, ' ')}); outcomes keep their previous data`,
        );
      const assets = new Map(
        events.length
          ? (
              await this.db.getRepository(CmcAsset).find({
                where: { providerId, cmcId: In([...new Set(events.map((e) => e.cmcId))]) },
                select: {
                  providerId: true,
                  cmcId: true,
                  platformChain: true,
                  platformAddress: true,
                },
              })
            ).map((a) => [a.cmcId, a])
          : [],
      );
      const waiting: string[] = [];
      for (const e of events) {
        try {
          const r = await this.db.transaction((m) =>
            this.evaluateEvent(m, e, now, run.id, assets.get(e.cmcId) ?? null),
          );
          report.events++;
          report.byStatus[r.outcome.status]++;
          if (r.outcome.status === 'FINAL' && e.status !== 'FINAL') report.newlyFinal++;
          report.highs.inserted += r.inserted;
          report.highs.superseded += r.superseded;
          report.highs.unchanged += r.unchanged;
          if (r.versioned) report.outcomes.versions++;
          else report.outcomes.unchanged++;
          const o = r.outcome;
          report.coverage.completedDays += o.completedDays;
          report.coverage.coveredDays += o.coveredDays;
          report.coverage.missingDays += o.missingDates.length;
          report.coverage.invalidDays += o.invalidDates.length;
          if (o.day0 === 'UNRESOLVED') report.coverage.day0Unresolved++;
          // Missing days can still arrive (late publication); unproven day-0 Highs cannot.
          if (
            o.missingDates.length &&
            e.evaluationEnd.getTime() >= now.getTime() - MISSING_DATA_RETRY_DAYS * DAY_MS
          )
            waiting.push(
              `${e.symbol} (CMC ${e.cmcId}, ${e.starCount}★ ${e.detectedUtcDate}) lacks ${o.missingDates.join(', ')}`,
            );
        } catch (err) {
          report.failedEvents++;
          if (report.failedEvents <= 5)
            report.notes.push(`event ${e.id}: ${redact(err).slice(0, 200)}`);
        }
      }
      report.status =
        report.failedEvents || waiting.length || report.fetch?.stoppedBy ? 'partial' : 'succeeded';
      if (waiting.length)
        report.notes.unshift(
          `${waiting.length} events lack a High for a completed day, retried after ${this.cfg.TIER1_DAILY_RETRY_HOURS} h: ${waiting.slice(0, 3).join('; ')}${waiting.length > 3 ? '; …' : ''}`,
        );
      report.notes.push(
        `${report.events} events updated: ${report.outcomes.versions} new outcome versions, ${report.newlyFinal} newly FINAL; Highs ${report.highs.inserted} new, ${report.highs.superseded} superseded by a source revision`,
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
      this.log.log(`forward update ${report.updateDate}: ${report.status}; ${report.notes.at(-1)}`);
      return report;
    } catch (err) {
      await runs.update(
        { id: run.id },
        { status: 'failed', finishedAt: new Date(), error: redact(err).slice(0, 2000) },
      );
      throw err;
    }
  }

  /**
   * Daily rows for tracked assets that lack an included completed day, within reach of the
   * source's look-back. Screen candidates already have their rows from the daily stage, so in
   * practice this asks only for assets that left the screen while one of their events is open.
   */
  private async fetchMissing(
    providerId: string,
    events: ForwardEvent[],
    now: Date,
  ): Promise<DailyRefreshReport | null> {
    const today = isoDate(now);
    const reach = addDays(today, -this.cfg.TIER1_DAILY_LOOKBACK_DAYS);
    const needed = new Map<number, { slug: string | null; dates: Set<string>; end: number }>();
    for (const e of events) {
      if (e.status === 'FINAL') continue;
      if (e.evaluationEnd.getTime() < now.getTime() - MISSING_DATA_RETRY_DAYS * DAY_MS) continue;
      const dates = storedWindow(e).dates.filter((d) => d >= reach && dayComplete(d, now));
      if (!dates.length) continue;
      const n = needed.get(e.cmcId) ?? { slug: e.slug, dates: new Set(), end: Infinity };
      for (const d of dates) n.dates.add(d);
      n.end = Math.min(n.end, e.evaluationEnd.getTime());
      needed.set(e.cmcId, n);
    }
    if (!needed.size) return null;
    const have = new Set(
      (
        (await this.db.query(
          `SELECT cmc_id AS "cmcId", date_utc::text AS "dateUtc" FROM daily_metric
            WHERE provider_id = $1 AND cmc_id = ANY($2::int[]) AND date_utc >= $3::date AND date_utc < $4::date`,
          [providerId, [...needed.keys()], reach, today],
        )) as Array<{ cmcId: number; dateUtc: string }>
      ).map((r) => `${r.cmcId}|${r.dateUtc}`),
    );
    const candidates = [...needed.entries()]
      .filter(([cmcId, n]) => [...n.dates].some((d) => !have.has(`${cmcId}|${d}`)))
      .sort((a, b) => a[1].end - b[1].end || a[0] - b[0])
      .map(([cmcId, n]) => ({ cmcId, slug: n.slug }));
    if (!candidates.length) return null;
    return this.daily.refresh(providerId, { id: null, crawledAt: now }, candidates, undefined, {
      maxMinutes: FETCH_MAX_MINUTES,
    });
  }

  /** Upsert one event's High observations, recompute its outcome and version it when it changed. */
  private async evaluateEvent(
    m: EntityManager,
    e: ForwardEvent,
    now: Date,
    updateRunId: string,
    asset: Pick<CmcAsset, 'platformChain' | 'platformAddress'> | null,
  ): Promise<{
    outcome: Outcome;
    inserted: number;
    superseded: number;
    unchanged: number;
    versioned: boolean;
  }> {
    const w = storedWindow(e);
    const completed = w.dates.filter((d) => dayComplete(d, now));
    const rows = completed.length
      ? ((await m.query(
          `SELECT dm.date_utc::text AS date_utc, r.id::text AS revision_id, r.revision, r.high_usd::text AS high_usd,
                  r.time_high, r.period_start, r.period_end, r.invalid_reasons, r.source, r.retrieved_at
             FROM daily_metric dm JOIN daily_metric_revision r ON r.id = dm.revision_id
            WHERE dm.provider_id = $1 AND dm.cmc_id = $2 AND dm.date_utc = ANY($3::date[])`,
          [e.providerId, e.cmcId, completed],
        )) as DailyHighRow[])
      : [];
    const highs = m.getRepository(ForwardHigh);
    const current = new Map<string, CurrentHigh>(
      (await highs.findBy({ eventId: e.id, isCurrent: true })).map((h) => [
        h.dateUtc,
        {
          id: h.id,
          dateUtc: h.dateUtc,
          periodStart: h.periodStart,
          periodEnd: h.periodEnd,
          high: dec(h.highUsd),
          timeHigh: h.timeHigh,
          eligibility: h.eligibility,
          reason: h.reason,
          sourceRevisionId: h.sourceRevisionId,
        },
      ]),
    );
    let inserted = 0,
      superseded = 0,
      unchanged = 0;
    for (const row of rows) {
      const c = classifyHigh(w, {
        dateUtc: row.date_utc,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        high: dec(row.high_usd),
        timeHigh: row.time_high,
        invalidReasons: row.invalid_reasons,
      });
      const revisionId = safeBigintToNumber(row.revision_id);
      const cur = current.get(row.date_utc);
      if (
        cur &&
        cur.sourceRevisionId === revisionId &&
        cur.eligibility === c.eligibility &&
        cur.reason === c.reason
      ) {
        unchanged++;
        continue;
      }
      if (cur) {
        await highs.update({ id: cur.id! }, { isCurrent: false, supersededAt: now });
        superseded++;
      }
      const saved = (await m.query(
        `INSERT INTO forward_high (event_id, date_utc, period_start, period_end, source, source_revision_id, revision,
                                   high_usd, time_high, quote_currency, observed_at, eligibility, reason, is_current, update_run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'USD', $10, $11, $12, true, $13)
         ON CONFLICT ON CONSTRAINT ux_forward_high_observation DO UPDATE
           SET is_current = true, superseded_at = NULL, eligibility = EXCLUDED.eligibility,
               reason = EXCLUDED.reason, time_high = EXCLUDED.time_high
         RETURNING id`,
        [
          e.id,
          row.date_utc,
          c.periodStart,
          c.periodEnd,
          row.source,
          revisionId,
          row.revision,
          row.high_usd,
          c.timeHigh,
          row.retrieved_at,
          c.eligibility,
          c.reason,
          updateRunId,
        ],
      )) as Array<{ id: string }>;
      current.set(row.date_utc, {
        ...c,
        id: safeBigintToNumber(saved[0]!.id),
        sourceRevisionId: revisionId,
      });
      inserted++;
    }

    const used = [...current.values()];
    const outcome = evaluateOutcome({ window: w, price: e.snapshotPriceUsd, highs: used, now });
    // Followed by CMC id; a changed contract / network is flagged for a human, never auto-resolved.
    const lower = (s: string | null) => s?.toLowerCase() ?? null;
    const contractChanged =
      asset !== null &&
      ((asset.platformChain ?? null) !== (e.platformChain ?? null) ||
        lower(asset.platformAddress) !== lower(e.platformAddress));
    const identity = contractChanged ? [FORWARD_REASON.contractEvidenceChanged] : [];
    const highIds = used
      .map((h) => h.id!)
      .filter((x) => Number.isSafeInteger(x))
      .sort((a, b) => a - b);
    const comparable = {
      status: outcome.status,
      coverage: outcome.coverageStatus,
      kind: outcome.peakKind,
      peak: outcome.peakHigh?.toFixed() ?? null,
      peakHighId: outcome.peakHighId,
      peakAt: outcome.peakAt?.toISOString() ?? null,
      precision: outcome.peakTimePrecision,
      ret: forStorage(outcome.peakReturnPct),
      ext: outcome.extensionPeakFlag,
      day0: outcome.day0,
      days: [outcome.completedDays, outcome.coveredDays],
      missing: outcome.missingDates,
      invalid: outcome.invalidDates,
      reasons: outcome.reasons,
      highIds,
      rules: FORWARD_RULES_VERSION,
    };
    const contentHash = sha256(JSON.stringify(comparable));
    const outcomes = m.getRepository(ForwardOutcome);
    const latest = await outcomes.findOne({
      where: { eventId: e.id },
      order: { resultVersion: 'DESC' },
      select: { id: true, resultVersion: true, contentHash: true, finalizedAt: true },
    });
    let versioned = false;
    let resultVersion = latest?.resultVersion ?? 0;
    let finalizedAt = e.finalizedAt;
    if (completed.length && (!latest || latest.contentHash !== contentHash)) {
      resultVersion++;
      versioned = true;
      finalizedAt = outcome.status === 'FINAL' ? now : null;
      await outcomes.insert({
        eventId: e.id,
        resultVersion,
        revisionReason: !latest ? 'first' : superseded ? 'source_revision' : 'daily_update',
        rulesVersion: FORWARD_RULES_VERSION,
        status: outcome.status,
        coverageStatus: outcome.coverageStatus,
        peakKind: outcome.peakKind,
        peakHighUsd: (outcome.peakHigh?.toFixed() ?? null) as never,
        peakHighId: outcome.peakHighId,
        peakDate: outcome.peakDate,
        peakAt: outcome.peakAt,
        peakTimePrecision: outcome.peakTimePrecision,
        peakPeriodStart: outcome.peakPeriodStart,
        peakPeriodEnd: outcome.peakPeriodEnd,
        peakReturnPct: forStorage(outcome.peakReturnPct) as never,
        extensionPeakFlag: outcome.extensionPeakFlag,
        effectiveHorizonHours: forStorage(w.effectiveHorizonHours) as never,
        day0State: outcome.day0,
        expectedDays: outcome.expectedDays,
        completedDays: outcome.completedDays,
        coveredDays: outcome.coveredDays,
        missingDates: outcome.missingDates,
        invalidDates: outcome.invalidDates,
        reasons: outcome.reasons,
        highIds: highIds as never,
        contentHash,
        finalizedAt: outcome.status === 'FINAL' ? now : null,
        computedAt: now,
        updateRunId,
      });
    }
    await m.getRepository(ForwardEvent).update(
      { id: e.id },
      {
        status: outcome.status,
        qualityFlags: [...outcome.reasons, ...identity],
        resultVersion,
        lastUpdateAt: completed.length ? now : e.lastUpdateAt,
        finalizedAt: outcome.status === 'FINAL' ? finalizedAt : null,
      },
    );
    return { outcome, inserted, superseded, unchanged, versioned };
  }
}
