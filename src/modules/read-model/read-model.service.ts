import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  And,
  Brackets,
  type DataSource,
  type EntityTarget,
  type FindOptionsWhere,
  ILike,
  In,
  IsNull,
  LessThan,
  Like,
  MoreThan,
  MoreThanOrEqual,
  Not,
  type ObjectLiteral,
  type SelectQueryBuilder,
} from 'typeorm';

import { addDays, isoDate } from '../../common/utils/dates.js';
import { D, STORE_DP } from '../../common/utils/decimal.js';
import { plain } from '../../common/utils/plain.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { DailyMetricRevision } from '../daily-metrics/entities/daily-metric-revision.entity.js';
import { DailyMetric } from '../daily-metrics/entities/daily-metric.entity.js';
import { CmcAssetChange } from '../ingestion/entities/cmc-asset-change.entity.js';
import { CmcAsset } from '../ingestion/entities/cmc-asset.entity.js';
import { CrawlBatch } from '../ingestion/entities/crawl-batch.entity.js';
import { DiscoveryRun } from '../ingestion/entities/discovery-run.entity.js';
import { MarketSnapshot } from '../ingestion/entities/market-snapshot.entity.js';
import { JobLease } from '../pipeline/entities/job-lease.entity.js';
import { PipelineRun } from '../pipeline/entities/pipeline-run.entity.js';
import { PipelineStage } from '../pipeline/entities/pipeline-stage.entity.js';
import { nextCronRun, runProgress } from '../pipeline/progress.js';
import { Review } from '../reviews/entities/review.entity.js';
import { ScanResult } from '../scan/entities/scan-result.entity.js';
import { ScanRun } from '../scan/entities/scan-run.entity.js';
import { Provider } from '../sources/entities/provider.entity.js';
import { SourceHealth } from '../sources/entities/source-health.entity.js';
import { DEFAULT_OPEN_COOLDOWN_MS } from '../sources/http/polite-client.js';
import { RULES } from '../strategy/index.js';
import { TelegramDelivery } from '../telegram/entities/telegram-delivery.entity.js';
import { VenueCrawl } from '../venues/entities/venue-crawl.entity.js';
import { VenueDecision } from '../venues/entities/venue-decision.entity.js';
import { VenueMappingTask } from '../venues/entities/venue-mapping-task.entity.js';

export type Sheet = 'queue' | 'eligible' | 'needs_review' | 'excluded' | 'all';

/** Name of the pipeline's job lease (mirrors `PIPELINE_LEASE` without importing the pipeline). */
const PIPELINE_LEASE_NAME = 'hourly-pipeline';

const STAGE_LABELS: Record<string, string> = {
  discover: 'Discovering the coin listing',
  collect: 'Collecting the crawl batch (every listed coin)',
  lbank: 'Reading LBank Spot pairs',
  daily: 'Refreshing completed daily rows for screen candidates',
  scan: 'Running the Tier 1 scan',
  venues: 'Reading CMC Markets venues for review candidates',
  export: 'Writing CSV and XLSX exports',
  notify: 'Preparing the Telegram summary',
  forward: 'Forward test: recording star events and updating Highs',
};

/** Columns of a result-sheet row (heavy lineage and diagnostics stay in the trace). */
const LIST_COLUMNS = [
  'batchId',
  'cmcId',
  'symbol',
  'name',
  'slug',
  'rank',
  'ageDays',
  'priceUsd',
  'capUsd',
  'volume24hUsd',
  'observedAt',
  'crawledAt',
  'currentStatus',
  'currentReason',
  'currentVmc',
  'vmc3dAvg',
  'vmc7dAvg',
  'vmc14dAvg',
  'vmc30dAvg',
  'avg3dReason',
  'avg7dReason',
  'avg14dReason',
  'avg30dReason',
  'multiple3d',
  'multiple7d',
  'multiple30d',
  'pass3d',
  'pass7d',
  'pass30d',
  'reason3d',
  'reason7d',
  'reason30d',
  'stars',
  'eligibilityStatus',
  'eligibilityReasons',
  'assetClass',
  'classSource',
  'lbankStatus',
  'lbankReason',
  'lbankPairs',
  'venueReview',
  'venueFlags',
  'flags',
  'inQueue',
  'queueOrder',
] as const;

/** LIKE pattern for a literal substring (Postgres' default escape character is the backslash). */
const likeContains = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
/** A search term that can be a CMC id (an `integer` column). */
const asCmcId = (s: string) =>
  /^\d{1,10}$/.test(s) && Number(s) <= 2_147_483_647 ? Number(s) : null;
/** Drop the surrogate key that TypeORM selects for hydration but the API never exposed. */
const withoutId = <T extends { id?: unknown }>({ id: _id, ...rest }: T) => rest;

/**
 * Read-only queries shared by the dashboard API, the MCP server, Telegram and the CLI.
 * PostgreSQL is the source of truth; nothing here writes.
 */
@Injectable()
export class ReadModelService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  get providerId() {
    return this.cfg.DATA_SOURCE;
  }

  private repo<T extends ObjectLiteral>(entity: EntityTarget<T>) {
    return this.db.getRepository(entity);
  }

  /** The configured data source's provider row (name, live flag, attribution), or null before its first run. */
  provider(): Promise<Provider | null> {
    return this.repo(Provider).findOneBy({ id: this.providerId });
  }

  /** Batch of the newest successful scan (results exist), or null. */
  async latestScanBatchId(): Promise<string | null> {
    const r = await this.repo(ScanRun).findOne({
      where: { providerId: this.providerId, status: 'succeeded' },
      order: { asOf: 'DESC' },
      select: { batchId: true },
    });
    return r?.batchId ?? null;
  }

  /** Coins of one scanned batch whose symbol matches case-insensitively (exact), lowest rank first. */
  async findBySymbol(
    batchId: string,
    symbol: string,
    limit: number,
  ): Promise<Array<{ cmcId: number; symbol: string; name: string }>> {
    const rows = await this.repo(ScanResult)
      .createQueryBuilder('r')
      .select(['r.id', 'r.cmcId', 'r.symbol', 'r.name'])
      .where('r.batch_id = :batchId', { batchId })
      .andWhere('lower(r.symbol) = lower(:symbol)', { symbol })
      .orderBy('r.rank', 'ASC', 'NULLS LAST')
      .addOrderBy('r.cmc_id', 'ASC')
      .limit(limit)
      .getMany();
    return rows.map((r) => ({ cmcId: r.cmcId, symbol: r.symbol, name: r.name }));
  }

  async listAssets(q: { search?: string; limit: number; offset: number }) {
    const providerId = this.providerId;
    const search = q.search?.trim();
    const cmcId = search ? asCmcId(search) : null;
    const where: FindOptionsWhere<CmcAsset> | Array<FindOptionsWhere<CmcAsset>> = search
      ? [
          { providerId, symbol: Like(likeContains(search.toUpperCase())) },
          { providerId, name: ILike(likeContains(search)) },
          ...(cmcId !== null ? [{ providerId, cmcId }] : []),
        ]
      : { providerId };
    const assets = this.repo(CmcAsset);
    const [total, rows] = await Promise.all([
      assets.count({ where }),
      assets.find({ where, order: { symbol: 'ASC', cmcId: 'ASC' }, take: q.limit, skip: q.offset }),
    ]);
    return plain<Record<string, unknown>>({ total, offset: q.offset, assets: rows });
  }

  async coverage() {
    const providerId = this.providerId;
    const [provider, lastBatch, lastDiscovery, health, assetCount] = await Promise.all([
      this.repo(Provider).findOneBy({ id: providerId }),
      this.repo(CrawlBatch).findOne({ where: { providerId }, order: { slotTime: 'DESC' } }),
      this.repo(DiscoveryRun).findOne({ where: { providerId }, order: { startedAt: 'DESC' } }),
      this.repo(SourceHealth).findOneBy({ providerId }),
      this.repo(CmcAsset).countBy({ providerId }),
    ]);
    return plain<Record<string, unknown>>({
      provider,
      isLiveData: provider?.isLive ?? false,
      knownAssets: assetCount,
      lastDiscovery,
      lastBatch,
      sourceHealth: health,
      monthlyRequestBudget:
        providerId === 'coinmarketcap_web'
          ? this.cfg.CMC_WEB_MONTHLY_REQUEST_BUDGET
          : providerId === 'fixture'
            ? null
            : this.cfg.SOURCE_MONTHLY_REQUEST_BUDGET,
    });
  }

  /** Stored hourly observations of one CMC id (raw crawler records). */
  async snapshots(cmcId: number, hours: number) {
    const providerId = this.providerId;
    const snapshots = this.repo(MarketSnapshot);
    const latest = await snapshots.findOne({
      where: { providerId, providerAssetId: String(cmcId) },
      order: { slotTime: 'DESC' },
      select: { id: true, slotTime: true },
    });
    if (!latest) return plain<Record<string, unknown>>({ cmcId, snapshots: [] });
    const rows = await snapshots.find({
      where: {
        providerId,
        providerAssetId: String(cmcId),
        slotTime: MoreThan(new Date(latest.slotTime.getTime() - hours * 3_600_000)),
      },
      order: { slotTime: 'ASC' },
      select: {
        id: true,
        slotTime: true,
        collectedAt: true,
        observedAt: true,
        price: true,
        marketCap: true,
        marketCapProvenance: true,
        volumeRolling24h: true,
        rank: true,
        dateAdded: true,
        tags: true,
        qualityFlags: true,
        isStale: true,
        nullReasons: true,
      },
    });
    return plain<Record<string, unknown>>({ cmcId, snapshots: rows.map(withoutId) });
  }

  /** Pipeline runs, newest first, each with its stage records. */
  async runs(limit: number) {
    const rows = await this.repo(PipelineRun).find({
      where: { providerId: this.providerId },
      order: { slotTime: 'DESC' },
      take: limit,
    });
    const stages = rows.length
      ? await this.repo(PipelineStage).find({
          where: { runId: In(rows.map((r) => r.id)) },
          order: { startedAt: 'ASC' },
        })
      : [];
    return plain<Array<Record<string, unknown>>>(
      rows.map((r) => ({ ...r, stages: stages.filter((s) => s.runId === r.id) })),
    );
  }

  async deliveries(limit: number) {
    const rows = await this.repo(TelegramDelivery)
      .createQueryBuilder('d')
      .innerJoin(PipelineRun, 'r', 'r.id = d.run_id')
      .where('r.provider_id = :providerId', { providerId: this.providerId })
      .orderBy('d.created_at', 'DESC')
      .limit(limit)
      .getMany();
    return plain<Array<Record<string, unknown>>>(
      rows.map((d) => ({
        id: d.id,
        runId: d.runId,
        partIndex: d.partIndex,
        partCount: d.partCount,
        mode: d.mode,
        status: d.status,
        attempts: d.attempts,
        lastError: d.lastError,
        createdAt: d.createdAt,
        sentAt: d.sentAt,
        text: d.text,
      })),
    );
  }

  /**
   * Dashboard overview: progress of the newest pipeline run, the newest crawl batch and scan, the
   * last valid export and a failure banner when the newest analysis did not complete (PDF p.18).
   */
  async overview() {
    const providerId = this.providerId;
    const scans = this.repo(ScanRun);
    const [provider, latestRun, latestBatch, latestScan, lastGood, lastExport, health] =
      await Promise.all([
        this.repo(Provider).findOneBy({ id: providerId }),
        this.repo(PipelineRun).findOne({
          where: { providerId },
          order: { slotTime: 'DESC', startedAt: 'DESC' },
        }),
        this.repo(CrawlBatch).findOne({ where: { providerId }, order: { slotTime: 'DESC' } }),
        scans.findOne({ where: { providerId }, order: { asOf: 'DESC' } }),
        scans.findOne({ where: { providerId, status: 'succeeded' }, order: { asOf: 'DESC' } }),
        scans.findOne({
          where: { providerId, exportStatus: 'succeeded' },
          order: { exportedAt: 'DESC' },
        }),
        this.repo(SourceHealth).findOneBy({ providerId }),
      ]);
    const stages = latestRun
      ? await this.repo(PipelineStage).find({
          where: { runId: latestRun.id },
          order: { startedAt: 'ASC' },
        })
      : [];
    const lease =
      latestRun?.status === 'running'
        ? await this.repo(JobLease).findOneBy({ name: PIPELINE_LEASE_NAME })
        : null;
    const interrupted = latestRun?.status === 'running' && (!lease || lease.expiresAt < new Date());
    const banners: string[] = [];
    if (latestBatch?.status === 'FAILED')
      banners.push(
        `The latest crawl batch (${latestBatch.slotTime.toISOString()}) failed; results below come from an earlier batch.`,
      );
    if (latestScan && latestScan.status === 'failed')
      banners.push(
        `The latest analysis failed (${latestScan.error ?? 'see Batches'}); the last valid export remains ${lastExport ? `batch ${lastExport.batchId.slice(0, 8)}` : 'unavailable'}.`,
      );
    if (latestScan && latestScan.status === 'succeeded' && latestScan.exportStatus === 'failed')
      banners.push(
        `Export of the latest batch failed; the previous export (${lastExport ? lastExport.batchId.slice(0, 8) : 'none'}) is still the latest valid file.`,
      );
    const crawlAgeMinutes = latestBatch
      ? Math.round((Date.now() - latestBatch.crawledAt.getTime()) / 60_000)
      : null;
    if (crawlAgeMinutes !== null && crawlAgeMinutes > this.cfg.MAX_QUOTE_AGE_MINUTES)
      banners.push(
        `The newest crawl batch is ${crawlAgeMinutes} minutes old (older than ${this.cfg.MAX_QUOTE_AGE_MINUTES}); collection may have stopped.`,
      );
    const metrics = latestRun?.metrics as Record<string, unknown> | null | undefined;
    return plain<Record<string, unknown>>({
      provider: provider
        ? {
            id: provider.id,
            name: provider.name,
            isLive: provider.isLive,
            attribution: provider.attribution,
          }
        : null,
      isLiveData: provider?.isLive ?? false,
      latestRun: latestRun
        ? {
            id: latestRun.id,
            kind: latestRun.kind,
            slotTime: latestRun.slotTime,
            status: interrupted ? 'interrupted' : latestRun.status,
            currentStage: latestRun.currentStage,
            currentStageLabel: latestRun.currentStage
              ? (STAGE_LABELS[latestRun.currentStage] ?? latestRun.currentStage)
              : null,
            startedAt: latestRun.startedAt,
            finishedAt: latestRun.finishedAt,
            stages,
            metrics: latestRun.metrics,
            error: latestRun.error,
            progress:
              latestRun.status === 'running' && !interrupted
                ? runProgress({
                    stages,
                    currentStage: latestRun.currentStage,
                    progress: metrics?.progress,
                    now: new Date(),
                  })
                : null,
          }
        : null,
      schedule: {
        enabled: this.cfg.SCHEDULER_ENABLED,
        cron: this.cfg.PIPELINE_CRON,
        nextRunAt: this.cfg.SCHEDULER_ENABLED ? nextCronRun(this.cfg.PIPELINE_CRON) : null,
      },
      latestBatch,
      scan: lastGood
        ? {
            batchId: lastGood.batchId,
            asOf: lastGood.asOf,
            finishedAt: lastGood.finishedAt,
            queueStatus: lastGood.queueStatus,
            counts: lastGood.counts,
            warnings: lastGood.warnings,
            rulesetVersion: lastGood.rulesetVersion,
            configVersion: lastGood.configVersion,
            overridesVersion: lastGood.overridesVersion,
          }
        : null,
      latestScanStatus: latestScan
        ? { batchId: latestScan.batchId, status: latestScan.status, error: latestScan.error }
        : null,
      export: lastExport
        ? {
            batchId: lastExport.batchId,
            exportedAt: lastExport.exportedAt,
            files: lastExport.exportFiles,
          }
        : null,
      crawlAgeMinutes,
      maxQuoteAgeMinutes: this.cfg.MAX_QUOTE_AGE_MINUTES,
      sourceHealth: health
        ? {
            state: health.state,
            consecutiveFailures: health.consecutiveFailures,
            openedAt: health.openedAt,
            reopensAt:
              health.state === 'open' && health.openedAt
                ? new Date(health.openedAt.getTime() + DEFAULT_OPEN_COOLDOWN_MS)
                : null,
            retryAfterUntil: health.retryAfterUntil,
            suspendedReason: health.suspendedReason,
          }
        : null,
      banners,
      openMappingTasks: await this.repo(VenueMappingTask).countBy({ providerId, status: 'OPEN' }),
    });
  }

  /** Rows of one result sheet (PDF p.17 sheets), with each asset's latest human review. */
  async scanSheet(q: {
    sheet: Sheet;
    batchId?: string;
    search?: string;
    limit: number;
    offset: number;
  }) {
    const batchId = q.batchId ?? (await this.latestScanBatchId());
    if (!batchId) return plain<Record<string, unknown>>({ batchId: null, total: 0, rows: [] });
    const base = this.repo(ScanResult)
      .createQueryBuilder('r')
      .where('r.batch_id = :batchId', { batchId });
    if (q.sheet === 'queue') base.andWhere('r.in_queue = true');
    else if (q.sheet === 'eligible') base.andWhere("r.eligibility_status = 'ELIGIBLE'");
    else if (q.sheet === 'needs_review') base.andWhere("r.eligibility_status = 'NEEDS_REVIEW'");
    else if (q.sheet === 'excluded') base.andWhere("r.eligibility_status = 'EXCLUDED'");
    const search = q.search?.trim();
    if (search) {
      const cmcId = asCmcId(search);
      base.andWhere(
        new Brackets((w) => {
          w.where('r.symbol LIKE :symbol', { symbol: likeContains(search.toUpperCase()) }).orWhere(
            'r.name ILIKE :name',
            { name: likeContains(search) },
          );
          if (cmcId !== null) w.orWhere('r.cmc_id = :cmcId', { cmcId });
        }),
      );
    }
    const page = base.clone().select(['r.id', ...LIST_COLUMNS.map((c) => `r.${c}`)]);
    this.sheetOrder(page, q.sheet);
    const [total, rows, run] = await Promise.all([
      base.getCount(),
      page.offset(q.offset).limit(q.limit).getMany(),
      this.repo(ScanRun).findOne({
        where: { batchId },
        select: { batchId: true, asOf: true, queueStatus: true, isLive: true },
      }),
    ]);
    const reviews = await this.latestReviews(rows.map((r) => r.cmcId));
    return plain<Record<string, unknown>>({
      batchId,
      asOf: run?.asOf ?? null,
      queueStatus: run?.queueStatus ?? null,
      isLive: run?.isLive ?? null,
      total,
      offset: q.offset,
      rows: rows.map((r) => ({ ...withoutId(r), review: reviews.get(r.cmcId) ?? null })),
    });
  }

  private sheetOrder(qb: SelectQueryBuilder<ScanResult>, sheet: Sheet) {
    if (sheet === 'queue') qb.orderBy('r.queue_order', 'ASC', 'NULLS LAST');
    else if (sheet === 'excluded')
      qb.orderBy('r.rank', 'ASC', 'NULLS LAST').addOrderBy('r.cmc_id', 'ASC');
    else
      qb.orderBy('r.in_queue', 'DESC')
        .addOrderBy('r.queue_order', 'ASC', 'NULLS LAST')
        .addOrderBy('r.stars', 'DESC')
        .addOrderBy('r.cmc_id', 'ASC');
  }

  private async latestReviews(cmcIds: number[]) {
    if (!cmcIds.length) return new Map<number, Record<string, unknown>>();
    const rows = await this.repo(Review).find({
      where: { providerId: this.providerId, cmcId: In(cmcIds) },
      order: { reviewedAt: 'DESC' },
      select: {
        id: true,
        cmcId: true,
        batchId: true,
        revision: true,
        reviewer: true,
        reviewedAt: true,
        venueDecision: true,
        eventDay: true,
        finalDecision: true,
        planStatus: true,
      },
    });
    const out = new Map<number, Record<string, unknown>>();
    for (const r of rows) if (!out.has(r.cmcId)) out.set(r.cmcId, { ...r });
    return out;
  }

  /**
   * Full calculation trace for one CMC id in one batch (PDF p.20 #2): the current observation, the
   * 30 completed daily rows actually used (exact revisions), every window, comparison, eligibility
   * reason, LBank and venue evidence, decisions, tasks and the review history.
   */
  async assetTrace(cmcId: number, batchId?: string) {
    const results = this.repo(ScanResult);
    let record: ScanResult | null;
    if (batchId) record = await results.findOneBy({ batchId, cmcId });
    else {
      const latest = await this.latestScanBatchId();
      record = await results.findOne({
        where: { providerId: this.providerId, cmcId, ...(latest ? { batchId: latest } : {}) },
        order: { crawledAt: 'DESC' },
      });
    }
    if (!record) return null;
    const providerId = record.providerId;
    const batch = await this.repo(CrawlBatch).findOneByOrFail({ id: record.batchId });
    const asOfDate = isoDate(batch.crawledAt);
    const lineage = record.dailyWindow;
    const usedIds = (lineage?.revisionIds ?? []).filter((x): x is number => x !== null);
    const [
      snapshot,
      asset,
      changes,
      revisionsUsed,
      effective,
      decisions,
      tasks,
      reviews,
      run,
      markets,
    ] = await Promise.all([
      this.repo(MarketSnapshot).findOneBy({
        providerId,
        providerAssetId: String(cmcId),
        slotTime: batch.slotTime,
      }),
      this.repo(CmcAsset).findOneBy({ providerId, cmcId }),
      this.repo(CmcAssetChange).find({
        where: { providerId, cmcId },
        order: { observedAt: 'DESC' },
        take: 20,
      }),
      usedIds.length
        ? this.repo(DailyMetricRevision).findBy({ id: In(usedIds) })
        : Promise.resolve([]),
      this.repo(DailyMetric).find({
        where: {
          providerId,
          cmcId,
          dateUtc: And(
            MoreThanOrEqual(addDays(asOfDate, -this.cfg.TIER1_DAILY_LOOKBACK_DAYS)),
            LessThan(asOfDate),
          ),
        },
        order: { dateUtc: 'DESC' },
      }),
      this.repo(VenueDecision).find({ where: { providerId, cmcId }, order: { decidedAt: 'DESC' } }),
      this.repo(VenueMappingTask).find({
        where: { providerId, cmcId },
        order: { updatedAt: 'DESC' },
      }),
      this.repo(Review).find({
        where: { providerId, cmcId },
        order: { reviewedAt: 'DESC', revision: 'DESC' },
      }),
      this.repo(ScanRun).findOneBy({ batchId: record.batchId }),
      this.repo(VenueCrawl).findOne({
        where: { providerId, kind: 'asset_markets', cmcId },
        order: { finishedAt: 'DESC' },
      }),
    ]);
    const lbankCrawl = run?.lbankCrawlId
      ? await this.repo(VenueCrawl).findOne({
          where: { id: run.lbankCrawlId },
          select: {
            id: true,
            status: true,
            finishedAt: true,
            fetchedCount: true,
            expectedCount: true,
            source: true,
            notes: true,
          },
        })
      : null;
    const used = new Map(revisionsUsed.map((r) => [String(r.id), r]));
    const effByDate = new Map(effective.map((e) => [e.dateUtc, e]));
    const dailyUsed = (lineage?.dates ?? []).map((date, i) => {
      const id = lineage?.revisionIds[i];
      const r = id !== null && id !== undefined ? used.get(String(id)) : undefined;
      const eff = effByDate.get(date);
      const ratio =
        r && r.valid && r.volumeUsd && r.marketCapUsd && !r.marketCapUsd.isZero()
          ? new D(r.volumeUsd.toString()).div(r.marketCapUsd.toString())
          : null;
      return {
        dateUtc: date,
        daysAgo: i + 1,
        revisionId: id ?? null,
        revision: r?.revision ?? null,
        volumeUsd: r?.volumeUsd?.toString() ?? null,
        marketCapUsd: r?.marketCapUsd?.toString() ?? null,
        closeUsd: r?.closeUsd?.toString() ?? null,
        // Shown at the stored precision of the means and multiples (the scan itself compares unrounded values).
        vmc: ratio?.toDecimalPlaces(STORE_DP).toFixed() ?? null,
        valid: r ? r.valid : null,
        invalidReasons:
          r?.invalidReasons ??
          (lineage?.missingDates.includes(date) ? ['no row stored for this completed day'] : []),
        sourceCloseAt: r?.sourceCloseAt ?? null,
        retrievedAt: r?.retrievedAt ?? null,
        source: r?.source ?? null,
        revisedSinceScan: !!(
          eff &&
          id !== null &&
          id !== undefined &&
          String(eff.revisionId) !== String(id)
        ),
      };
    });
    const fmt = (v: { toString(): string } | null) =>
      v === null ? null : new D(v.toString()).toFixed();
    const field = (key: string) => (record as unknown as Record<string, unknown>)[key];
    const windows = RULES.windows.map((n) => {
      const mean = field(`vmc${n}dAvg`) as { toString(): string } | null;
      const reason = field(`avg${n}dReason`) as string | null;
      const rows = dailyUsed.slice(0, n);
      const pass =
        n === 14
          ? null
          : {
              multiple: fmt(field(`multiple${n}d`) as { toString(): string } | null),
              status: field(`pass${n}d`),
              reason: field(`reason${n}d`),
            };
      return {
        days: n,
        role:
          n === 14
            ? 'context only (no pass/fail, no star, no queue gate)'
            : 'compared with the current VMC',
        dates: rows.map((r) => r.dateUtc),
        mean: fmt(mean),
        reason,
        formula:
          mean !== null && rows.every((r) => r.vmc !== null)
            ? `mean_${n}d = (${rows.map((r) => r.vmc).join(' + ')}) / ${n} = ${fmt(mean)}`
            : `mean_${n}d = N/A (${reason ?? 'not evaluated'})`,
        comparison:
          pass && record.currentVmc && mean && pass.status !== 'N/A'
            ? `${fmt(record.currentVmc)} / ${fmt(mean)} = ${pass.multiple} → ${pass.status} (YES iff ≥ ${RULES.passMultiple})`
            : pass
              ? `N/A (${pass.reason ?? '—'})`
              : null,
        pass,
      };
    });
    return plain<Record<string, unknown>>({
      record,
      batch,
      scanRun: run
        ? {
            status: run.status,
            queueStatus: run.queueStatus,
            rulesetVersion: run.rulesetVersion,
            configVersion: run.configVersion,
            overridesVersion: run.overridesVersion,
            warnings: run.warnings,
          }
        : null,
      asset,
      metadataChanges: changes,
      current: {
        label: `rolling 24h, observed at ${record.observedAt ? record.observedAt.toISOString() : 'unknown'} (provider update time); crawled at ${record.crawledAt.toISOString()}`,
        formula: record.currentVmc
          ? `current_vmc = volume_24h / market_cap = ${fmt(record.volume24hUsd)} / ${fmt(record.capUsd)} = ${fmt(record.currentVmc)} (${new D(record.currentVmc.toString()).times(100).toDecimalPlaces(4).toFixed()} %)`
          : `current_vmc = N/A (${record.currentReason ?? record.currentStatus})`,
        status: record.currentStatus,
        reason: record.currentReason,
        snapshot,
      },
      daily: {
        asOfDate,
        latestCompletedDate: addDays(asOfDate, -1),
        used: dailyUsed,
        effectiveNow: effective,
      },
      windows,
      eligibility: {
        status: record.eligibilityStatus,
        reasons: record.eligibilityReasons,
        assetClass: record.assetClass,
        classSource: record.classSource,
        rules: {
          rank: `${RULES.rankMin}–${RULES.rankMax}`,
          minMarketCapUsd: RULES.minMarketCapUsd,
          minListingAgeDays: 60,
        },
      },
      lbank: {
        status: record.lbankStatus,
        reason: record.lbankReason,
        pairs: record.lbankPairs,
        crawl: lbankCrawl,
        decisions: decisions.filter((d) => d.exchange === 'lbank'),
        tasks,
      },
      venues: {
        review: record.venueReview,
        flags: record.venueFlags,
        summary: (record.diagnostics as { venue?: unknown } | null)?.venue ?? null,
        crawl: markets
          ? {
              id: markets.id,
              status: markets.status,
              finishedAt: markets.finishedAt,
              expectedCount: markets.expectedCount,
              fetchedCount: markets.fetchedCount,
              pairs: markets.pairs,
              notes: markets.notes,
            }
          : null,
      },
      reviews,
    });
  }

  async batches(limit: number) {
    const rows = await this.repo(CrawlBatch).find({
      where: { providerId: this.providerId },
      order: { slotTime: 'DESC' },
      take: limit,
    });
    const runs = new Map(
      (rows.length
        ? await this.repo(ScanRun).findBy({ batchId: In(rows.map((r) => r.id)) })
        : []
      ).map((r) => [r.batchId, r]),
    );
    return plain<Array<Record<string, unknown>>>(
      rows.map((b) => {
        const r = runs.get(b.id);
        return {
          ...b,
          scan: r
            ? {
                status: r.status,
                queueStatus: r.queueStatus,
                counts: r.counts,
                warnings: r.warnings,
                attempts: r.attempts,
                finishedAt: r.finishedAt,
                exportStatus: r.exportStatus,
                exportedAt: r.exportedAt,
                error: r.error,
              }
            : null,
        };
      }),
    );
  }

  async exportsList(limit: number) {
    const rows = await this.repo(ScanRun).find({
      where: { providerId: this.providerId, exportStatus: Not(IsNull()) },
      order: { asOf: 'DESC' },
      take: limit,
      select: {
        batchId: true,
        asOf: true,
        isLive: true,
        queueStatus: true,
        exportStatus: true,
        exportPath: true,
        exportFiles: true,
        exportedAt: true,
        error: true,
      },
    });
    return plain<Array<Record<string, unknown>>>(
      rows.map((r) => ({
        ...r,
        exportPath: r.exportPath
          ? r.exportPath.replace(resolve(this.cfg.TIER1_EXPORT_DIR), this.cfg.TIER1_EXPORT_DIR)
          : null,
        available: !!r.exportPath && existsSync(r.exportPath),
      })),
    );
  }

  /** Absolute path of one exported file of a batch, only if it is listed in that export. */
  async exportFile(batchId: string, name: string): Promise<string | null> {
    const run = await this.repo(ScanRun).findOne({
      where: { batchId },
      select: { batchId: true, exportPath: true, exportFiles: true },
    });
    if (!run?.exportPath) return null;
    const files = (run.exportFiles ?? []).map((f) => f.name).concat('manifest.json');
    if (!files.includes(name)) return null;
    const root = resolve(this.cfg.TIER1_EXPORT_DIR);
    const full = resolve(join(run.exportPath, name));
    if (!full.startsWith(root + sep) || !existsSync(full)) return null;
    return full;
  }

  async mappingTasks(status: 'OPEN' | 'RESOLVED' | 'ALL', limit: number) {
    const rows = await this.repo(VenueMappingTask).find({
      where: { providerId: this.providerId, ...(status === 'ALL' ? {} : { status }) },
      order: { updatedAt: 'DESC' },
      take: limit,
    });
    return plain<Array<Record<string, unknown>>>(rows);
  }
}
