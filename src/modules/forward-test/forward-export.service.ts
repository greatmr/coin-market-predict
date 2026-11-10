import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { type Cell, toCsv } from '../../common/files/csv.js';
import { buildXlsx } from '../../common/files/xlsx.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { RETURN_BINS } from './cohort.js';
import {
  FORWARD_NOTICE,
  type ForwardEventRow,
  ForwardReadService,
  VIEW_STATUSES,
} from './forward-read.service.js';

export const EVENT_COLUMNS = [
  'event_id',
  'cmc_id',
  'symbol',
  'name',
  'detected_at_utc',
  'detected_utc_date',
  'detection_hour_utc',
  'star_count',
  'reference_price_usd',
  'source_updated_at_utc',
  'source_batch_id',
  'pass_3d',
  'pass_7d',
  'pass_30d',
  'multiple_3d',
  'multiple_7d',
  'multiple_30d',
  'current_vmc',
  'lbank_pairs',
  'ruleset_version',
  'deadline_168h_utc',
  'evaluation_end_utc',
  'effective_horizon_hours',
  'status',
  'coverage_status',
  'peak_kind',
  'highest_future_high_usd',
  'high_time_utc',
  'high_interval_start_utc',
  'high_interval_end_utc',
  'high_time_precision',
  'peak_return_pct',
  'extension_peak_flag',
  'day0_state',
  'completed_days',
  'covered_days',
  'expected_days',
  'missing_dates',
  'invalid_dates',
  'data_quality',
  'result_version',
  'revision_reason',
  'rules_version',
  'last_update_utc',
  'finalized_at_utc',
  'asset_event_count',
  'overlapping_event_ids',
  'data_label',
] as const;

export const COHORT_COLUMNS = [
  'group',
  'events',
  'distinct_assets',
  'final',
  'incomplete',
  'pending',
  'open',
  'tracking',
  'awaiting_final_day',
  'final_n',
  'mean_peak_return_pct',
  'median_peak_return_pct',
  'p25_peak_return_pct',
  'p75_peak_return_pct',
  'min_peak_return_pct',
  'max_peak_return_pct',
  'assets_with_multiple_events',
  'events_on_repeated_assets',
  'same_asset_overlaps',
  'detection_dates',
  'dates_with_multiple_events',
  'max_events_per_date',
  'horizon_min_hours',
  'horizon_median_hours',
  'horizon_max_hours',
] as const;

const DISTRIBUTION_COLUMNS = ['group', 'distribution', 'bin', 'count'] as const;
const REJECTION_COLUMNS = [
  'rejected_at_utc',
  'batch_id',
  'slot_time_utc',
  'cmc_id',
  'symbol',
  'star_count',
  'reasons',
  'price_usd',
  'source_updated_at_utc',
  'observed_at_utc',
  'current_status',
] as const;

export const FORWARD_SHEETS = [
  'Events_Active',
  'Events_Final',
  'Events_Incomplete',
  'Cohort_Summary',
  'Distributions',
  'Rejected_Triggers',
  'Run_Metadata',
] as const;
export type ForwardSheet = (typeof FORWARD_SHEETS)[number];

/** Columns whose decimal text becomes a numeric workbook cell; the CSV keeps full precision. */
const NUMERIC = new Set<string>([
  'cmc_id',
  'detection_hour_utc',
  'star_count',
  'reference_price_usd',
  'multiple_3d',
  'multiple_7d',
  'multiple_30d',
  'current_vmc',
  'effective_horizon_hours',
  'highest_future_high_usd',
  'peak_return_pct',
  'completed_days',
  'covered_days',
  'expected_days',
  'result_version',
  'asset_event_count',
  ...COHORT_COLUMNS.filter((c) => c !== 'group'),
  'count',
  'price_usd',
]);

export interface ForwardExportFile {
  name: string;
  rows: number;
  bytes: number;
  sha256: string;
}

function eventCells(e: ForwardEventRow, label: string): Cell[] {
  const o = e.outcome;
  return [
    e.eventId,
    e.cmcId,
    e.symbol,
    e.name,
    e.detectedAt,
    e.detectedUtcDate,
    e.detectionHourUtc,
    e.starCount,
    e.referencePriceUsd,
    e.sourceUpdatedAt,
    e.sourceBatchId,
    e.pass3d,
    e.pass7d,
    e.pass30d,
    e.multiple3d,
    e.multiple7d,
    e.multiple30d,
    e.currentVmc,
    e.lbankPairs.join('; '),
    e.rulesetVersion,
    e.deadline168h,
    e.evaluationEnd,
    e.effectiveHorizonHours,
    e.status,
    o?.coverageStatus ?? 'PROVISIONAL',
    o?.peakKind ?? 'NONE',
    o?.peakHighUsd ?? null,
    o?.peakAt ?? null,
    o?.peakPeriodStart ?? null,
    o?.peakPeriodEnd ?? null,
    o?.peakTimePrecision ?? null,
    o?.peakReturnPct ?? null,
    o?.extensionPeakFlag ?? null,
    o?.day0State ?? 'PENDING',
    o?.completedDays ?? 0,
    o?.coveredDays ?? 0,
    o?.expectedDays ?? 8,
    (o?.missingDates ?? []).join('; '),
    (o?.invalidDates ?? []).join('; '),
    e.qualityFlags.join('; '),
    e.resultVersion,
    o?.revisionReason ?? null,
    o?.rulesVersion ?? null,
    e.lastUpdateAt,
    e.finalizedAt,
    e.assetEventCount,
    e.overlappingEventIds.join('; '),
    label,
  ];
}

function xlsxRow(header: readonly string[], row: Cell[]): Array<string | number | null> {
  return row.map((v, i) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') return v;
    return NUMERIC.has(header[i] ?? '') && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  });
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * Event-level export and star-group report (PDF p.9): CSV per sheet, an XLSX workbook and a
 * SHA-256 manifest under `TIER1_EXPORT_DIR/<provider>/<time>Z_forward-test[_SYNTHETIC]/`. Written
 * to a temporary directory and renamed only when complete; pruned with the batch exports after
 * EXPORT_RETENTION_DAYS (the database keeps everything, so it can be regenerated at any time).
 */
@Injectable()
export class ForwardExportService {
  private readonly log = new Logger(ForwardExportService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly read: ForwardReadService,
  ) {}

  async sheets(now = new Date()) {
    const [events, summary, rejections] = await Promise.all([
      this.read.allEvents(),
      this.read.summary(now),
      this.read.rejections(5000, 30),
    ]);
    const label = summary.isLive === false ? 'SYNTHETIC' : 'LIVE';
    const view = (v: keyof typeof VIEW_STATUSES) =>
      events
        .filter((e) => VIEW_STATUSES[v].includes(e.status))
        .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt) || b.starCount - a.starCount)
        .map((e) => eventCells(e, label));
    const groupName = (g: string) => (g === 'all' ? 'all' : `${g}_star`);
    const cohort: Cell[][] = summary.cohort.map((g) => [
      groupName(g.group),
      g.events,
      g.distinctAssets,
      g.final,
      g.incomplete,
      g.pending,
      g.byStatus.OPEN,
      g.byStatus.TRACKING,
      g.byStatus.AWAITING_FINAL_DAY,
      g.finalReturns.n,
      g.finalReturns.mean,
      g.finalReturns.median,
      g.finalReturns.p25,
      g.finalReturns.p75,
      g.finalReturns.min,
      g.finalReturns.max,
      g.correlation.assetsWithMultipleEvents,
      g.correlation.eventsOnRepeatedAssets,
      g.correlation.sameAssetOverlaps,
      g.correlation.detectionDates,
      g.correlation.datesWithMultipleEvents,
      g.correlation.maxEventsPerDate,
      g.horizonHours.min,
      g.horizonHours.median,
      g.horizonHours.max,
    ]);
    const distributions: Cell[][] = summary.cohort.flatMap((g) => [
      ...g.returnDistribution.map((b) => [
        groupName(g.group),
        'peak_return_pct_final',
        b.label,
        b.count,
      ]),
      ...g.detectionHourUtc.map((count, hour) => [
        groupName(g.group),
        'detection_hour_utc',
        String(hour).padStart(2, '0'),
        count,
      ]),
      ...g.horizonHours.bins.map((b) => [
        groupName(g.group),
        'effective_horizon_hours',
        b.label,
        b.count,
      ]),
    ]);
    const rejected: Cell[][] = rejections.map((r) => [
      r.createdAt,
      r.batchId,
      r.slotTime,
      r.cmcId,
      r.symbol,
      r.starCount,
      r.reasons.join('; '),
      (r.observed.price as string | null) ?? null,
      (r.observed.sourceUpdatedAt as string | null) ?? null,
      (r.observed.observedAt as string | null) ?? null,
      (r.observed.currentStatus as string | null) ?? null,
    ]);
    const meta: Cell[][] = [
      ['data_label', label],
      ['provider', summary.providerId],
      ['rules_version', summary.rulesVersion],
      ['horizon_rule', summary.horizon.rule],
      ['metric', 'peak_return_pct = 100 × (peak_high_usd / reference_price_usd − 1), unrounded'],
      ['notice', FORWARD_NOTICE],
      ['primary_aggregates', 'FINAL events only (every included period covered, exact peak)'],
      ['percentiles', 'linear interpolation between order statistics (type 7)'],
      [
        'return_bins',
        `${RETURN_BINS.map((b) => b.label).join(' | ')} (display bins, not thresholds)`,
      ],
      ['events', summary.counts.events],
      ['watchlist_assets', summary.counts.watchlistAssets],
      ...Object.entries(summary.counts.byStatus).map(([k, v]) => [`status_${k}`, v]),
      ['covered_days', summary.coverage.coveredDays],
      ['completed_days', summary.coverage.completedDays],
      ['missing_days', summary.coverage.missingDays],
      ['invalid_days', summary.coverage.invalidDays],
      ['day0_unresolved_events', summary.coverage.day0Unresolved],
      ['last_trigger_utc', summary.lastTrigger?.triggeredAt ?? null],
      ['last_update_utc', summary.lastUpdate?.startedAt ?? null],
      ['last_update_status', summary.lastUpdate?.status ?? null],
      ['last_successful_update_utc', summary.lastSuccessfulUpdate?.finishedAt ?? null],
      ['warnings', summary.warnings.join(' | ')],
      ['export_generated_at_utc', now.toISOString()],
    ];
    return {
      label,
      providerId: summary.providerId,
      summary,
      sheets: {
        Events_Active: { header: [...EVENT_COLUMNS], rows: view('active') },
        Events_Final: { header: [...EVENT_COLUMNS], rows: view('final') },
        Events_Incomplete: { header: [...EVENT_COLUMNS], rows: view('incomplete') },
        Cohort_Summary: { header: [...COHORT_COLUMNS], rows: cohort },
        Distributions: { header: [...DISTRIBUTION_COLUMNS], rows: distributions },
        Rejected_Triggers: { header: [...REJECTION_COLUMNS], rows: rejected },
        Run_Metadata: { header: ['key', 'value'], rows: meta },
      } satisfies Record<ForwardSheet, { header: string[]; rows: Cell[][] }>,
    };
  }

  /** One sheet as CSV, or the whole workbook (dashboard downloads; nothing is written to disk). */
  async render(file: string, now = new Date()): Promise<{ body: Buffer; type: string } | null> {
    const data = await this.sheets(now);
    if (file === 'workbook.xlsx')
      return {
        body: this.workbook(data.sheets),
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    const sheet = FORWARD_SHEETS.find((s) => `${s.toLowerCase()}.csv` === file);
    if (!sheet) return null;
    const s = data.sheets[sheet];
    return { body: Buffer.from(toCsv(s.header, s.rows), 'utf8'), type: 'text/csv; charset=utf-8' };
  }

  private workbook(sheets: Awaited<ReturnType<ForwardExportService['sheets']>>['sheets']) {
    return buildXlsx(
      FORWARD_SHEETS.map((name) => ({
        name,
        rows: [
          sheets[name].header,
          ...sheets[name].rows.map((r) => xlsxRow(sheets[name].header, r)),
        ],
      })),
    );
  }

  async write(now = new Date()): Promise<{ path: string; files: ForwardExportFile[] }> {
    const data = await this.sheets(now);
    const stamp = now.toISOString().slice(0, 16).replace(':', '-');
    const dirName = `${stamp}Z_forward-test${data.label === 'SYNTHETIC' ? '_SYNTHETIC' : ''}`;
    const finalDir = join(resolve(this.cfg.TIER1_EXPORT_DIR), data.providerId, dirName);
    const tmp = `${finalDir}.tmp-${randomUUID().slice(0, 8)}`;
    mkdirSync(tmp, { recursive: true });
    try {
      const files: ForwardExportFile[] = [];
      const put = (name: string, content: Buffer, rows: number) => {
        writeFileSync(join(tmp, name), content);
        files.push({ name, rows, bytes: content.length, sha256: sha(content) });
      };
      for (const name of FORWARD_SHEETS) {
        const s = data.sheets[name];
        put(
          `${name.toLowerCase()}.csv`,
          Buffer.from(toCsv(s.header, s.rows), 'utf8'),
          s.rows.length,
        );
      }
      put(
        'workbook.xlsx',
        this.workbook(data.sheets),
        FORWARD_SHEETS.reduce((n, s) => n + data.sheets[s].rows.length, 0),
      );
      const manifest = {
        kind: 'forward-test',
        providerId: data.providerId,
        dataLabel: data.label,
        rulesVersion: data.summary.rulesVersion,
        generatedAt: now.toISOString(),
        files,
      };
      writeFileSync(join(tmp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
      renameSync(tmp, finalDir);
      this.log.log(
        `forward export ${dirName}: ${files.map((f) => `${f.name}(${f.rows})`).join(', ')}`,
      );
      return { path: finalDir, files };
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
  }
}
