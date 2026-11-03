import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { type Clock, sleep as realSleep, systemClock } from "../common/time.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { redact } from "../config/redact.js";
import { PrismaService } from "../prisma/prisma.service.js";

export const TELEGRAM_FETCH = Symbol("TELEGRAM_FETCH");
export const MAX_DELIVERY_ATTEMPTS = 6;
const MIN_SPACING_MS = 1_500;

export interface DeliverySummary {
  mode: string;
  prepared: number;
  duplicatesSuppressed: number;
}

/**
 * Telegram delivery, decoupled from the pipeline: reports are first written to
 * TelegramDelivery rows (idempotent via reportHash + part + chat), then sent by
 * `deliverPending`, which can be retried on its own schedule without re-running
 * collection or model analysis.
 */
@Injectable()
export class TelegramService {
  private readonly log = new Logger(TelegramService.name);
  private lastSentAt = 0;
  clock: Clock = systemClock;
  sleep: (ms: number) => Promise<void> = realSleep;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(TELEGRAM_FETCH) private readonly fetchImpl: typeof fetch,
  ) {}

  get mode() {
    return this.cfg.TELEGRAM_MODE;
  }

  private chatId(): string {
    return this.cfg.TELEGRAM_MODE === "live" ? this.cfg.TELEGRAM_CHAT_ID! : (this.cfg.TELEGRAM_CHAT_ID ?? "dry-run");
  }

  /** Includes the mode so a dry-run copy never suppresses the later live delivery. */
  static reportHash(runId: string, parts: string[], mode = "live"): string {
    return createHash("sha256").update(mode).update("\u0000").update(runId).update("\u0000").update(parts.join("\u0001")).digest("hex").slice(0, 40);
  }

  /** Check the bot token and chat without sending anything. Never returns the token. */
  async verify(): Promise<{ ok: boolean; bot?: string; chatType?: string; chatTitle?: string; error?: string }> {
    if (!this.cfg.TELEGRAM_BOT_TOKEN || !this.cfg.TELEGRAM_CHAT_ID) return { ok: false, error: "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required" };
    const call = async (method: string, body: unknown) => {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${this.cfg.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      return (await res.json()) as { ok: boolean; description?: string; result?: Record<string, unknown> };
    };
    try {
      const me = await call("getMe", {});
      if (!me.ok) return { ok: false, error: `bot token rejected: ${me.description ?? "unknown"}` };
      const chat = await call("getChat", { chat_id: this.cfg.TELEGRAM_CHAT_ID });
      if (!chat.ok) return { ok: false, bot: `@${me.result?.username}`, error: `chat not reachable: ${chat.description ?? "unknown"}` };
      return { ok: true, bot: `@${me.result?.username}`, chatType: String(chat.result?.type), chatTitle: String(chat.result?.title ?? chat.result?.first_name ?? "") };
    } catch (err) {
      return { ok: false, error: redact(err) };
    }
  }

  /** Send one short test message immediately (bypasses the delivery queue). */
  async sendTest(text: string) {
    if (!this.cfg.TELEGRAM_BOT_TOKEN || !this.cfg.TELEGRAM_CHAT_ID) return { ok: false as const, error: "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required", permanent: true };
    return this.sendOne(this.cfg.TELEGRAM_CHAT_ID, text);
  }

  async prepare(runId: string, parts: string[]): Promise<DeliverySummary> {
    if (this.cfg.TELEGRAM_MODE === "disabled") return { mode: "disabled", prepared: 0, duplicatesSuppressed: 0 };
    const hash = TelegramService.reportHash(runId, parts, this.cfg.TELEGRAM_MODE);
    const chatId = this.chatId();
    const res = await this.prisma.telegramDelivery.createMany({
      data: parts.map((text, i) => ({
        runId,
        reportHash: hash,
        partIndex: i,
        partCount: parts.length,
        chatId,
        mode: this.cfg.TELEGRAM_MODE,
        status: this.cfg.TELEGRAM_MODE === "live" ? "pending" : "dry_run",
        text,
        nextAttemptAt: this.clock.now(),
      })),
      skipDuplicates: true,
    });
    if (this.cfg.TELEGRAM_MODE === "dry_run" && res.count > 0) {
      this.log.log(`[dry-run] Telegram report for run ${runId} (${parts.length} part(s)) stored; not sent.`);
    }
    return { mode: this.cfg.TELEGRAM_MODE, prepared: res.count, duplicatesSuppressed: parts.length - res.count };
  }

  /** Send pending live deliveries in order. Safe to call repeatedly and concurrently with nothing else. */
  async deliverPending(limit = 30): Promise<{ sent: number; failed: number; deferred: number }> {
    if (this.cfg.TELEGRAM_MODE !== "live" || !this.cfg.TELEGRAM_BOT_TOKEN) return { sent: 0, failed: 0, deferred: 0 };
    const due = await this.prisma.telegramDelivery.findMany({
      where: { mode: "live", status: { in: ["pending", "failed"] }, attempts: { lt: MAX_DELIVERY_ATTEMPTS }, nextAttemptAt: { lte: this.clock.now() } },
      orderBy: [{ createdAt: "asc" }, { partIndex: "asc" }],
      take: limit,
    });
    let sent = 0;
    let failed = 0;
    let deferred = 0;
    const blockedReports = new Set<string>();
    for (const d of due) {
      // Keep parts in order: never send part N+1 before part N succeeded.
      if (blockedReports.has(d.reportHash)) continue;
      if (d.partIndex > 0) {
        const prev = await this.prisma.telegramDelivery.findUnique({ where: { reportHash_partIndex_chatId: { reportHash: d.reportHash, partIndex: d.partIndex - 1, chatId: d.chatId } } });
        if (prev && prev.status !== "sent") {
          blockedReports.add(d.reportHash);
          continue;
        }
      }
      const r = await this.sendOne(d.chatId, d.text);
      const attempts = d.attempts + 1;
      if (r.ok) {
        sent++;
        await this.prisma.telegramDelivery.update({ where: { id: d.id }, data: { status: "sent", attempts, sentAt: this.clock.now(), telegramMessageId: r.messageId, lastError: null } });
      } else {
        const permanent = r.permanent || attempts >= MAX_DELIVERY_ATTEMPTS;
        if (permanent) failed++;
        else deferred++;
        const backoffMs = r.retryAfterMs ?? Math.min(30 * 60_000, 15_000 * 2 ** (attempts - 1));
        await this.prisma.telegramDelivery.update({
          where: { id: d.id },
          data: {
            status: "failed",
            attempts: permanent ? MAX_DELIVERY_ATTEMPTS : attempts,
            lastError: redact(r.error).slice(0, 500),
            nextAttemptAt: new Date(this.clock.now().getTime() + backoffMs),
          },
        });
        blockedReports.add(d.reportHash);
        if (r.retryAfterMs) break; // rate limited: stop this cycle
      }
    }
    return { sent, failed, deferred };
  }

  private async sendOne(chatId: string, text: string): Promise<{ ok: true; messageId: string } | { ok: false; error: string; permanent: boolean; retryAfterMs?: number }> {
    const wait = this.lastSentAt + MIN_SPACING_MS - this.clock.now().getTime();
    if (wait > 0) await this.sleep(wait);
    this.lastSentAt = this.clock.now().getTime();
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${this.cfg.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id?: number }; description?: string; parameters?: { retry_after?: number } };
      if (res.ok && body.ok) return { ok: true, messageId: String(body.result?.message_id ?? "") };
      if (res.status === 429) return { ok: false, error: `429 ${body.description ?? ""}`, permanent: false, retryAfterMs: ((body.parameters?.retry_after ?? 30) + 1) * 1000 };
      if (res.status >= 500) return { ok: false, error: `${res.status} ${body.description ?? ""}`, permanent: false };
      // 400/401/403/404: configuration or formatting problem; do not hammer the API.
      return { ok: false, error: `${res.status} ${body.description ?? ""}`, permanent: true };
    } catch (err) {
      return { ok: false, error: redact(err), permanent: false };
    }
  }
}
