import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import type { DValue } from '../../common/utils/decimal.js';

import { CutoverService } from '../star-events/cutover.service.js';
import {
  PublishedQueueService,
  type TriggerBatch,
  type TriggerRow,
} from '../star-events/published-queue.service.js';
import { detectedUtcDate, validateTrigger, workflowFor } from '../star-events/star-event.rules.js';
import { type QueueStatus, StrategyService } from '../strategy/index.js';

import { CandleStoreService } from './candle-store.service.js';
import { ObsEvent } from './entities/obs-event.entity.js';
import { type IntakeDetails, ObsIntakeRun } from './entities/obs-intake-run.entity.js';
import { Observation } from './entities/observation.entity.js';
import { observationWindow, resolveSpotPair } from './observation-rules.js';
import { OBSERVATION_RULES_VERSION } from './observation.constants.js';

export interface IntakeReport {
  batchId: string;
  intakeRunId: string;
  queueStatus: QueueStatus | null;
  queueRows: number;
  created: IntakeDetails['created'];
  ignored: IntakeDetails['ignored'];
  rejected: IntakeDetails['rejected'];
}

export interface IntakeSkipped {
  batchId: string;
  skipped: string;
}

const text = (v: DValue | null) => (v === null ? null : v.toFixed());

/**
 * Intake of the LBank Spot Price Observation (docs/lbank-spot-observation.md § 2): reads a batch's
 * published Review Queue and, for batches detected at or after the cutover, opens one event per
 * (CMC id, UTC date, star count) with the shared star-event rule — first insert wins — and its
 * observation in the same transaction. Rows that cannot open an event are recorded with reasons.
 * Rerunning a batch creates nothing new.
 */
@Injectable()
export class ObservationIntakeService {
  private readonly log = new Logger(ObservationIntakeService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly strategy: StrategyService,
    private readonly queue: PublishedQueueService,
    private readonly cutover: CutoverService,
    private readonly candles: CandleStoreService,
  ) {}

  async intakeBatch(
    batchId: string,
    opts: { now: Date; pipelineRunId?: string | null },
  ): Promise<IntakeReport | IntakeSkipped> {
    const q = await this.queue.queueRows(batchId);
    const detectedAt = q.batch.crawledAt ?? q.rows.find((r) => r.observedAt)?.observedAt ?? null;
    const cut = await this.cutover.get(q.batch.providerId);
    if (!detectedAt || workflowFor(cut, detectedAt) !== 'LBANK_OBSERVATION')
      return {
        batchId,
        skipped: cut
          ? `before the cutover ${cut.toISOString()}: the batch belongs to the legacy forward test`
          : 'no cutover set: the legacy forward test takes every event',
      };
    return this.intake(q.batch, q.queueStatus, q.rows, cut!, opts);
  }

  async intake(
    batch: TriggerBatch,
    queueStatus: QueueStatus | null,
    rows: readonly TriggerRow[],
    cutoverAt: Date,
    opts: { now: Date; pipelineRunId?: string | null },
  ): Promise<IntakeReport> {
    const maxAge = this.strategy.maxQuoteAgeMs;
    const ctx = {
      queueStatus,
      batchStatus: batch.status,
      now: opts.now,
      maxBatchAgeMs: maxAge,
      maxQuoteAgeMs: maxAge,
    };
    const report = await this.db.transaction(async (m) => {
      const runId = (
        (await m
          .createQueryBuilder()
          .insert()
          .into(ObsIntakeRun)
          .values({
            providerId: batch.providerId,
            batchId: batch.id,
            pipelineRunId: opts.pipelineRunId ?? null,
            intakeAt: opts.now,
            queueStatus,
            batchStatus: batch.status,
            queueRows: rows.length,
            created: 0,
            ignored: 0,
            rejected: 0,
            details: { created: [], ignored: [], rejected: [] },
            notes: [],
          })
          .returning('id')
          .updateEntity(false)
          .execute()) as { raw: Array<{ id: string }> }
      ).raw[0]!.id;
      const r: IntakeReport = {
        batchId: batch.id,
        intakeRunId: runId,
        queueStatus,
        queueRows: rows.length,
        created: [],
        ignored: [],
        rejected: [],
      };
      for (const row of rows) {
        const reasons = validateTrigger(row, ctx);
        // Defence in depth: each row's own detection time routes it (the batch's crawl time).
        if (row.observedAt && workflowFor(cutoverAt, row.observedAt) !== 'LBANK_OBSERVATION')
          reasons.push('BEFORE_CUTOVER');
        if (reasons.length) {
          r.rejected.push({
            cmcId: row.cmcId,
            symbol: row.symbol,
            stars: row.stars,
            reasons,
            observed: {
              price: text(row.price),
              sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
              observedAt: row.observedAt?.toISOString() ?? null,
              currentStatus: row.currentStatus,
              eligibilityStatus: row.eligibilityStatus,
              lbankStatus: row.lbankStatus,
              inQueue: row.inQueue,
              identityUnique: row.identityUnique,
            },
          });
          continue;
        }
        const id = await this.insertEvent(m, batch, runId, row, opts.now);
        if (id) {
          r.created.push({ eventId: id, cmcId: row.cmcId!, stars: row.stars });
          continue;
        }
        const existing = await m.getRepository(ObsEvent).findOne({
          where: {
            providerId: batch.providerId,
            cmcId: row.cmcId!,
            detectedUtcDate: detectedUtcDate(row.observedAt!),
            starCount: row.stars,
          },
          select: { id: true },
        });
        r.ignored.push({ cmcId: row.cmcId!, stars: row.stars, eventId: existing?.id ?? null });
      }
      const notes =
        queueStatus === 'PUBLISHED' || !rows.length
          ? []
          : [`queue ${queueStatus ?? 'not scanned'}: no event opened from this batch`];
      await m.getRepository(ObsIntakeRun).update(
        { id: runId },
        {
          created: r.created.length,
          ignored: r.ignored.length,
          rejected: r.rejected.length,
          details: { created: r.created, ignored: r.ignored, rejected: r.rejected } as never,
          notes,
        },
      );
      return r;
    });
    this.log.log(
      `LBank observation intake ${batch.slotTime.toISOString()}: ${report.queueRows} queue rows → ${report.created.length} new events, ${report.ignored.length} already recorded, ${report.rejected.length} rejected`,
    );
    return report;
  }

  /** The event (first insert wins) and its observation; null when the key already exists. */
  private async insertEvent(
    m: EntityManager,
    batch: TriggerBatch,
    intakeRunId: string,
    row: TriggerRow,
    now: Date,
  ): Promise<string | null> {
    const detectedAt = row.observedAt!;
    const inserted = (await m
      .createQueryBuilder()
      .insert()
      .into(ObsEvent)
      .values({
        providerId: batch.providerId,
        cmcId: row.cmcId!,
        detectedUtcDate: detectedUtcDate(detectedAt),
        starCount: row.stars,
        detectedAt,
        sourceUpdatedAt: row.sourceUpdatedAt!,
        sourceBatchId: batch.id,
        slotTime: batch.slotTime,
        snapshotId: row.snapshotId,
        intakeRunId,
        isLive: batch.isLive,
        cmcPriceUsd: text(row.price) as never,
        symbol: row.symbol,
        name: row.name,
        slug: row.slug,
        rank: row.rank,
        platformChain: row.platformChain,
        platformAddress: row.platformAddress,
        capUsd: text(row.capUsd) as never,
        volume24hUsd: text(row.volume24hUsd) as never,
        currentVmc: text(row.currentVmc) as never,
        vmc3dAvg: text(row.vmc3dAvg) as never,
        vmc7dAvg: text(row.vmc7dAvg) as never,
        vmc14dAvg: text(row.vmc14dAvg) as never,
        vmc30dAvg: text(row.vmc30dAvg) as never,
        multiple3d: text(row.multiple3d) as never,
        multiple7d: text(row.multiple7d) as never,
        multiple30d: text(row.multiple30d) as never,
        pass3d: row.pass3d,
        pass7d: row.pass7d,
        pass30d: row.pass30d,
        queueOrder: row.queueOrder,
        weightedPassPoints: row.weightedPassPoints,
        scoreComplete: row.scoreComplete,
        weightedStrength: text(row.weightedStrength) as never,
        rankingRulesetVersion: row.rankingRulesetVersion,
        lbankPairs: row.lbankPairs as never,
        rulesetVersion: row.rulesetVersion,
        configVersion: row.configVersion,
        inputsHash: row.inputsHash,
        scanSnapshot: row.scanSnapshot as never,
      })
      .orIgnore()
      .returning('id')
      .updateEntity(false)
      .execute()) as { raw: Array<{ id: string }> };
    const id = inserted.raw[0]?.id ?? null;
    if (!id) return null;
    const w = observationWindow(detectedAt);
    const mapping = resolveSpotPair(row.lbankPairs);
    const pairId =
      mapping.status === 'OK'
        ? await this.candles.ensurePair(m, mapping.symbol!, mapping.base!, mapping.quote!)
        : null;
    await m
      .createQueryBuilder()
      .insert()
      .into(Observation)
      .values({
        eventId: id,
        providerId: batch.providerId,
        isLive: batch.isLive,
        t0: detectedAt,
        windowEnd: new Date(w.cutoffMs),
        pairId,
        pairSymbol: mapping.symbol,
        quoteAsset: mapping.quote,
        mappingStatus: mapping.status,
        mappingEvidence: {
          ...mapping.evidence,
          reasons: mapping.reasons,
          decidedAt: now.toISOString(),
        } as never,
        spotStatus: 'UNKNOWN',
        spotTrading: null,
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
    return id;
  }
}
