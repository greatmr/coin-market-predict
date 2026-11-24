import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { DataSource } from 'typeorm';

import { type Cell, toCsv } from '../../common/files/csv.js';
import { redact } from '../../common/security/redact.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { CrawlBatch } from '../ingestion/entities/crawl-batch.entity.js';
import { Review } from '../reviews/entities/review.entity.js';
import { ScanResult } from '../scan/entities/scan-result.entity.js';
import { ScanRun } from '../scan/entities/scan-run.entity.js';
import { RANKING_RULESET_VERSION } from '../strategy/index.js';

/** Mandatory export columns, in PDF p.17 order. */
export const MANDATORY_COLUMNS = [
  'crawl_batch_id',
  'observed_at_utc',
  'cmc_id',
  'symbol',
  'name',
  'rank',
  'age_days',
  'price_usd',
  'cap_usd',
  'volume_24h_usd',
  'current_vmc',
  'vmc_3d_avg',
  'vmc_7d_avg',
  'vmc_14d_avg',
  'vmc_30d_avg',
  'multiple_3d',
  'multiple_7d',
  'multiple_30d',
  'pass_3d',
  'pass_7d',
  'pass_30d',
  'stars',
  'eligibility_status',
  'lbank_pairs',
  'venue_review',
  'event_day',
  'flags',
  'source_updated_at',
] as const;

/** Reason codes, raw evidence and lineage after the mandatory columns. */
export const EXTRA_COLUMNS = [
  'current_status',
  'current_reason',
  'reason_3d',
  'reason_7d',
  'reason_30d',
  'avg_3d_reason',
  'avg_7d_reason',
  'avg_14d_reason',
  'avg_30d_reason',
  'eligibility_reasons',
  'asset_class',
  'class_source',
  'lbank_status',
  'lbank_reason',
  'queue_order',
  'weighted_pass_points',
  'score_complete',
  'weighted_strength',
  'ranking_ruleset_version',
  'venue_flags',
  'vol_3d_avg',
  'vol_7d_avg',
  'vol_14d_avg',
  'vol_30d_avg',
  'vol_ratio_24h_3d',
  'vol_ratio_24h_7d',
  'vol_ratio_24h_14d',
  'vol_ratio_24h_30d',
  'quote_age_seconds',
  'slug',
  'date_added',
  'reviewer',
  'reviewed_at_utc',
  'final_decision',
  'scan_computed_at_utc',
  'inputs_hash',
  'ruleset_version',
  'config_version',
  'data_label',
] as const;

/**
 * Since D4 (ADR-0008) only the Review Queue is stored, so it is the only per-coin sheet; every
 * other coin is summarized in Run_Metadata (counts by status and reason).
 */
export const SHEETS = ['Review_Queue', 'Run_Metadata'] as const;

export interface ExportFile {
  name: string;
  rows: number;
  bytes: number;
  sha256: string;
}

export interface ExportResult {
  status: 'succeeded' | 'failed';
  path: string | null;
  files: ExportFile[];
  error?: string;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const s = (v: { toString(): string } | null | undefined) =>
  v === null || v === undefined ? null : v.toString();

/**
 * CSV per sheet + a SHA-256 manifest for one crawl batch (PDF p.17, p.18; since D4 the Review
 * Queue and the run metadata only).
 * Files are written to a temporary directory and renamed into place, so a failed export never
 * replaces a valid earlier one; the database keeps the full history either way.
 */
@Injectable()
export class ExportService {
  private readonly log = new Logger(ExportService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  get root() {
    return resolve(this.cfg.TIER1_EXPORT_DIR);
  }

  /** Rows for every sheet of a batch, with the batch's own review decisions (or PENDING / UNKNOWN). */
  async sheets(batchId: string) {
    const [run, batch, results, reviews] = await Promise.all([
      this.db.getRepository(ScanRun).findOneByOrFail({ batchId }),
      this.db.getRepository(CrawlBatch).findOneByOrFail({ id: batchId }),
      this.db
        .getRepository(ScanResult)
        .find({ where: { batchId, inQueue: true }, order: { queueOrder: 'ASC', cmcId: 'ASC' } }),
      this.db
        .getRepository(Review)
        .find({ where: { batchId }, order: { cmcId: 'ASC', revision: 'DESC' } }),
    ]);
    const latestReview = new Map<number, (typeof reviews)[number]>();
    for (const r of reviews) if (!latestReview.has(r.cmcId)) latestReview.set(r.cmcId, r);
    const label = batch.isLive ? 'LIVE' : 'SYNTHETIC';
    const toRow = (r: ScanResult): Cell[] => {
      const rv = latestReview.get(r.cmcId);
      const d = (r.diagnostics ?? {}) as {
        quoteAgeSeconds?: number | null;
        volumeAvg?: Record<string, string | null>;
        volumeRatio24h?: Record<string, string | null>;
      };
      const pairs = (
        (r.lbankPairs ?? []) as Array<{ marketPair: string; mapping: string; trading: string }>
      ).map((p) =>
        `${p.marketPair}[${p.mapping === 'OK' ? '' : `${p.mapping} `}${p.trading}]`.replace(
          '[ ',
          '[',
        ),
      );
      return [
        r.batchId,
        iso(r.crawledAt),
        r.cmcId,
        r.symbol,
        r.name,
        r.rank,
        s(r.ageDays),
        s(r.priceUsd),
        s(r.capUsd),
        s(r.volume24hUsd),
        s(r.currentVmc),
        s(r.vmc3dAvg),
        s(r.vmc7dAvg),
        s(r.vmc14dAvg),
        s(r.vmc30dAvg),
        s(r.multiple3d),
        s(r.multiple7d),
        s(r.multiple30d),
        r.pass3d,
        r.pass7d,
        r.pass30d,
        r.stars,
        r.eligibilityStatus,
        pairs.join('; '),
        rv?.venueDecision ?? r.venueReview,
        rv?.eventDay ?? 'UNKNOWN',
        [...r.flags, ...r.venueFlags].join('; '),
        iso(r.observedAt),
        r.currentStatus,
        r.currentReason,
        r.reason3d,
        r.reason7d,
        r.reason30d,
        r.avg3dReason,
        r.avg7dReason,
        r.avg14dReason,
        r.avg30dReason,
        r.eligibilityReasons.join('; '),
        r.assetClass,
        r.classSource,
        r.lbankStatus,
        r.lbankReason,
        r.queueOrder,
        r.weightedPassPoints,
        r.scoreComplete === null ? null : r.scoreComplete ? 'TRUE' : 'FALSE',
        s(r.weightedStrength),
        r.rankingRulesetVersion,
        r.venueFlags.join('; '),
        d.volumeAvg?.['3'] ?? null,
        d.volumeAvg?.['7'] ?? null,
        d.volumeAvg?.['14'] ?? null,
        d.volumeAvg?.['30'] ?? null,
        d.volumeRatio24h?.['3'] ?? null,
        d.volumeRatio24h?.['7'] ?? null,
        d.volumeRatio24h?.['14'] ?? null,
        d.volumeRatio24h?.['30'] ?? null,
        d.quoteAgeSeconds ?? null,
        r.slug,
        iso(r.dateAdded),
        rv?.reviewer ?? null,
        iso(rv?.reviewedAt),
        rv?.finalDecision ?? null,
        iso(r.computedAt),
        r.inputsHash,
        r.rulesetVersion,
        r.configVersion,
        label,
      ];
    };
    const header = [...MANDATORY_COLUMNS, ...EXTRA_COLUMNS] as string[];
    const queue = [...results].sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0));
    const counts = (run.counts ?? {}) as Record<string, unknown>;
    const stars = (counts.stars ?? {}) as Record<string, number>;
    const meta: Cell[][] = [
      ['data_label', label],
      ['crawl_batch_id', batch.id],
      ['provider', batch.providerId],
      ['slot_time_utc', iso(batch.slotTime)],
      ['crawled_at_utc', iso(batch.crawledAt)],
      ['source_updated_min_utc', iso(batch.sourceUpdatedMin)],
      ['source_updated_max_utc', iso(batch.sourceUpdatedMax)],
      ['batch_status', batch.status],
      ['batch_status_reasons', batch.statusReasons.join('; ')],
      ['listed_total', batch.listedTotal],
      ['collected', batch.collected],
      ['stored_snapshots_rank_1_1200', batch.stored ?? batch.collected],
      ['field_counts_stored', JSON.stringify(batch.fieldCounts)],
      ['missing_ranks_1_1200', batch.missingRanks.length],
      ['duplicate_ranks_1_1200', batch.duplicateRanks.length],
      ['scan_status', run.status],
      ['scan_started_utc', iso(run.startedAt)],
      ['scan_finished_utc', iso(run.finishedAt)],
      ['scan_attempts', run.attempts],
      ['ruleset_version', run.rulesetVersion],
      ['ranking_ruleset_version', run.rankingRulesetVersion],
      [
        'queue_order_rule',
        run.rankingRulesetVersion === null
          ? 'pass_3d, pass_7d, pass_30d (YES < NO < N/A); multiple_3d desc; cmc_id asc (scanned before weighted_star_v1)'
          : run.rankingRulesetVersion === RANKING_RULESET_VERSION
            ? 'stars desc; weighted_pass_points desc (3d 60, 7d 25, 30d 15 per YES); complete score first; weighted_strength desc (multiples capped at 3.0, 0.60/0.25/0.15), NULL last; multiple_3d desc, NULL last; cmc_id asc'
            : `ranking ${run.rankingRulesetVersion}`,
      ],
      ['config_version', run.configVersion],
      ['overrides_version', run.overridesVersion],
      ['max_quote_age_minutes', this.cfg.MAX_QUOTE_AGE_MINUTES],
      ['queue_status', run.queueStatus],
      ['assets', counts.assets as number],
      ['screened_rank_1_1200', (counts.screened ?? counts.assets) as number],
      ['outside_rank_1_1200_not_stored', (counts.outsideUniverse ?? 0) as number],
      ['eligible', counts.eligible as number],
      ['eligible_zero_star', (stars['0'] ?? 0) as number],
      ['needs_review_not_evaluated', counts.needsReview as number],
      ['excluded', counts.excluded as number],
      ['review_queue', counts.queue as number],
      ['exclusion_reasons', JSON.stringify(counts.reasons ?? {})],
      ['stars', JSON.stringify(stars)],
      ['not_available_by_window', JSON.stringify(counts.notAvailable ?? {})],
      ['lbank_crawl', JSON.stringify(counts.lbankCrawl ?? null)],
      ['warnings', run.warnings.join(' | ')],
      ['export_generated_at_utc', new Date().toISOString()],
    ];
    return {
      run,
      batch,
      label,
      header,
      sheets: {
        Review_Queue: queue.map(toRow),
        Run_Metadata: meta,
      },
    };
  }

  async export(batchId: string): Promise<ExportResult> {
    let tmp: string | null = null;
    try {
      const data = await this.sheets(batchId);
      const slot = data.batch.slotTime.toISOString().slice(0, 16).replace(':', '-');
      const dirName = `${slot}Z_${batchId.slice(0, 8)}${data.batch.isLive ? '' : '_SYNTHETIC'}`;
      const finalDir = join(this.root, data.batch.providerId, dirName);
      tmp = `${finalDir}.tmp-${randomUUID().slice(0, 8)}`;
      mkdirSync(tmp, { recursive: true });
      const files: ExportFile[] = [];
      const write = (name: string, content: string | Buffer, rows: number) => {
        writeFileSync(join(tmp!, name), content);
        const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
        files.push({ name, rows, bytes: buf.length, sha256: sha256Buffer(buf) });
      };
      for (const sheet of SHEETS) {
        const rows = data.sheets[sheet];
        write(
          `${sheet.toLowerCase()}.csv`,
          sheet === 'Run_Metadata' ? toCsv(['key', 'value'], rows) : toCsv(data.header, rows),
          rows.length,
        );
      }
      const manifest = {
        batchId,
        providerId: data.batch.providerId,
        dataLabel: data.label,
        slotTime: data.batch.slotTime.toISOString(),
        queueStatus: data.run.queueStatus,
        rulesetVersion: data.run.rulesetVersion,
        configVersion: data.run.configVersion,
        generatedAt: new Date().toISOString(),
        files,
      };
      writeFileSync(join(tmp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      // Replace an earlier export of the same batch only after the new one is complete.
      if (existsSync(finalDir)) {
        const old = `${finalDir}.old-${randomUUID().slice(0, 8)}`;
        renameSync(finalDir, old);
        renameSync(tmp, finalDir);
        rmSync(old, { recursive: true, force: true });
      } else renameSync(tmp, finalDir);
      tmp = null;
      await this.db.getRepository(ScanRun).update(
        { batchId },
        {
          exportStatus: 'succeeded',
          exportPath: finalDir,
          exportFiles: files,
          exportedAt: new Date(),
        },
      );
      this.log.log(`export ${dirName}: ${files.map((f) => `${f.name}(${f.rows})`).join(', ')}`);
      return { status: 'succeeded', path: finalDir, files };
    } catch (err) {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      const error = redact(err).slice(0, 1000);
      await this.db
        .getRepository(ScanRun)
        .update({ batchId }, { exportStatus: 'failed', error })
        .catch(() => undefined);
      this.log.error(`export failed for batch ${batchId}: ${error}`);
      return { status: 'failed', path: null, files: [], error };
    }
  }

  /** Export directories older than EXPORT_RETENTION_DAYS are removed (the database keeps history). */
  prune(now = new Date()): number {
    if (this.cfg.EXPORT_RETENTION_DAYS <= 0 || !existsSync(this.root)) return 0;
    const cutoff = now.getTime() - this.cfg.EXPORT_RETENTION_DAYS * 86_400_000;
    let removed = 0;
    for (const provider of readdirSync(this.root)) {
      const pdir = join(this.root, provider);
      if (!statSync(pdir).isDirectory()) continue;
      for (const d of readdirSync(pdir)) {
        const full = join(pdir, d);
        if (statSync(full).isDirectory() && statSync(full).mtimeMs < cutoff) {
          rmSync(full, { recursive: true, force: true });
          removed++;
        }
      }
    }
    return removed;
  }
}

function sha256Buffer(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}
