import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedPair } from "../tier1/lbank.js";
import { documentPart, XLSX_MIME } from "./attachment.js";
import { formatTier1Report, type QueueRow, type Tier1ReportInput } from "./format.js";

const num = (v: { toString(): string } | null) => (v === null ? null : Number(v.toString()));

/** Builds the Telegram summary of one scanned crawl batch from the database (the source of truth). */
@Injectable()
export class ReportService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async buildInput(batchId: string): Promise<Tier1ReportInput> {
    const [run, batch] = await Promise.all([this.prisma.scanRun.findUniqueOrThrow({ where: { batchId } }), this.prisma.crawlBatch.findUniqueOrThrow({ where: { id: batchId } })]);
    const provider = await this.prisma.provider.findUnique({ where: { id: batch.providerId } });
    const [queue, needsYes, unverifiedYes] = await Promise.all([
      this.prisma.scanResult.findMany({ where: { batchId, inQueue: true }, orderBy: { queueOrder: "asc" }, take: this.cfg.TELEGRAM_QUEUE_ROWS }),
      this.prisma.scanResult.count({ where: { batchId, eligibilityStatus: "NEEDS_REVIEW", stars: { gt: 0 } } }),
      this.prisma.scanResult.count({ where: { batchId, eligibilityStatus: "NEEDS_REVIEW", stars: { gt: 0 }, lbankStatus: "PAIR_LISTED_UNVERIFIED" } }),
    ]);
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
      lbankPairs: ((r.lbankPairs ?? []) as unknown as ResolvedPair[]).filter((p) => p.trading === "TRADING" && (p.mapping === "OK" || p.mapping === "CONFIRMED")).map((p) => p.marketPair),
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
      queueStatus: run.queueStatus ?? "EMPTY",
      counts: { assets: counts.assets ?? 0, eligible: counts.eligible ?? 0, needsReview: counts.needsReview ?? 0, excluded: counts.excluded ?? 0, queue: counts.queue ?? 0 },
      needsReviewWithYes: needsYes,
      lbankUnverifiedWithYes: unverifiedYes,
      rows,
      warnings: run.warnings,
    };
  }

  async build(batchId: string): Promise<string[]> {
    const input = await this.buildInput(batchId);
    const parts = formatTier1Report(input);
    const attachment = await this.workbookPart(batchId, input);
    return attachment ? [...parts, attachment] : parts;
  }

  /**
   * The batch's Excel workbook as a final report part (TELEGRAM_ATTACH_EXPORT=xlsx). Not attached
   * when the queue is withheld (an incomplete batch or LBank list must not look complete, p.18)
   * or when the export failed or its files were pruned.
   */
  private async workbookPart(batchId: string, input: Tier1ReportInput): Promise<string | null> {
    if (this.cfg.TELEGRAM_ATTACH_EXPORT !== "xlsx" || input.queueStatus.startsWith("WITHHELD")) return null;
    const run = await this.prisma.scanRun.findUnique({ where: { batchId }, select: { exportStatus: true, exportPath: true } });
    if (run?.exportStatus !== "succeeded" || !run.exportPath) return null;
    const path = resolve(run.exportPath, "workbook.xlsx");
    if (!existsSync(path)) return null;
    const slot = input.slotTime.toISOString().slice(0, 16).replace(":", "-");
    const caption = [
      `📎 <b>Tier 1 export</b> · batch ${input.slotTime.toISOString().slice(0, 16).replace("T", " ")} UTC${input.isLive ? "" : " · 🧪 TEST DATA"}`,
      `Sheets: Review_Queue (${input.counts.queue}) · All_Eligible (${input.counts.eligible}) · Needs_Review (${input.counts.needsReview}) · Excluded (${input.counts.excluded}) · Run_Metadata`,
      "<i>Research screen only · no orders placed</i>",
    ].join("\n");
    return documentPart({ path, filename: `coins-tier1_${slot}Z${input.isLive ? "" : "_SYNTHETIC"}.xlsx`, caption, mimeType: XLSX_MIME });
  }

  /** Crawl batch of a pipeline run (for re-sending a run's report). */
  async batchOfRun(runId: string): Promise<string | null> {
    const run = await this.prisma.pipelineRun.findUnique({ where: { id: runId } });
    if (!run) return null;
    const m = (run.metrics ?? {}) as { batchId?: string };
    if (m.batchId) return m.batchId;
    return (await this.prisma.crawlBatch.findUnique({ where: { providerId_slotTime: { providerId: run.providerId, slotTime: run.slotTime } } }))?.id ?? null;
  }
}
