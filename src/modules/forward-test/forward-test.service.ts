import { Injectable, Logger } from '@nestjs/common';

import { redact } from '../../common/security/redact.js';

import { type CaptureReport, ForwardCaptureService } from './forward-capture.service.js';
import { type ForwardExportFile, ForwardExportService } from './forward-export.service.js';
import { ForwardUpdateService, type UpdateReport } from './forward-update.service.js';

export interface ForwardStageReport {
  capture: CaptureReport | null;
  update: UpdateReport | { skipped: string };
  export: { path: string; files: number } | { error: string } | null;
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
  ) {}

  /**
   * The hourly step after the scanner publishes a batch: register the batch's events, then run the
   * daily High update when a UTC day has closed (or missing Highs are due for a retry).
   */
  async afterPublication(
    providerId: string,
    batchId: string,
    opts: { now: Date; pipelineRunId: string | null },
  ): Promise<ForwardStageReport> {
    const capture = await this.capture.captureBatch(batchId, opts);
    const due = await this.updates.due(providerId, opts.now);
    if (!due.due) return { capture, update: { skipped: due.reason }, export: null };
    return { capture, ...(await this.update(providerId, { ...opts, trigger: 'schedule' })) };
  }

  /** The daily High update now (also the manual "one-day update job"), then a fresh export. */
  async update(
    providerId: string,
    opts: { now: Date; pipelineRunId?: string | null; trigger: 'schedule' | 'manual' },
  ): Promise<Omit<ForwardStageReport, 'capture'>> {
    const update = await this.updates.update(providerId, opts);
    const exported = await this.writeExport(opts.now);
    return { update, export: exported };
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
