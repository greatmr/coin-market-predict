import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, type EntityManager, In } from 'typeorm';

import { type DValue, dec, forStorage } from '../../common/utils/decimal.js';
import { plain } from '../../common/utils/plain.js';

import { CmcAsset } from '../ingestion/entities/cmc-asset.entity.js';
import { CrawlBatch } from '../ingestion/entities/crawl-batch.entity.js';
import { MarketSnapshot } from '../ingestion/entities/market-snapshot.entity.js';
import { ScanResult } from '../scan/entities/scan-result.entity.js';
import { ScanRun } from '../scan/entities/scan-run.entity.js';
import {
  type BatchStatus,
  type PassStatus,
  type QueueStatus,
  type ResolvedPair,
  StrategyService,
} from '../strategy/index.js';

import { ForwardEvent } from './entities/forward-event.entity.js';
import { ForwardTestWatchlist } from './entities/forward-test-watchlist.entity.js';
import { ForwardTriggerRejection } from './entities/forward-trigger-rejection.entity.js';
import { ForwardTriggerRun } from './entities/forward-trigger-run.entity.js';
import { type TriggerCandidate, eventWindow, validateTrigger } from './forward-rules.js';
import { FORWARD_RULES_VERSION } from './forward.constants.js';

/** A published Review Queue row with the fields an event keeps (adapter: docs/forward-test.md § 3). */
export interface TriggerRow extends TriggerCandidate {
  symbol: string;
  name: string;
  slug: string | null;
  rank: number | null;
  snapshotId: number | null;
  platformChain: string | null;
  platformAddress: string | null;
  capUsd: DValue | null;
  volume24hUsd: DValue | null;
  currentVmc: DValue | null;
  vmc3dAvg: DValue | null;
  vmc7dAvg: DValue | null;
  vmc14dAvg: DValue | null;
  vmc30dAvg: DValue | null;
  multiple3d: DValue | null;
  multiple7d: DValue | null;
  multiple30d: DValue | null;
  pass3d: PassStatus;
  pass7d: PassStatus;
  pass30d: PassStatus;
  queueOrder: number | null;
  lbankPairs: ResolvedPair[];
  rulesetVersion: string;
  configVersion: string;
  inputsHash: string;
  /** Every scanner field of the row as published. */
  scanSnapshot: Record<string, unknown>;
}

export interface TriggerBatch {
  id: string;
  providerId: string;
  slotTime: Date;
  status: BatchStatus;
  isLive: boolean;
}

export interface CaptureReport {
  batchId: string;
  triggerRunId: string;
  queueStatus: QueueStatus | null;
  queueRows: number;
  created: Array<{ eventId: string; cmcId: number; stars: number }>;
  ignored: Array<{ cmcId: number; stars: number; eventId: string | null }>;
  rejected: Array<{ cmcId: number | null; stars: number; reasons: string[] }>;
}

const text = (v: DValue | null) => (v === null ? null : v.toFixed());

/**
 * The forward-test trigger (PDF p.3, p.4): attached to the hourly scanner publication, it reads a
 * batch's published Review Queue and registers the first priced observation per
 * (CMC id, UTC date, star count). Stars come from the scanner as published; there is no approval
 * step. Duplicates are left to the unique key (`INSERT … ON CONFLICT DO NOTHING`), so a rerun or a
 * concurrent worker never creates a second event or changes the first price. Rows that cannot
 * open a priced event are stored as rejections with every reason.
 */
@Injectable()
export class ForwardCaptureService {
  private readonly log = new Logger(ForwardCaptureService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly strategy: StrategyService,
  ) {}

  /** The published Review Queue of a scanned batch, mapped to trigger rows. */
  async queueRows(batchId: string): Promise<{
    batch: TriggerBatch;
    queueStatus: QueueStatus | null;
    rows: TriggerRow[];
  }> {
    const b = await this.db.getRepository(CrawlBatch).findOneByOrFail({ id: batchId });
    const run = await this.db.getRepository(ScanRun).findOneBy({ batchId });
    const results =
      run?.status === 'succeeded'
        ? await this.db
            .getRepository(ScanResult)
            .find({ where: { batchId, inQueue: true }, order: { queueOrder: 'ASC', cmcId: 'ASC' } })
        : [];
    const ids = [...new Set(results.map((r) => r.cmcId))];
    const assets = new Map(
      ids.length
        ? (
            await this.db
              .getRepository(CmcAsset)
              .findBy({ providerId: b.providerId, cmcId: In(ids) })
          ).map((a) => [a.cmcId, a])
        : [],
    );
    const snaps = new Map<string, number[]>();
    if (ids.length)
      for (const s of await this.db.getRepository(MarketSnapshot).find({
        where: {
          providerId: b.providerId,
          slotTime: b.slotTime,
          providerAssetId: In(ids.map(String)),
        },
        select: { id: true, providerAssetId: true },
      }))
        snaps.set(s.providerAssetId, [...(snaps.get(s.providerAssetId) ?? []), s.id]);
    const rowsPerId = new Map<number, number>();
    for (const r of results) rowsPerId.set(r.cmcId, (rowsPerId.get(r.cmcId) ?? 0) + 1);
    const rows: TriggerRow[] = results.map((r) => {
      const asset = assets.get(r.cmcId);
      const snapIds = snaps.get(String(r.cmcId)) ?? [];
      return {
        cmcId: r.cmcId,
        stars: r.stars,
        inQueue: r.inQueue,
        eligibilityStatus: r.eligibilityStatus,
        lbankStatus: r.lbankStatus,
        price: dec(r.priceUsd),
        currentStatus: r.currentStatus,
        sourceUpdatedAt: r.observedAt,
        observedAt: r.crawledAt,
        identityUnique: !!asset && snapIds.length === 1 && rowsPerId.get(r.cmcId) === 1,
        symbol: r.symbol,
        name: r.name,
        slug: r.slug ?? asset?.slug ?? null,
        rank: r.rank,
        snapshotId: snapIds.length === 1 ? snapIds[0]! : null,
        platformChain: asset?.platformChain ?? null,
        platformAddress: asset?.platformAddress ?? null,
        capUsd: dec(r.capUsd),
        volume24hUsd: dec(r.volume24hUsd),
        currentVmc: dec(r.currentVmc),
        vmc3dAvg: dec(r.vmc3dAvg),
        vmc7dAvg: dec(r.vmc7dAvg),
        vmc14dAvg: dec(r.vmc14dAvg),
        vmc30dAvg: dec(r.vmc30dAvg),
        multiple3d: dec(r.multiple3d),
        multiple7d: dec(r.multiple7d),
        multiple30d: dec(r.multiple30d),
        pass3d: r.pass3d,
        pass7d: r.pass7d,
        pass30d: r.pass30d,
        queueOrder: r.queueOrder,
        lbankPairs: r.lbankPairs,
        rulesetVersion: r.rulesetVersion,
        configVersion: r.configVersion,
        inputsHash: r.inputsHash,
        // Decimals as exact text (plain() would turn them into floats).
        scanSnapshot: plain<Record<string, unknown>>(
          Object.fromEntries(
            Object.entries(r).map(([k, v]) => [
              k,
              v && typeof v === 'object' && 'toFixed' in v ? (v as DValue).toFixed() : v,
            ]),
          ),
        ),
      };
    });
    return {
      batch: {
        id: b.id,
        providerId: b.providerId,
        slotTime: b.slotTime,
        status: b.status,
        isLive: b.isLive,
      },
      queueStatus: run?.queueStatus ?? null,
      rows,
    };
  }

  /** The hourly trigger: read the batch's published queue and register its events. */
  async captureBatch(
    batchId: string,
    opts: { now: Date; pipelineRunId?: string | null },
  ): Promise<CaptureReport> {
    const q = await this.queueRows(batchId);
    return this.capture(q.batch, q.queueStatus, q.rows, opts);
  }

  async capture(
    batch: TriggerBatch,
    queueStatus: QueueStatus | null,
    rows: readonly TriggerRow[],
    opts: { now: Date; pipelineRunId?: string | null },
  ): Promise<CaptureReport> {
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
          .into(ForwardTriggerRun)
          .values({
            providerId: batch.providerId,
            batchId: batch.id,
            pipelineRunId: opts.pipelineRunId ?? null,
            triggeredAt: opts.now,
            queueStatus,
            batchStatus: batch.status,
            queueRows: rows.length,
            created: 0,
            ignored: 0,
            rejected: 0,
            details: { created: [], ignored: [] },
            notes: [],
          })
          .returning('id')
          .updateEntity(false)
          .execute()) as { raw: Array<{ id: string }> }
      ).raw[0]!.id;
      const r: CaptureReport = {
        batchId: batch.id,
        triggerRunId: runId,
        queueStatus,
        queueRows: rows.length,
        created: [],
        ignored: [],
        rejected: [],
      };
      for (const row of rows) {
        const reasons = validateTrigger(row, ctx);
        if (reasons.length) {
          await this.reject(m, batch, runId, row, reasons);
          r.rejected.push({ cmcId: row.cmcId, stars: row.stars, reasons });
          continue;
        }
        const id = await this.insertEvent(m, batch, runId, row);
        if (id) {
          r.created.push({ eventId: id, cmcId: row.cmcId!, stars: row.stars });
          continue;
        }
        // Same (asset, UTC date, stars) already recorded: its first price and time stay as they are.
        const existing = await m.getRepository(ForwardEvent).findOne({
          where: {
            providerId: batch.providerId,
            cmcId: row.cmcId!,
            detectedUtcDate: eventWindow(row.observedAt!).detectedUtcDate,
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
      await m.getRepository(ForwardTriggerRun).update(
        { id: runId },
        {
          created: r.created.length,
          ignored: r.ignored.length,
          rejected: r.rejected.length,
          details: { created: r.created.map((c) => c.eventId), ignored: r.ignored } as never,
          notes,
        },
      );
      return r;
    });
    this.log.log(
      `forward trigger ${batch.slotTime.toISOString()}: ${report.queueRows} queue rows → ${report.created.length} new events, ${report.ignored.length} already recorded, ${report.rejected.length} rejected`,
    );
    return report;
  }

  /** Watchlist entry (first event of the asset) and the event, first insert wins; null if the key exists. */
  private async insertEvent(
    m: EntityManager,
    batch: TriggerBatch,
    triggerRunId: string,
    row: TriggerRow,
  ): Promise<string | null> {
    const w = eventWindow(row.observedAt!);
    await m
      .createQueryBuilder()
      .insert()
      .into(ForwardTestWatchlist)
      .values({
        providerId: batch.providerId,
        cmcId: row.cmcId!,
        symbol: row.symbol,
        name: row.name,
        slug: row.slug,
        platformChain: row.platformChain,
        platformAddress: row.platformAddress,
        isLive: batch.isLive,
        firstEventAt: w.detectedAt,
        lastEventAt: w.detectedAt,
        eventCount: 0,
      })
      .orIgnore()
      .updateEntity(false)
      .execute();
    const inserted = (await m
      .createQueryBuilder()
      .insert()
      .into(ForwardEvent)
      .values({
        providerId: batch.providerId,
        cmcId: row.cmcId!,
        detectedUtcDate: w.detectedUtcDate,
        starCount: row.stars,
        detectedAt: w.detectedAt,
        sourceUpdatedAt: row.sourceUpdatedAt!,
        sourceBatchId: batch.id,
        slotTime: batch.slotTime,
        snapshotId: row.snapshotId,
        triggerRunId,
        isLive: batch.isLive,
        snapshotPriceUsd: text(row.price) as never,
        quoteCurrency: 'USD',
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
        lbankPairs: row.lbankPairs as never,
        rulesetVersion: row.rulesetVersion,
        configVersion: row.configVersion,
        inputsHash: row.inputsHash,
        scanSnapshot: row.scanSnapshot as never,
        deadline168h: w.deadline168h,
        evaluationEnd: w.evaluationEnd,
        effectiveHorizonHours: forStorage(w.effectiveHorizonHours) as never,
        rulesVersion: FORWARD_RULES_VERSION,
        status: 'OPEN',
        qualityFlags: [],
        resultVersion: 0,
      })
      .orIgnore()
      .returning('id')
      .updateEntity(false)
      .execute()) as { raw: Array<{ id: string }> };
    const id = inserted.raw[0]?.id ?? null;
    if (id)
      await m
        .createQueryBuilder()
        .update(ForwardTestWatchlist)
        .set({
          eventCount: () => 'event_count + 1',
          firstEventAt: () => 'LEAST(first_event_at, :at)',
          lastEventAt: () => 'GREATEST(last_event_at, :at)',
        })
        .where('provider_id = :providerId AND cmc_id = :cmcId', {
          providerId: batch.providerId,
          cmcId: row.cmcId,
          at: w.detectedAt,
        })
        .execute();
    return id;
  }

  private async reject(
    m: EntityManager,
    batch: TriggerBatch,
    triggerRunId: string,
    row: TriggerRow,
    reasons: string[],
  ) {
    await m
      .createQueryBuilder()
      .insert()
      .into(ForwardTriggerRejection)
      .values({
        providerId: batch.providerId,
        batchId: batch.id,
        triggerRunId,
        cmcId: row.cmcId,
        symbol: row.symbol || null,
        starCount: row.stars,
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
        } as never,
      })
      .orIgnore()
      .updateEntity(false)
      .execute();
  }
}
