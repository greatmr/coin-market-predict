import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, In } from 'typeorm';

import { type DValue, dec } from '../../common/utils/decimal.js';
import { plain } from '../../common/utils/plain.js';

import { CmcAsset } from '../ingestion/entities/cmc-asset.entity.js';
import { CrawlBatch } from '../ingestion/entities/crawl-batch.entity.js';
import { MarketSnapshot } from '../ingestion/entities/market-snapshot.entity.js';
import { ScanResult } from '../scan/entities/scan-result.entity.js';
import { ScanRun } from '../scan/entities/scan-run.entity.js';
import type { BatchStatus, PassStatus, QueueStatus, ResolvedPair } from '../strategy/index.js';

import type { TriggerCandidate } from './star-event.rules.js';

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
  /** Ranking fields of the published row, snapshotted as they were (weighted star ranking § 5). */
  weightedPassPoints: number | null;
  scoreComplete: boolean | null;
  weightedStrength: DValue | null;
  rankingRulesetVersion: string | null;
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
  /** The batch's crawl time: every row's detection time, and what routes the batch (cutover). */
  crawledAt?: Date | null;
  status: BatchStatus;
  isLive: boolean;
}

export interface PublishedQueue {
  batch: TriggerBatch;
  queueStatus: QueueStatus | null;
  rows: TriggerRow[];
}

/**
 * Reads a scanned batch's stored Review Queue (the `scan_result` rows in the queue, the run's queue
 * status, the batch, the CMC identity and the stored observation) as trigger rows: the input of both
 * trackers' event intake. Read-only.
 */
@Injectable()
export class PublishedQueueService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async queueRows(batchId: string): Promise<PublishedQueue> {
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
        weightedPassPoints: r.weightedPassPoints,
        scoreComplete: r.scoreComplete,
        weightedStrength: dec(r.weightedStrength),
        rankingRulesetVersion: r.rankingRulesetVersion,
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
        crawledAt: b.crawledAt,
        status: b.status,
        isLive: b.isLive,
      },
      queueStatus: run?.queueStatus ?? null,
      rows,
    };
  }
}
