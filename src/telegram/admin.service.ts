import { Injectable } from "@nestjs/common";
import { sleep } from "../common/time.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ReadModelService } from "../read-model/read-model.service.js";
import { TelegramAccessService, type AccessEntry } from "./access.service.js";
import { ReportService } from "./report.service.js";
import { TelegramService } from "./telegram.service.js";

export type DeliveryState = "pending" | "retrying" | "gave_up" | "not_queued";

export interface MissedDelivery {
  runId: string;
  slotTime: string;
  chatId: string;
  label: string;
  state: DeliveryState;
  partsSent: number;
  partCount: number;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
}

/**
 * Access changes and delivery actions shared by the bot commands and the dashboard, so both do
 * exactly the same thing (including telling a newly approved person that they are in).
 */
@Injectable()
export class TelegramAdminService {
  constructor(
    private readonly access: TelegramAccessService,
    private readonly telegram: TelegramService,
    private readonly prisma: PrismaService,
    private readonly reports: ReportService,
    private readonly read: ReadModelService,
  ) {}

  /** `notified` is false when Telegram refused the message (e.g. the person never pressed Start). */
  async approve(chatId: string): Promise<{ entry: AccessEntry; notified: boolean }> {
    const entry = await this.access.approve(chatId);
    const sent = await this.telegram.reply(chatId, "✅ Access granted. You will receive the hourly report here. Send /help for commands.");
    return { entry, notified: sent.ok };
  }

  async deny(chatId: string): Promise<void> {
    await this.access.deny(chatId);
  }

  remove(chatId: string): Promise<boolean> {
    return this.access.remove(chatId);
  }

  /** Everyone who should receive reports, with a display label. */
  async recipients(): Promise<Array<{ chatId: string; label: string; since: string | null }>> {
    const s = await this.access.list();
    return [{ chatId: this.access.owner, label: "Owner", since: null }, ...Object.entries(s.approved).map(([chatId, e]) => ({ chatId, label: e.label, since: e.at }))].filter((r) => r.chatId);
  }

  /**
   * Reports that a recipient did not receive in the last `hours`: still queued, retrying after a
   * failure, given up on, or never queued for them (e.g. they were approved after it was sent).
   * A recipient counts as served for a run when any complete copy of its report reached them.
   */
  async missing(hours = 6): Promise<MissedDelivery[]> {
    if (this.telegram.mode !== "live") return [];
    const since = new Date(Date.now() - hours * 3_600_000);
    const [runs, recipients] = await Promise.all([
      this.prisma.pipelineRun.findMany({
        where: { slotTime: { gte: since }, status: { in: ["succeeded", "partial"] } },
        orderBy: { slotTime: "desc" },
        select: { id: true, slotTime: true, finishedAt: true, deliveries: { where: { mode: "live" } } },
      }),
      this.recipients(),
    ]);
    const out: MissedDelivery[] = [];
    for (const run of runs) {
      for (const who of recipients) {
        const rows = run.deliveries.filter((d) => d.chatId === who.chatId);
        const copies = new Map<string, typeof rows>();
        for (const d of rows) copies.set(d.reportHash, [...(copies.get(d.reportHash) ?? []), d]);
        const delivered = [...copies.values()].some((c) => c.length > 0 && c.every((d) => d.status === "sent") && c.length === c[0]!.partCount);
        if (delivered) continue;
        const base = { runId: run.id, slotTime: run.slotTime.toISOString(), chatId: who.chatId, label: who.label };
        if (!rows.length) {
          // Someone approved after this report was created was never owed it.
          const created = (run.finishedAt ?? run.slotTime).getTime();
          if (who.since && created < new Date(who.since).getTime()) continue;
          out.push({ ...base, state: "not_queued", partsSent: 0, partCount: 0, attempts: 0, lastError: null, nextAttemptAt: null });
          continue;
        }
        // Describe the most advanced unsent copy.
        const copy = [...copies.values()].sort((a, b) => b.filter((d) => d.status === "sent").length - a.filter((d) => d.status === "sent").length)[0]!;
        const open = copy.filter((d) => d.status !== "sent");
        const failed = open.find((d) => d.status === "failed");
        const waiting = open.some((d) => d.nextAttemptAt !== null);
        out.push({
          ...base,
          state: failed ? (waiting ? "retrying" : "gave_up") : "pending",
          partsSent: copy.length - open.length,
          partCount: copy[0]!.partCount,
          attempts: Math.max(...open.map((d) => d.attempts)),
          lastError: failed?.lastError ?? null,
          nextAttemptAt: open.map((d) => d.nextAttemptAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0]?.toISOString() ?? null,
        });
      }
    }
    return out;
  }

  /** Send now (bounded wait so the dashboard answers promptly; delivery continues in the background). */
  private async deliverSoon() {
    return Promise.race([this.telegram.deliverPending(), sleep(12_000).then(() => null)]);
  }

  /** Retry unsent deliveries of one run (optionally one chat); with no run, every run in the window. */
  async retry(opts: { runId?: string; chatId?: string; hours?: number }) {
    const runIds = opts.runId ? [opts.runId] : [...new Set((await this.missing(opts.hours ?? 6)).filter((m) => m.state !== "not_queued").map((m) => m.runId))];
    let requeued = 0;
    for (const id of runIds) requeued += await this.telegram.requeue(id, opts.chatId ? [opts.chatId] : undefined);
    return { requeued, delivery: requeued ? await this.deliverSoon() : null };
  }

  /** Send a fresh copy of a run's report (default: the latest scanned batch) to chosen recipients (default: all). */
  async sendReport(opts: { runId?: string; chatIds?: string[] }) {
    const runId = opts.runId ?? (await this.latestReportedRunId());
    const batchId = runId ? await this.reports.batchOfRun(runId) : null;
    if (!runId || !batchId || !(await this.prisma.scanRun.findUnique({ where: { batchId } }))) return { queued: 0, delivery: null, reason: "no report available yet" };
    const known = new Set((await this.recipients()).map((r) => r.chatId));
    const chats = (opts.chatIds ?? [...known]).filter((c) => known.has(c));
    if (!chats.length) return { queued: 0, delivery: null, reason: "no valid recipients" };
    const parts = await this.reports.build(batchId);
    const queued = await this.telegram.queueCopy(runId, parts, chats);
    return { runId, queued, delivery: await this.deliverSoon() };
  }

  /** Newest pipeline run whose crawl batch was scanned. */
  private async latestReportedRunId(): Promise<string | null> {
    const batchId = await this.read.latestScanBatchId();
    if (!batchId) return null;
    const batch = await this.prisma.crawlBatch.findUnique({ where: { id: batchId } });
    return batch?.pipelineRunId ?? null;
  }
}
