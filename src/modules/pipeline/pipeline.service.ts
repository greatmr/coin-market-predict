import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { type DataSource, Not } from 'typeorm';

import { insertRows } from '../../common/entities/insert.js';
import { redact } from '../../common/security/redact.js';
import { type Clock, addHours, slotOf, systemClock } from '../../common/utils/time.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import {
  DailyMetricsService,
  type DailyRefreshReport,
} from '../daily-metrics/daily-metrics.service.js';
import { type ExportResult, ExportService } from '../exports/export.service.js';
import {
  type ForwardStageReport,
  ForwardTestService,
} from '../forward-test/forward-test.service.js';
import { CrawlBatch } from '../ingestion/entities/crawl-batch.entity.js';
import { type CoverageReport, IngestionService } from '../ingestion/ingestion.service.js';
import { type ScanOutcome, ScanService } from '../scan/scan.service.js';
import { SourceUnavailableError } from '../sources/http/polite-client.js';
import { SourceHealthService } from '../sources/source-health.service.js';
import { ReportService } from '../telegram/report.service.js';
import { TelegramService } from '../telegram/telegram.service.js';
import { type LbankCrawlReport, VenuesService } from '../venues/venues.service.js';

import { PipelineRun } from './entities/pipeline-run.entity.js';
import { PipelineStage } from './entities/pipeline-stage.entity.js';
import { LeaseService } from './lease.service.js';
import { STAGES, type Stage, type StageProgress, progressBar } from './progress.js';
import { RetentionService } from './retention.service.js';

export { STAGES, progressBar };
export const PIPELINE_LEASE = 'hourly-pipeline';
const LEASE_TTL_MS = 10 * 60_000;
/** Minimum gap between item-progress writes, so a fast loop does not flood the database. */
const PROGRESS_WRITE_MS = 1_000;

export interface RunOutcome {
  runId: string | null;
  slot: string;
  status: 'succeeded' | 'partial' | 'failed' | 'skipped';
  reason?: string;
  stages: Partial<Record<Stage, string>>;
  batchId?: string | null;
}

export type RetryCrawlResult =
  | { started: true; slot: string; circuitReset: boolean; done: Promise<RunOutcome> }
  | { started: false; slot: string; reason: string };

@Injectable()
export class PipelineService {
  private readonly log = new Logger(PipelineService.name);
  private inProcess = false;
  clock: Clock = systemClock;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly ingestion: IngestionService,
    private readonly venues: VenuesService,
    private readonly daily: DailyMetricsService,
    private readonly scanner: ScanService,
    private readonly exports: ExportService,
    private readonly reports: ReportService,
    private readonly telegram: TelegramService,
    private readonly leases: LeaseService,
    private readonly retention: RetentionService,
    private readonly health: SourceHealthService,
    private readonly forward: ForwardTestService,
  ) {}

  get providerId() {
    return this.ingestion.source.info.id;
  }

  private get runs() {
    return this.db.getRepository(PipelineRun);
  }

  private get stageRows() {
    return this.db.getRepository(PipelineStage);
  }

  /** Take the pipeline lease (no overlap within or across instances); the caller must release it. */
  private async takeLease(): Promise<{ release: () => Promise<void> } | { skipped: string }> {
    if (this.inProcess) return { skipped: 'a run is already in progress in this process' };
    const holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    if (!(await this.leases.acquire(PIPELINE_LEASE, holder, LEASE_TTL_MS)))
      return { skipped: 'another instance holds the pipeline lease' };
    this.inProcess = true;
    const beat = setInterval(
      () => void this.leases.heartbeat(PIPELINE_LEASE, holder, LEASE_TTL_MS).catch(() => undefined),
      60_000,
    );
    return {
      release: async () => {
        clearInterval(beat);
        this.inProcess = false;
        await this.leases.release(PIPELINE_LEASE, holder).catch(() => undefined);
      },
    };
  }

  /** Run `work` while holding the pipeline lease. */
  private async exclusive<T>(work: () => Promise<T>): Promise<T | { skipped: string }> {
    const lease = await this.takeLease();
    if ('skipped' in lease) return lease;
    try {
      return await work();
    } finally {
      await lease.release();
    }
  }

  /** Run (or resume) the pipeline for one hourly slot. Completed stages are skipped on resume. */
  async runSlot(
    slotInput?: Date,
    opts: { kind?: string; force?: boolean } = {},
  ): Promise<RunOutcome> {
    const slot = slotOf(slotInput ?? this.clock.now());
    const r = await this.exclusive(() => this.execute(slot, opts.kind ?? 'hourly', !!opts.force));
    return 'skipped' in r && typeof r.skipped === 'string'
      ? { runId: null, slot: slot.toISOString(), status: 'skipped', reason: r.skipped, stages: {} }
      : (r as RunOutcome);
  }

  /**
   * Manual "Retry crawl now" (dashboard): close an open circuit breaker, skipping its cooldown, and
   * crawl the current slot again in the background. The lease is taken before this returns, so the
   * caller learns at once whether the run started. It does not override a suspension after access
   * denial or a provider's Retry-After: those need the operator (`source:reset`) or waiting.
   */
  async retryCrawl(): Promise<RetryCrawlResult> {
    const slot = slotOf(this.clock.now());
    const slotIso = slot.toISOString();
    const lease = await this.takeLease();
    if ('skipped' in lease) return { started: false, slot: slotIso, reason: lease.skipped };
    let handedOff = false;
    try {
      const providerId = this.providerId;
      const existing = await this.runs.findOneBy({ kind: 'hourly', slotTime: slot, providerId });
      if (existing?.status === 'succeeded' || existing?.status === 'partial')
        return { started: false, slot: slotIso, reason: "this hour's crawl already completed" };
      const h = await this.health.load(providerId);
      if (h.state === 'suspended')
        return {
          started: false,
          slot: slotIso,
          reason: `the source is suspended (${h.suspendedReason ?? 'access denied'}); resolve the cause, then run npm run cli -- source:reset`,
        };
      if (h.retryAfterUntil && h.retryAfterUntil > this.clock.now())
        return {
          started: false,
          slot: slotIso,
          reason: `the source asked us to wait until ${h.retryAfterUntil.toISOString()}`,
        };
      const circuitReset = h.state !== 'closed' || h.consecutiveFailures > 0;
      if (circuitReset) {
        await this.health.reset(providerId);
        this.log.warn(`circuit for ${providerId} reset by a manual crawl retry`);
      }
      const done = this.execute(slot, 'hourly', false)
        .catch((err): RunOutcome => ({
          runId: null,
          slot: slotIso,
          status: 'failed',
          reason: redact(err).slice(0, 300),
          stages: {},
        }))
        .finally(() => lease.release());
      handedOff = true;
      return { started: true, slot: slotIso, circuitReset, done };
    } finally {
      if (!handedOff) await lease.release();
    }
  }

  /**
   * Reprocess a saved crawl batch without crawling (PDF p.18 dry run over saved data): scan and,
   * optionally, export. Results of the batch are replaced, never duplicated.
   */
  async reprocess(
    batchId?: string,
    opts: { export?: boolean } = {},
  ): Promise<{
    batchId: string | null;
    scan?: ScanOutcome;
    export?: ExportResult;
    skipped?: string;
  }> {
    const r = await this.exclusive(async () => {
      const id = batchId ?? (await this.scanner.latestBatch(this.providerId))?.id ?? null;
      if (!id) return { batchId: null, skipped: 'no stored crawl batch to process' };
      const scan = await this.scanner.scan(id, [
        'REPROCESSED: results recomputed from stored inputs',
      ]);
      const exp = opts.export === false ? undefined : await this.exports.export(id);
      return { batchId: id, scan, export: exp };
    });
    return 'skipped' in r && typeof r.skipped === 'string' && !('batchId' in r)
      ? { batchId: batchId ?? null, skipped: r.skipped }
      : (r as { batchId: string | null });
  }

  /**
   * The forward test's daily High update now (CLI `forward:update`, dashboard), under the pipeline
   * lease. Idempotent: it never creates an event and never duplicates a High or an outcome.
   */
  async runForwardUpdate(): Promise<Omit<ForwardStageReport, 'capture'> | { skipped: string }> {
    return this.exclusive(() =>
      this.forward.update(this.providerId, { now: this.clock.now(), trigger: 'manual' }),
    );
  }

  /** Re-export a scanned batch under the pipeline lease, so it never races an hourly export. */
  async exportBatch(batchId: string): Promise<ExportResult | { skipped: string }> {
    return this.exclusive(() => this.exports.export(batchId));
  }

  /**
   * Manual refresh of the LBank Spot markets list (dashboard button, `lbank:refresh`): fetch it now,
   * then recompute and re-export the latest batch so the new list is visible at once. Runs under
   * the pipeline lease, so it never overlaps an hourly run.
   */
  async refreshLbankPairs(): Promise<
    | { lbank: LbankCrawlReport; batchId: string | null; scan?: ScanOutcome; export?: ExportResult }
    | { skipped: string }
  > {
    return this.exclusive(async () => {
      const lbank = await this.venues.ensureLbankPairs(this.providerId, null, this.clock.now(), {
        force: true,
        trigger: 'manual',
      });
      const latest = await this.scanner.latestBatch(this.providerId);
      if (!latest || lbank.status === 'SKIPPED') return { lbank, batchId: latest?.id ?? null };
      const scan = await this.scanner.scan(latest.id, [
        `LBANK_LIST_REFRESHED: manual refresh ${lbank.status} (${lbank.pairs} pairs); latest batch recomputed`,
      ]);
      const exp = await this.exports.export(latest.id);
      return { lbank, batchId: latest.id, scan, export: exp };
    });
  }

  private async execute(slot: Date, kind: string, force: boolean): Promise<RunOutcome> {
    const providerId = this.providerId;
    await this.ingestion.ensureProvider();
    const now = this.clock.now();

    const existing = await this.runs.findOneBy({ kind, slotTime: slot, providerId });
    if ((existing?.status === 'succeeded' || existing?.status === 'partial') && !force) {
      return {
        runId: existing.id,
        slot: slot.toISOString(),
        status: 'skipped',
        reason: 'slot already completed',
        stages: {},
      };
    }
    let run: PipelineRun;
    if (existing) {
      await this.runs
        .createQueryBuilder()
        .update(PipelineRun)
        .set({ status: 'running', attempt: () => 'attempt + 1', error: null, finishedAt: null })
        .where('id = :id', { id: existing.id })
        .execute();
      run = await this.runs.findOneByOrFail({ id: existing.id });
    } else {
      run = await this.runs.save(
        this.runs.create({
          kind,
          slotTime: slot,
          providerId,
          status: 'running',
          startedAt: now,
          isLiveData: this.ingestion.source.info.isLive,
        }),
      );
    }
    const runId = run.id;
    // We hold the pipeline lease, so any other run still marked "running" belongs to a process that died.
    await this.runs.update(
      { providerId, status: 'running', id: Not(runId) },
      {
        status: 'failed',
        finishedAt: now,
        error: 'interrupted: the process stopped before this run finished',
      },
    );
    const done = new Set(
      (await this.stageRows.findBy({ runId, status: 'succeeded' })).map((s) => s.stage),
    );
    const stages: RunOutcome['stages'] = {};
    const metrics: Record<string, unknown> = {
      ...((run.metrics as Record<string, unknown>) ?? {}),
    };
    delete metrics.progress;
    const saveMetrics = () => this.runs.update({ id: runId }, { metrics: metrics as never });
    // Item progress of long stages for the dashboard. Writes are serialized and throttled; the
    // stage wrapper waits for the last one so it never lands after the stage has finished.
    let progressWrite: Promise<unknown> = Promise.resolve();
    const progressFor = (name: Stage, unit: string) => {
      let last = 0;
      return (done: number, total: number) => {
        const t = Date.now();
        if (done > 0 && done < total && t - last < PROGRESS_WRITE_MS) return;
        last = t;
        metrics.progress = { stage: name, unit, done, total } satisfies StageProgress;
        progressWrite = progressWrite.then(saveMetrics).catch(() => undefined);
      };
    };

    const stage = async <T>(
      name: Stage,
      fn: () => Promise<T>,
      o: { retries?: number; skipIfDone?: boolean } = {},
    ): Promise<T | undefined> => {
      const step = STAGES.indexOf(name) + 1;
      if ((o.skipIfDone ?? true) && done.has(name)) {
        stages[name] = 'skipped (already done)';
        this.log.log(`${progressBar(step, STAGES.length)} ${name} · already done`);
        return undefined;
      }
      this.log.log(`${progressBar(step - 1, STAGES.length)} ${name} · started`);
      await this.runs.update({ id: runId }, { currentStage: name });
      const started = Date.now();
      const restarted = await this.stageRows
        .createQueryBuilder()
        .update(PipelineStage)
        .set({
          status: 'running',
          startedAt: new Date(),
          attempts: () => 'attempts + 1',
          error: null,
        })
        .where('run_id = :runId AND stage = :stage', { runId, stage: name })
        .execute();
      if (!restarted.affected)
        await this.stageRows.insert({
          runId,
          stage: name,
          status: 'running',
          startedAt: new Date(),
        });
      let lastErr: unknown;
      const clearProgress = async () => {
        await progressWrite;
        if ((metrics.progress as StageProgress | undefined)?.stage === name)
          delete metrics.progress;
      };
      for (let attempt = 0; attempt <= (o.retries ?? 0); attempt++) {
        try {
          const result = await fn();
          await clearProgress();
          await this.stageRows.update(
            { runId, stage: name },
            { status: 'succeeded', finishedAt: new Date(), detail: summarize(result) as never },
          );
          metrics[`${name}Ms`] = Date.now() - started;
          stages[name] = 'succeeded';
          this.log.log(
            `${progressBar(step, STAGES.length)} ${name} · done in ${((Date.now() - started) / 1000).toFixed(1)}s`,
          );
          return result;
        } catch (err) {
          lastErr = err;
          if (isSourceUnavailable(err)) break; // do not retry an unavailable source (open circuit, denial, budget)
        }
      }
      await clearProgress();
      await this.stageRows.update(
        { runId, stage: name },
        { status: 'failed', finishedAt: new Date(), error: redact(lastErr).slice(0, 2000) },
      );
      stages[name] = `failed: ${redact(lastErr).slice(0, 200)}`;
      throw lastErr;
    };
    const degraded: string[] = [];

    let coverage = run.coverage as unknown as CoverageReport | null;
    let batchId: string | null = null;
    try {
      await stage('discover', async () =>
        (await this.ingestion.discoveryDue(now))
          ? this.ingestion.discover(now)
          : { skipped: 'not due' },
      );
      const collectStarted = this.clock.now();
      const collected = await stage(
        'collect',
        () => this.ingestion.collect(slot, runId, this.clock.now()),
        { retries: 1 },
      ).catch(async (err) => {
        await this.ingestion
          .recordFailedBatch(slot, runId, collectStarted, err)
          .catch(() => undefined);
        throw err;
      });
      if (collected) coverage = collected;
      await this.runs.update({ id: runId }, { coverage: coverage as never });
      const batches = this.db.getRepository(CrawlBatch);
      batchId =
        coverage?.batchId ?? (await batches.findOneBy({ providerId, slotTime: slot }))?.id ?? null;
      if (!batchId) throw new Error('no crawl batch stored for this slot');
      metrics.batchId = batchId;
      const batch = await batches.findOneByOrFail({ id: batchId });
      if (batch.status !== 'COMPLETE') degraded.push(`batch ${batch.status}`);

      // LBank Spot markets list: reused until LBANK_PAIRS_REFRESH_DAYS old, then refreshed (D2). A
      // failed refresh keeps the previous list until LBANK_PAIRS_MAX_AGE_DAYS; it never fails the run.
      const lbank =
        (await stage('lbank', () =>
          this.venues.ensureLbankPairs(providerId, batchId!, this.clock.now(), {
            trigger: 'schedule',
          }),
        )) ?? ((await this.stageDetail(runId, 'lbank')) as LbankCrawlReport | null);
      metrics.lbank = lbank;
      if (lbank && !lbank.usable) degraded.push(`LBank list unavailable (${lbank.status})`);
      else if (lbank && (lbank.status === 'FAILED' || lbank.status === 'INCOMPLETE'))
        degraded.push(
          `LBank refresh ${lbank.status}; using the list fetched ${lbank.listFetchedAt}`,
        );
      await saveMetrics();

      // Daily rows: partial refreshes leave affected windows N/A; never fatal.
      let daily: DailyRefreshReport | null | undefined = await stage('daily', async () => {
        const ctx = await this.scanner.loadContext(batchId!);
        return this.daily.refresh(
          providerId,
          { id: batchId!, crawledAt: ctx.asOf },
          this.scanner.dailyCandidates(ctx),
          progressFor('daily', 'coins'),
        );
      }).catch((err) => {
        degraded.push('daily refresh failed');
        this.log.warn(`daily refresh failed, scanning with stored rows: ${redact(err)}`);
        return null;
      });
      if (daily === undefined)
        daily = (await this.stageDetail(runId, 'daily')) as DailyRefreshReport | null;
      metrics.daily = daily;
      if (daily && daily.status === 'partial')
        degraded.push(
          `daily rows partial (${daily.remaining} candidates lack the latest completed day)`,
        );
      await saveMetrics();

      const warnings: string[] = [];
      if (daily?.stoppedBy)
        warnings.push(
          `DAILY_REFRESH_STOPPED: ${daily.stoppedBy.replace(/_/g, ' ')}; ${daily.remaining} candidates still lack ${daily.latestCompletedDate}`,
        );
      const scan = (await stage('scan', () => this.scanner.scan(batchId!, warnings), {
        skipIfDone: false,
      }))!;
      metrics.scan = {
        queueStatus: scan.queueStatus,
        counts: scan.counts,
        warnings: scan.warnings,
      };
      await saveMetrics();

      await stage(
        'venues',
        async () => {
          const report = await this.venues.refreshAssetMarkets(
            providerId,
            batchId!,
            scan.venueCandidates,
            this.clock.now(),
            progressFor('venues', 'coins'),
          );
          const annotated = await this.scanner.annotateVenues(
            batchId!,
            scan.venueCandidates.map((c) => c.cmcId),
          );
          return { ...report, annotated };
        },
        { skipIfDone: false },
      ).catch((err) => {
        degraded.push('venue refresh failed');
        this.log.warn(`venue refresh failed: ${redact(err)}`);
      });

      const exported = await stage(
        'export',
        async () => {
          const r = await this.exports.export(batchId!);
          if (r.status === 'failed') throw new Error(`export failed: ${r.error}`);
          return { path: r.path, files: r.files };
        },
        { skipIfDone: false },
      ).catch((err) => {
        degraded.push('export failed');
        this.log.warn(redact(err));
        return null;
      });
      metrics.export = exported ?? null;

      await stage('notify', async () => {
        const parts = await this.reports.build(batchId!);
        const prep = await this.telegram.prepare(runId, parts);
        // Live sending happens independently so delivery failures never re-run analysis.
        const sent = await this.telegram.deliverPending().catch((e) => ({ error: redact(e) }));
        return { ...prep, parts: parts.length, delivery: sent };
      });

      // Forward test (docs/forward-test.md): attached to this publication of the Review Queue, plus
      // the daily High update once per closed UTC day. Never fails the run.
      const forward = await stage(
        'forward',
        () =>
          this.forward.afterPublication(providerId, batchId!, {
            now: this.clock.now(),
            pipelineRunId: runId,
          }),
        { skipIfDone: false },
      ).catch((err) => {
        degraded.push('forward test failed');
        this.log.warn(`forward test failed: ${redact(err)}`);
        return null;
      });
      if (forward)
        metrics.forward = {
          created: forward.capture?.created.length ?? 0,
          ignored: forward.capture?.ignored.length ?? 0,
          rejected: forward.capture?.rejected.length ?? 0,
          update: 'skipped' in forward.update ? forward.update.skipped : forward.update.status,
        };

      // Storage policy runs after delivery; a retention problem never invalidates the run.
      metrics.retention = await this.retention
        .apply(providerId, this.clock.now())
        .catch((e) => ({ error: redact(e).slice(0, 300) }));
      metrics.degraded = degraded;
      const partial = degraded.length > 0;
      await this.runs.update(
        { id: runId },
        {
          status: partial ? 'partial' : 'succeeded',
          finishedAt: new Date(),
          currentStage: null,
          metrics: metrics as never,
        },
      );
      return {
        runId,
        slot: slot.toISOString(),
        status: partial ? 'partial' : 'succeeded',
        stages,
        batchId,
      };
    } catch (err) {
      this.log.error(`run ${runId} failed: ${redact(err)}`);
      metrics.degraded = degraded;
      await this.runs.update(
        { id: runId },
        {
          status: 'failed',
          finishedAt: new Date(),
          currentStage: null,
          error: redact(err).slice(0, 2000),
          metrics: metrics as never,
        },
      );
      return {
        runId,
        slot: slot.toISOString(),
        status: 'failed',
        reason: redact(err).slice(0, 300),
        stages,
        batchId,
      };
    }
  }

  private async stageDetail(runId: string, stage: Stage): Promise<unknown> {
    return (await this.stageRows.findOneBy({ runId, stage }))?.detail ?? null;
  }

  /** Resume the current slot's run if its process died (status still "running" but no live lease holder). */
  async resumeIfInterrupted(): Promise<RunOutcome | null> {
    if (this.inProcess) return null;
    const slot = slotOf(this.clock.now());
    const cur = await this.runs.findOneBy({
      kind: 'hourly',
      slotTime: slot,
      providerId: this.providerId,
    });
    if (cur?.status !== 'running') return null;
    return this.runSlot(slot);
  }

  /**
   * Restart recovery: record hours that were missed while the app was down (a missing batch is a
   * visible gap, never filled with invented snapshots), then run the current slot if allowed.
   */
  async recoverOnStartup(): Promise<{ missedRecorded: number; ran: RunOutcome | null }> {
    const providerId = this.providerId;
    const current = slotOf(this.clock.now());
    const last = await this.runs.findOne({
      where: { providerId, kind: 'hourly' },
      order: { slotTime: 'DESC' },
    });
    let missed = 0;
    if (last) {
      for (let s = addHours(last.slotTime, 1); s < current && missed < 48; s = addHours(s, 1)) {
        missed += await insertRows(
          this.db.manager,
          PipelineRun,
          [
            {
              kind: 'hourly',
              slotTime: s,
              providerId,
              status: 'missed',
              startedAt: this.clock.now(),
              finishedAt: this.clock.now(),
              isLiveData: this.ingestion.source.info.isLive,
              error: 'application was not running during this hour',
            },
          ],
          { ignoreConflicts: true },
        );
      }
    }
    if (this.cfg.MISSED_RUN_POLICY === 'skip') return { missedRecorded: missed, ran: null };
    const cur = await this.runs.findOneBy({ kind: 'hourly', slotTime: current, providerId });
    if (cur && (cur.status === 'succeeded' || cur.status === 'partial'))
      return { missedRecorded: missed, ran: null };
    return { missedRecorded: missed, ran: await this.runSlot(current) };
  }
}

function summarize(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return { count: v.length };
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('venueCandidates' in o) {
      const { venueCandidates, ...rest } = o as { venueCandidates: unknown[] };
      return JSON.parse(JSON.stringify({ ...rest, venueCandidates: venueCandidates.length }));
    }
    return JSON.parse(
      JSON.stringify(o, (_k, val) => (typeof val === 'bigint' ? Number(val) : val)),
    );
  }
  return v;
}

/** True when the error, or an error it wraps (e.g. CmcApiError), is a SourceUnavailableError. */
function isSourceUnavailable(err: unknown): boolean {
  for (let e = err, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++)
    if (e instanceof SourceUnavailableError) return true;
  return false;
}
