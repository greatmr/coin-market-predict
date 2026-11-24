import { Injectable, Logger } from '@nestjs/common';

import { redact } from '../../common/security/redact.js';

import {
  type CaptureReport,
  type CaptureSkipped,
  ForwardCaptureService,
} from './forward-capture.service.js';
import { type ForwardExportFile, ForwardExportService } from './forward-export.service.js';
import { ForwardRetirementService, type LegacyStatus } from './forward-retirement.service.js';
import { ForwardUpdateService, type UpdateReport } from './forward-update.service.js';

export interface ForwardStageReport {
  capture: CaptureReport | CaptureSkipped | null;
  update: UpdateReport | { skipped: string };
  export: { path: string; files: number } | { error: string } | null;
  /** The legacy tracker's wind-down after the cutover (closures, retirement). */
  legacy?: Pick<LegacyStatus, 'state' | 'events' | 'terminal' | 'pending'> | { error: string };
}

/**
 * Entry points of the forward test for the pipeline, the CLI and the dashboard. The caller holds
 * the pipeline lease, so trigger, update and export never overlap a scan or each other.
 */
@Injectable()
export class ForwardTestService {
  private readonly log = new Logger(ForwardTestService.name);

  constructor(
    private readonly capture: ForwardCaptureService,
    private readonly updates: ForwardUpdateService,
    private readonly exporter: ForwardExportService,
    private readonly retirement: ForwardRetirementService,
  ) {}

  /**
   * The hourly step after the scanner publishes a batch: register the batch's events (legacy intake
   * closes at the cutover), then run the daily High update when a UTC day has closed (or missing
   * Highs are due for a retry) — until the legacy tracker is retired.
   */
  async afterPublication(
    providerId: string,
    batchId: string,
    opts: { now: Date; pipelineRunId: string | null },
  ): Promise<ForwardStageReport> {
    const capture = await this.capture.captureBatch(batchId, opts);
    if (await this.retirement.isRetired(providerId))
      return { capture, update: { skipped: 'the legacy forward test is retired' }, export: null };
    const due = await this.updates.due(providerId, opts.now);
    if (!due.due) return { capture, update: { skipped: due.reason }, export: null };
    return { capture, ...(await this.update(providerId, { ...opts, trigger: 'schedule' })) };
  }

  /** The daily High update now (also the manual "one-day update job"), then a fresh export. */
  async update(
    providerId: string,
    opts: {
      now: Date;
      pipelineRunId?: string | null;
      trigger: 'schedule' | 'manual';
      onRunCreated?: (updateRunId: string) => void;
    },
  ): Promise<Omit<ForwardStageReport, 'capture'>> {
    const update = await this.updates.update(providerId, opts);
    const exported = await this.writeExport(opts.now);
    return { update, export: exported, legacy: await this.windDown(providerId, opts.now) };
  }

  /** Record terminal closures and retire the tracker when every legacy event is terminal. */
  async windDown(
    providerId: string,
    now: Date,
  ): Promise<NonNullable<ForwardStageReport['legacy']>> {
    try {
      const s = await this.retirement.evaluate(providerId, now, { write: true });
      return { state: s.state, events: s.events, terminal: s.terminal, pending: s.pending };
    } catch (err) {
      const error = redact(err).slice(0, 300);
      this.log.warn(`legacy wind-down failed: ${error}`);
      return { error };
    }
  }

  async writeExport(now: Date): Promise<{ path: string; files: number } | { error: string }> {
    try {
      const r: { path: string; files: ForwardExportFile[] } = await this.exporter.write(now);
      return { path: r.path, files: r.files.length };
    } catch (err) {
      const error = redact(err).slice(0, 300);
      this.log.warn(`forward export failed: ${error}`);
      return { error };
    }
  }
}
