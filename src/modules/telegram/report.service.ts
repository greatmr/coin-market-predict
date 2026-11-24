import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { CrawlBatch } from '../ingestion/entities/crawl-batch.entity.js';
import { PipelineRun } from '../pipeline/entities/pipeline-run.entity.js';
import { ScanResult } from '../scan/entities/scan-result.entity.js';
import { ScanRun } from '../scan/entities/scan-run.entity.js';
import { Provider } from '../sources/entities/provider.entity.js';

import { type QueueRow, type Tier1ReportInput, formatTier1Report } from './format.js';
import { TelegramService } from './telegram.service.js';

const num = (v: { toString(): string } | null) => (v === null ? null : Number(v.toString()));

/** Builds the Telegram summary of one scanned crawl batch from the database (the source of truth). */
@Injectable()
export class ReportService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly telegram: TelegramService,
  ) {}

  async buildInput(batchId: string): Promise<Tier1ReportInput> {
    const [run, batch] = await Promise.all([
      this.db.getRepository(ScanRun).findOneByOrFail({ batchId }),
      this.db.getRepository(CrawlBatch).findOneByOrFail({ id: batchId }),
    ]);
    const provider = await this.db.getRepository(Provider).findOneBy({ id: batch.providerId });
    const queue = await this.db.getRepository(ScanResult).find({
      where: { batchId, inQueue: true },
      order: { queueOrder: 'ASC' },
      take: this.cfg.TELEGRAM_QUEUE_ROWS,
    });
    const counts = (run.counts ?? {}) as Record<string, number>;
    const rows: QueueRow[] = queue.map((r) => ({
      order: r.queueOrder ?? 0,
      cmcId: r.cmcId,
      symbol: r.symbol,
      stars: r.stars,
      pass: { d3: r.pass3d, d7: r.pass7d, d30: r.pass30d },
      multiple: { d3: num(r.multiple3d), d7: num(r.multiple7d), d30: num(r.multiple30d) },
      currentVmc: num(r.currentVmc),
      capUsd: num(r.capUsd),
      lbankPairs: (r.lbankPairs ?? [])
        .filter((p) => p.trading === 'TRADING' && (p.mapping === 'OK' || p.mapping === 'CONFIRMED'))
        .map((p) => p.marketPair),
    }));
    return {
      generatedAt: new Date(),
      slotTime: batch.slotTime,
      crawledAt: batch.crawledAt,
      timezone: this.cfg.DISPLAY_TIMEZONE,
      providerName: provider?.name ?? batch.providerId,
      isLive: batch.isLive,
      attribution: provider?.attribution ?? null,
      batchStatus: batch.status,
      batchReasons: batch.statusReasons,
      queueStatus: run.queueStatus ?? 'EMPTY',
      counts: {
        assets: counts.assets ?? 0,
        screened: counts.screened ?? counts.assets ?? 0,
        eligible: counts.eligible ?? 0,
        queue: counts.queue ?? 0,
      },
      rows,
      warnings: run.warnings,
      botUsername: this.telegram.botUsername,
    };
  }

  async build(batchId: string): Promise<string[]> {
    return formatTier1Report(await this.buildInput(batchId));
  }

  /** Crawl batch of a pipeline run (for re-sending a run's report). */
  async batchOfRun(runId: string): Promise<string | null> {
    const run = await this.db.getRepository(PipelineRun).findOneBy({ id: runId });
    if (!run) return null;
    const m = (run.metrics ?? {}) as { batchId?: string };
    if (m.batchId) return m.batchId;
    return (
      (
        await this.db
          .getRepository(CrawlBatch)
          .findOneBy({ providerId: run.providerId, slotTime: run.slotTime })
      )?.id ?? null
    );
  }
}
