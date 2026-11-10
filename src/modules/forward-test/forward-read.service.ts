import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, type DataSource, In, MoreThanOrEqual } from 'typeorm';

import { DAY_MS } from '../../common/utils/dates.js';
import { D, type DValue, forStorage } from '../../common/utils/decimal.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { CrawlBatch } from '../ingestion/entities/crawl-batch.entity.js';
import { Provider } from '../sources/entities/provider.entity.js';

import { type CohortGroup, type Stats, cohortReport, overlapMap } from './cohort.js';
import { ForwardEvent } from './entities/forward-event.entity.js';
import { ForwardHigh } from './entities/forward-high.entity.js';
import { ForwardOutcome } from './entities/forward-outcome.entity.js';
import { ForwardTestWatchlist } from './entities/forward-test-watchlist.entity.js';
import { ForwardTriggerRejection } from './entities/forward-trigger-rejection.entity.js';
import { ForwardTriggerRun } from './entities/forward-trigger-run.entity.js';
import { ForwardUpdateRun } from './entities/forward-update-run.entity.js';
import {
  ACTIVE_EVENT_STATUSES,
  FORWARD_EVENT_STATUSES,
  FORWARD_REASON,
  FORWARD_RULES_VERSION,
  type ForwardEventStatus,
  HORIZON_HOURS,
} from './forward.constants.js';

export type EventView = 'active' | 'final' | 'incomplete' | 'all';

export const VIEW_STATUSES: Record<EventView, readonly ForwardEventStatus[]> = {
  active: ACTIVE_EVENT_STATUSES,
  final: ['FINAL'],
  incomplete: ['INCOMPLETE'],
  all: FORWARD_EVENT_STATUSES,
};

export const FORWARD_NOTICE =
  'Observed maximum future High from the CMC detection price: a hypothetical upside, not an executable trade, not a close-to-close return and not realized P/L (no fees, spread or slippage). No pump threshold is defined; read the actual percentages.';

/** Exact decimal text (30 dp at most, as stored), never a float. */
const s = (v: DValue | null | undefined) => (v === null || v === undefined ? null : forStorage(v));
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export interface ForwardEventRow {
  eventId: string;
  cmcId: number;
  symbol: string;
  name: string;
  slug: string | null;
  isLive: boolean;
  detectedAt: string;
  detectedUtcDate: string;
  detectionHourUtc: number;
  starCount: number;
  referencePriceUsd: string;
  sourceUpdatedAt: string;
  sourceBatchId: string;
  rank: number | null;
  pass3d: string;
  pass7d: string;
  pass30d: string;
  multiple3d: string | null;
  multiple7d: string | null;
  multiple30d: string | null;
  /** Detection-time ranking (weighted star ranking): pattern, points, completeness, strength. */
  passPattern: string;
  weightedPassPoints: number | null;
  scoreComplete: boolean | null;
  weightedStrength: string | null;
  rankingRulesetVersion: string | null;
  currentVmc: string | null;
  lbankPairs: string[];
  rulesetVersion: string;
  deadline168h: string;
  evaluationEnd: string;
  effectiveHorizonHours: string;
  status: ForwardEventStatus;
  qualityFlags: string[];
  resultVersion: number;
  lastUpdateAt: string | null;
  finalizedAt: string | null;
  outcome: {
    resultVersion: number;
    revisionReason: string;
    rulesVersion: string;
    coverageStatus: string;
    peakKind: string;
    peakHighUsd: string | null;
    peakAt: string | null;
    peakDate: string | null;
    peakTimePrecision: string | null;
    peakPeriodStart: string | null;
    peakPeriodEnd: string | null;
    peakReturnPct: string | null;
    extensionPeakFlag: string | null;
    day0State: string;
    expectedDays: number;
    completedDays: number;
    coveredDays: number;
    missingDates: string[];
    invalidDates: string[];
    reasons: string[];
    computedAt: string;
    finalizedAt: string | null;
  } | null;
  assetEventCount: number;
  overlappingEventIds: string[];
}

function outcomeJson(o: ForwardOutcome): NonNullable<ForwardEventRow['outcome']> {
  return {
    resultVersion: o.resultVersion,
    revisionReason: o.revisionReason,
    rulesVersion: o.rulesVersion,
    coverageStatus: o.coverageStatus,
    peakKind: o.peakKind,
    peakHighUsd: o.peakHighUsd?.toFixed() ?? null,
    peakAt: iso(o.peakAt),
    peakDate: o.peakDate,
    peakTimePrecision: o.peakTimePrecision,
    peakPeriodStart: iso(o.peakPeriodStart),
    peakPeriodEnd: iso(o.peakPeriodEnd),
    peakReturnPct: s(o.peakReturnPct),
    extensionPeakFlag: o.extensionPeakFlag,
    day0State: o.day0State,
    expectedDays: o.expectedDays,
    completedDays: o.completedDays,
    coveredDays: o.coveredDays,
    missingDates: o.missingDates,
    invalidDates: o.invalidDates,
    reasons: o.reasons,
    computedAt: o.computedAt.toISOString(),
    finalizedAt: iso(o.finalizedAt),
  };
}

function statsJson(x: Stats) {
  return {
    n: x.n,
    mean: s(x.mean),
    median: s(x.median),
    p25: s(x.p25),
    p75: s(x.p75),
    min: s(x.min),
    max: s(x.max),
  };
}

export function cohortGroupJson(g: CohortGroup) {
  return {
    ...g,
    finalReturns: statsJson(g.finalReturns),
    horizonHours: { ...statsJson(g.horizonHours), bins: g.horizonHours.bins },
  };
}

/**
 * Read-only forward-test queries shared by the dashboard API, MCP, the CLI and the export. All
 * money and percentage values are exact decimal strings; nothing here writes.
 */
@Injectable()
export class ForwardReadService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  get providerId() {
    return this.cfg.DATA_SOURCE;
  }

  /** Event rows with their latest outcome, newest detection first. */
  async events(q: {
    view: EventView;
    stars?: number;
    search?: string;
    limit: number;
    offset: number;
  }): Promise<{ total: number; offset: number; rows: ForwardEventRow[] }> {
    const qb = this.db
      .getRepository(ForwardEvent)
      .createQueryBuilder('e')
      .where('e.provider_id = :providerId', { providerId: this.providerId })
      .andWhere('e.status IN (:...statuses)', { statuses: VIEW_STATUSES[q.view] });
    if (q.stars) qb.andWhere('e.star_count = :stars', { stars: q.stars });
    const search = q.search?.trim();
    if (search) {
      const id = /^\d{1,10}$/.test(search) ? Number(search) : null;
      qb.andWhere(
        new Brackets((w) => {
          w.where('e.symbol ILIKE :term', {
            term: `%${search.replace(/[\\%_]/g, '\\$&')}%`,
          }).orWhere('e.name ILIKE :term');
          if (id !== null && id <= 2_147_483_647) w.orWhere('e.cmc_id = :id', { id });
        }),
      );
    }
    const [events, total] = await qb
      .orderBy('e.detected_at', 'DESC')
      .addOrderBy('e.star_count', 'DESC')
      .offset(q.offset)
      .limit(q.limit)
      .getManyAndCount();
    return { total, offset: q.offset, rows: await this.rows(events) };
  }

  /** Every event of the provider (exports), oldest first. */
  async allEvents(): Promise<ForwardEventRow[]> {
    const events = await this.db.getRepository(ForwardEvent).find({
      where: { providerId: this.providerId },
      order: { detectedAt: 'ASC', starCount: 'ASC' },
    });
    return this.rows(events);
  }

  private async rows(events: ForwardEvent[]): Promise<ForwardEventRow[]> {
    if (!events.length) return [];
    // Only each event's latest version (older versions stay in the table for audit).
    const outcomes = new Map(
      (
        await this.db
          .getRepository(ForwardOutcome)
          .createQueryBuilder('o')
          .innerJoin(ForwardEvent, 'e', 'e.id = o.event_id AND e.result_version = o.result_version')
          .where('o.event_id = ANY(:ids)', { ids: events.map((e) => e.id) })
          .getMany()
      ).map((o) => [o.eventId, o]),
    );
    // Correlation markers need every event of the same assets, not just this page.
    const siblings = await this.db.getRepository(ForwardEvent).find({
      where: { providerId: this.providerId, cmcId: In([...new Set(events.map((e) => e.cmcId))]) },
      select: { id: true, cmcId: true, detectedAt: true, evaluationEnd: true },
    });
    const overlaps = overlapMap(siblings.map((e) => ({ ...e, eventId: e.id })));
    const perAsset = new Map<number, number>();
    for (const e of siblings) perAsset.set(e.cmcId, (perAsset.get(e.cmcId) ?? 0) + 1);
    return events.map((e) => {
      const o = outcomes.get(e.id);
      return {
        eventId: e.id,
        cmcId: e.cmcId,
        symbol: e.symbol,
        name: e.name,
        slug: e.slug,
        isLive: e.isLive,
        detectedAt: e.detectedAt.toISOString(),
        detectedUtcDate: e.detectedUtcDate,
        detectionHourUtc: e.detectedAt.getUTCHours(),
        starCount: e.starCount,
        referencePriceUsd: e.snapshotPriceUsd.toFixed(),
        sourceUpdatedAt: e.sourceUpdatedAt.toISOString(),
        sourceBatchId: e.sourceBatchId,
        rank: e.rank,
        pass3d: e.pass3d,
        pass7d: e.pass7d,
        pass30d: e.pass30d,
        multiple3d: s(e.multiple3d),
        multiple7d: s(e.multiple7d),
        multiple30d: s(e.multiple30d),
        passPattern: `${e.pass3d}/${e.pass7d}/${e.pass30d}`,
        weightedPassPoints: e.weightedPassPoints,
        scoreComplete: e.scoreComplete,
        weightedStrength: s(e.weightedStrength),
        rankingRulesetVersion: e.rankingRulesetVersion,
        currentVmc: s(e.currentVmc),
        lbankPairs: (e.lbankPairs ?? []).map((p) => p.marketPair),
        rulesetVersion: e.rulesetVersion,
        deadline168h: e.deadline168h.toISOString(),
        evaluationEnd: e.evaluationEnd.toISOString(),
        effectiveHorizonHours: s(e.effectiveHorizonHours)!,
        status: e.status,
        qualityFlags: e.qualityFlags,
        resultVersion: e.resultVersion,
        lastUpdateAt: iso(e.lastUpdateAt),
        finalizedAt: iso(e.finalizedAt),
        outcome: o ? outcomeJson(o) : null,
        assetEventCount: perAsset.get(e.cmcId) ?? 1,
        overlappingEventIds: overlaps.get(e.id) ?? [],
      };
    });
  }

  /** One event with every High observation (superseded ones too) and every outcome version. */
  async event(id: string) {
    const e = await this.db
      .getRepository(ForwardEvent)
      .findOneBy({ id, providerId: this.providerId });
    if (!e) return null;
    const [row] = await this.rows([e]);
    const [highs, outcomes, trigger] = await Promise.all([
      this.db
        .getRepository(ForwardHigh)
        .find({ where: { eventId: id }, order: { periodStart: 'ASC', id: 'ASC' } }),
      this.db
        .getRepository(ForwardOutcome)
        .find({ where: { eventId: id }, order: { resultVersion: 'DESC' } }),
      e.triggerRunId
        ? this.db.getRepository(ForwardTriggerRun).findOneBy({ id: e.triggerRunId })
        : Promise.resolve(null),
    ]);
    return {
      event: row!,
      detection: {
        snapshotId: e.snapshotId,
        slotTime: e.slotTime.toISOString(),
        platform: { chain: e.platformChain, address: e.platformAddress },
        capUsd: s(e.capUsd),
        volume24hUsd: s(e.volume24hUsd),
        vmc: {
          d3: s(e.vmc3dAvg),
          d7: s(e.vmc7dAvg),
          d14: s(e.vmc14dAvg),
          d30: s(e.vmc30dAvg),
        },
        queueOrder: e.queueOrder,
        configVersion: e.configVersion,
        inputsHash: e.inputsHash,
        rulesVersion: e.rulesVersion,
        triggerRun: trigger
          ? {
              id: trigger.id,
              triggeredAt: trigger.triggeredAt.toISOString(),
              batchId: trigger.batchId,
            }
          : null,
        scanSnapshot: e.scanSnapshot,
      },
      highs: highs.map((h) => ({
        id: h.id,
        dateUtc: h.dateUtc,
        periodStart: h.periodStart.toISOString(),
        periodEnd: h.periodEnd.toISOString(),
        source: h.source,
        sourceRevisionId: h.sourceRevisionId,
        revision: h.revision,
        highUsd: h.highUsd?.toFixed() ?? null,
        timeHigh: iso(h.timeHigh),
        quoteCurrency: h.quoteCurrency,
        observedAt: h.observedAt.toISOString(),
        eligibility: h.eligibility,
        reason: h.reason,
        isCurrent: h.isCurrent,
        supersededAt: iso(h.supersededAt),
      })),
      outcomes: outcomes.map(outcomeJson),
      notice: FORWARD_NOTICE,
    };
  }

  async rejections(limit: number, sinceDays?: number) {
    const rows = await this.db.getRepository(ForwardTriggerRejection).find({
      where: {
        providerId: this.providerId,
        ...(sinceDays
          ? { createdAt: MoreThanOrEqual(new Date(Date.now() - sinceDays * DAY_MS)) }
          : {}),
      },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit,
    });
    const slots = new Map(
      rows.length
        ? (
            await this.db.getRepository(CrawlBatch).find({
              where: { id: In([...new Set(rows.map((r) => r.batchId))]) },
              select: { id: true, slotTime: true },
            })
          ).map((b) => [b.id, b.slotTime.toISOString()])
        : [],
    );
    return rows.map((r) => ({
      id: r.id,
      batchId: r.batchId,
      slotTime: slots.get(r.batchId) ?? null,
      cmcId: r.cmcId,
      symbol: r.symbol,
      starCount: r.starCount,
      reasons: r.reasons,
      observed: r.observed,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Operations, coverage, freshness warnings and the star-group comparison (PDF p.9, p.10). */
  async summary(now = new Date()) {
    const providerId = this.providerId;
    const [provider, events, outcomes, watchlist, lastTrigger, triggers, lastUpdate, lastGood] =
      await Promise.all([
        this.db.getRepository(Provider).findOneBy({ id: providerId }),
        this.db.getRepository(ForwardEvent).find({
          where: { providerId },
          select: {
            id: true,
            cmcId: true,
            starCount: true,
            detectedAt: true,
            detectedUtcDate: true,
            evaluationEnd: true,
            status: true,
            pass3d: true,
            pass7d: true,
            pass30d: true,
            weightedPassPoints: true,
            scoreComplete: true,
            resultVersion: true,
            effectiveHorizonHours: true,
            qualityFlags: true,
          },
        }),
        this.db.query(
          `SELECT o.event_id AS "eventId", o.peak_kind AS "peakKind", o.peak_return_pct::text AS "ret",
                  o.completed_days AS "completed", o.covered_days AS "covered",
                  cardinality(o.missing_dates) AS "missing", cardinality(o.invalid_dates) AS "invalid",
                  o.day0_state AS "day0"
             FROM forward_outcome o JOIN forward_event e ON e.id = o.event_id AND e.result_version = o.result_version
            WHERE e.provider_id = $1`,
          [providerId],
        ) as Promise<
          Array<{
            eventId: string;
            peakKind: string;
            ret: string | null;
            completed: number;
            covered: number;
            missing: number;
            invalid: number;
            day0: string;
          }>
        >,
        this.db.getRepository(ForwardTestWatchlist).countBy({ providerId }),
        this.db
          .getRepository(ForwardTriggerRun)
          .findOne({ where: { providerId }, order: { triggeredAt: 'DESC' } }),
        this.db.getRepository(ForwardTriggerRun).count({ where: { providerId } }),
        this.db
          .getRepository(ForwardUpdateRun)
          .findOne({ where: { providerId }, order: { startedAt: 'DESC' } }),
        this.db.getRepository(ForwardUpdateRun).findOne({
          where: { providerId, status: In(['succeeded', 'partial']) },
          order: { startedAt: 'DESC' },
        }),
      ]);
    const byEvent = new Map(outcomes.map((o) => [o.eventId, o]));
    const cohort = cohortReport(
      events.map((e) => {
        const o = byEvent.get(e.id);
        return {
          eventId: e.id,
          cmcId: e.cmcId,
          stars: e.starCount,
          detectedAt: e.detectedAt,
          detectedUtcDate: e.detectedUtcDate,
          evaluationEnd: e.evaluationEnd,
          status: e.status,
          peakKind: (o?.peakKind as 'EXACT' | 'LOWER_BOUND' | 'NONE' | undefined) ?? null,
          peakReturnPct: o?.ret ? new D(o.ret) : null,
          effectiveHorizonHours: e.effectiveHorizonHours,
          passes: [e.pass3d, e.pass7d, e.pass30d] as const,
          weightedPassPoints: e.weightedPassPoints,
          scoreComplete: e.scoreComplete,
        };
      }),
    );
    const sum = (k: 'completed' | 'covered' | 'missing' | 'invalid') =>
      outcomes.reduce((n, o) => n + Number(o[k]), 0);
    const coverage = {
      completedDays: sum('completed'),
      coveredDays: sum('covered'),
      missingDays: sum('missing'),
      invalidDays: sum('invalid'),
      day0Unresolved: outcomes.filter((o) => o.day0 === 'UNRESOLVED').length,
    };
    const warnings: string[] = [];
    const active = events.filter((e) => ACTIVE_EVENT_STATUSES.includes(e.status)).length;
    if (provider && !provider.isLive)
      warnings.push('SYNTHETIC: fixture data, not market data; for demonstration only.');
    const goodAt = lastGood?.finishedAt ?? null;
    if (events.length && (!goodAt || now.getTime() - goodAt.getTime() > 26 * 3_600_000))
      warnings.push(
        `FRESHNESS: ${goodAt ? `the last successful daily High update finished ${goodAt.toISOString()}` : 'no daily High update has completed yet'}; ${active} active events keep their previous outcomes until it runs.`,
      );
    if (lastUpdate?.status === 'failed')
      warnings.push(
        `UPDATE_FAILED: the latest daily update (${lastUpdate.startedAt.toISOString()}) failed: ${lastUpdate.error ?? 'see the run'}; earlier outcomes are kept.`,
      );
    else if (lastUpdate?.status === 'partial')
      warnings.push(
        `UPDATE_PARTIAL (${lastUpdate.startedAt.toISOString()}): ${lastUpdate.notes[0] ?? 'some included Highs were missing; they are retried'}`,
      );
    const day0 = events.filter((e) => e.qualityFlags.includes(FORWARD_REASON.incompleteDay0));
    if (day0.length)
      warnings.push(
        `INCOMPLETE_DAY0: ${day0.length} events cannot be finalized — the signal day's High came before detection (or its time is unknown), no later High reached it, and no intraday High source is configured. Their peaks are lower bounds.`,
      );
    return {
      providerId,
      providerName: provider?.name ?? providerId,
      isLive: provider?.isLive ?? null,
      rulesVersion: FORWARD_RULES_VERSION,
      horizon: {
        hours: HORIZON_HOURS,
        rule: 'Highs from detected_at through 23:59:59.999 UTC of the day containing detected_at + 168 h',
      },
      notice: FORWARD_NOTICE,
      counts: {
        events: events.length,
        watchlistAssets: watchlist,
        byStatus: Object.fromEntries(
          FORWARD_EVENT_STATUSES.map((st) => [st, events.filter((e) => e.status === st).length]),
        ),
        triggerRuns: triggers,
      },
      lastTrigger: lastTrigger
        ? {
            batchId: lastTrigger.batchId,
            triggeredAt: lastTrigger.triggeredAt.toISOString(),
            queueStatus: lastTrigger.queueStatus,
            queueRows: lastTrigger.queueRows,
            created: lastTrigger.created,
            ignored: lastTrigger.ignored,
            rejected: lastTrigger.rejected,
          }
        : null,
      lastUpdate: lastUpdate ? this.updateRunJson(lastUpdate) : null,
      lastSuccessfulUpdate: lastGood ? this.updateRunJson(lastGood) : null,
      coverage,
      warnings,
      cohort: cohort.groups.map(cohortGroupJson),
      /** By detection-time pass pattern and weighted-points band (weighted star ranking). */
      cohortByPattern: cohort.patterns.map(cohortGroupJson),
      cohortByPointsBand: cohort.pointsBands.map(cohortGroupJson),
    };
  }

  private updateRunJson(r: ForwardUpdateRun) {
    return {
      id: r.id,
      trigger: r.trigger,
      updateDate: r.updateDate,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      finishedAt: iso(r.finishedAt),
      notes: r.notes,
      error: r.error,
    };
  }
}
