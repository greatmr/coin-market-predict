import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, MoreThanOrEqual } from 'typeorm';

import { dec } from '../../common/utils/decimal.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { MarketSnapshot } from '../ingestion/entities/market-snapshot.entity.js';

import type { SnapshotPoint } from './agent-data.js';

/** Exact-decimal reads for the agent's tools (the shared read model returns display numbers). */
@Injectable()
export class AgentDataService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Observations of one CMC id within `hours` of its newest one, oldest first. */
  async snapshots(cmcId: number, hours: number): Promise<SnapshotPoint[]> {
    const repo = this.db.getRepository(MarketSnapshot);
    const where = { providerId: this.cfg.DATA_SOURCE, providerAssetId: String(cmcId) };
    const latest = await repo.findOne({
      where,
      order: { slotTime: 'DESC' },
      select: { id: true, slotTime: true },
    });
    if (!latest) return [];
    const rows = await repo.find({
      where: {
        ...where,
        slotTime: MoreThanOrEqual(new Date(latest.slotTime.getTime() - hours * 3_600_000)),
      },
      order: { slotTime: 'ASC' },
      select: {
        id: true,
        slotTime: true,
        observedAt: true,
        price: true,
        marketCap: true,
        volumeRolling24h: true,
        rank: true,
        isStale: true,
      },
    });
    return rows.map((r) => ({
      slotTime: r.slotTime,
      observedAt: r.observedAt,
      price: dec(r.price),
      marketCap: dec(r.marketCap),
      volume24h: dec(r.volumeRolling24h),
      rank: r.rank,
      isStale: r.isStale,
    }));
  }
}
