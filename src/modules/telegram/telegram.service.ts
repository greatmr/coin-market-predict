import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { type DataSource, In, LessThanOrEqual } from 'typeorm';

import { insertRows } from '../../common/entities/insert.js';
import { redact } from '../../common/security/redact.js';
import { type Clock, sleep as realSleep, systemClock } from '../../common/utils/time.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { TelegramAccessService } from './access.service.js';
import { TELEGRAM_DOCUMENT_LIMIT_BYTES, parseDocumentPart } from './attachment.js';
import { TelegramDelivery } from './entities/telegram-delivery.entity.js';

export const TELEGRAM_FETCH = Symbol('TELEGRAM_FETCH');
export const MAX_DELIVERY_ATTEMPTS = 6;
const MIN_SPACING_MS = 1_500;
/** A network outage (fetch failed, timeout) is retried for this long before a report is given up on. */
export const NETWORK_RETRY_WINDOW_MS = 24 * 3_600_000;
const NETWORK_BACKOFF_CAP_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string; permanent: boolean; retryAfterMs?: number; network?: boolean };

export interface DeliverySummary {
  mode: string;
  prepared: number;
  duplicatesSuppressed: number;
}

/**
 * Telegram delivery, decoupled from the pipeline: reports are first written to
 * `telegram_delivery` rows (idempotent via reportHash + part + chat), then sent by
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
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(TELEGRAM_FETCH) private readonly fetchImpl: typeof fetch,
    private readonly access: TelegramAccessService,
  ) {}

  get mode() {
    return this.cfg.TELEGRAM_MODE;
  }

  private username: string | null = null;

  /**
   * The bot's @username (without "@"), once loaded. Reports use it to make coin names tappable
   * deep links (t.me/<bot>?start=coin_<id>); while it is unknown they fall back to /coin_<id>.
   */
  get botUsername(): string | null {
    return this.username;
  }

  /** Look the username up with getMe and cache it; null when there is no token or the call fails. */
  async loadBotUsername(): Promise<string | null> {
    if (this.username || !this.cfg.TELEGRAM_BOT_TOKEN) return this.username;
    try {
      const res = await this.fetchImpl(
        `https://api.telegram.org/bot${this.cfg.TELEGRAM_BOT_TOKEN}/getMe`,
        { method: 'POST', signal: AbortSignal.timeout(15_000) },
      );
      const body = (await res.json()) as { ok?: boolean; result?: { username?: unknown } };
      const name = body.ok ? body.result?.username : null;
      // Telegram usernames are 5–32 of [A-Za-z0-9_]; anything else is never put into a link.
      if (typeof name === 'string' && /^[A-Za-z0-9_]{5,32}$/.test(name)) this.username = name;
    } catch {
      /* offline or token rejected: reports keep the /coin_<id> commands */
    }
    return this.username;
  }

  private get deliveries() {
    return this.db.getRepository(TelegramDelivery);
  }

  private chatId(): string {
    return this.cfg.TELEGRAM_MODE === 'live'
      ? this.cfg.TELEGRAM_CHAT_ID!
      : (this.cfg.TELEGRAM_CHAT_ID ?? 'dry-run');
  }

  /** Includes the mode so a dry-run copy never suppresses the later live delivery. */
  static reportHash(runId: string, parts: string[], mode = 'live'): string {
    return createHash('sha256')
      .update(mode)
      .update('\u0000')
      .update(runId)
      .update('\u0000')
      .update(parts.join('\u0001'))
      .digest('hex')
      .slice(0, 40);
  }

  /** Check the bot token and chat without sending anything. Never returns the token. */
  async verify(): Promise<{
    ok: boolean;
    bot?: string;
    chatType?: string;
    chatTitle?: string;
    error?: string;
  }> {
    if (!this.cfg.TELEGRAM_BOT_TOKEN || !this.cfg.TELEGRAM_CHAT_ID)
      return { ok: false, error: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required' };
    const call = async (method: string, body: unknown) => {
      const res = await this.fetchImpl(
        `https://api.telegram.org/bot${this.cfg.TELEGRAM_BOT_TOKEN}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        },
      );
      return (await res.json()) as {
        ok: boolean;
        description?: string;
        result?: Record<string, unknown>;
      };
    };
    try {
      const me = await call('getMe', {});
      if (!me.ok) return { ok: false, error: `bot token rejected: ${me.description ?? 'unknown'}` };
      const chat = await call('getChat', { chat_id: this.cfg.TELEGRAM_CHAT_ID });
      if (!chat.ok)
        return {
          ok: false,
          bot: `@${me.result?.username}`,
          error: `chat not reachable: ${chat.description ?? 'unknown'}`,
        };
      return {
        ok: true,
        bot: `@${me.result?.username}`,
        chatType: String(chat.result?.type),
        chatTitle: String(chat.result?.title ?? chat.result?.first_name ?? ''),
      };
    } catch (err) {
      return { ok: false, error: redact(err) };
    }
  }

  /** Send one short test message immediately (bypasses the delivery queue). */
  async sendTest(text: string) {
    if (!this.cfg.TELEGRAM_BOT_TOKEN || !this.cfg.TELEGRAM_CHAT_ID)
      return {
        ok: false as const,
        error: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required',
        permanent: true,
      };
    return this.sendOne(this.cfg.TELEGRAM_CHAT_ID, text);
  }

  async prepare(runId: string, parts: string[]): Promise<DeliverySummary> {
    if (this.cfg.TELEGRAM_MODE === 'disabled')
      return { mode: 'disabled', prepared: 0, duplicatesSuppressed: 0 };
    const hash = TelegramService.reportHash(runId, parts, this.cfg.TELEGRAM_MODE);
    // Live reports go to the owner and every approved member; dry runs only ever store the owner's copy.
    const chats =
      this.cfg.TELEGRAM_MODE === 'live'
        ? [this.chatId(), ...(await this.access.members()).filter((c) => c !== this.chatId())]
        : [this.chatId()];
    const mode = this.cfg.TELEGRAM_MODE;
    const prepared = await insertRows(
      this.db.manager,
      TelegramDelivery,
      chats.flatMap((chatId) =>
        parts.map((text, i) => ({
          runId,
          reportHash: hash,
          partIndex: i,
          partCount: parts.length,
          chatId,
          mode,
          status: mode === 'live' ? ('pending' as const) : ('dry_run' as const),
          text,
          nextAttemptAt: this.clock.now(),
        })),
      ),
      { ignoreConflicts: true },
    );
    if (mode === 'dry_run' && prepared > 0) {
      this.log.log(
        `[dry-run] Telegram report for run ${runId} (${parts.length} part(s)) stored; not sent.`,
      );
    }
    return { mode, prepared, duplicatesSuppressed: parts.length * chats.length - prepared };
  }

  private delivering: Promise<{ sent: number; failed: number; deferred: number }> | null = null;

  /**
   * Send pending live deliveries in order. Concurrent callers (pipeline, the 5-minute retry job,
   * a manual send from the dashboard) share one pass so a message is never sent twice.
   */
  deliverPending(limit = 30): Promise<{ sent: number; failed: number; deferred: number }> {
    this.delivering ??= this.deliverNow(limit).finally(() => {
      this.delivering = null;
    });
    return this.delivering;
  }

  private async deliverNow(
    limit: number,
  ): Promise<{ sent: number; failed: number; deferred: number }> {
    if (this.cfg.TELEGRAM_MODE !== 'live' || !this.cfg.TELEGRAM_BOT_TOKEN)
      return { sent: 0, failed: 0, deferred: 0 };
    // nextAttemptAt is null once a delivery is given up on, so it is never picked up again here.
    const due = await this.deliveries.find({
      where: {
        mode: 'live',
        status: In(['pending', 'failed']),
        nextAttemptAt: LessThanOrEqual(this.clock.now()),
      },
      order: { createdAt: 'ASC', partIndex: 'ASC' },
      take: limit,
    });
    let sent = 0;
    let failed = 0;
    let deferred = 0;
    const blockedReports = new Set<string>();
    for (const d of due) {
      // Keep parts in order: never send part N+1 before part N succeeded.
      // One recipient failing (e.g. they blocked the bot) must not hold back the others.
      const blockKey = `${d.reportHash}:${d.chatId}`;
      if (blockedReports.has(blockKey)) continue;
      if (d.partIndex > 0) {
        const prev = await this.deliveries.findOneBy({
          reportHash: d.reportHash,
          partIndex: d.partIndex - 1,
          chatId: d.chatId,
        });
        if (prev && prev.status !== 'sent') {
          blockedReports.add(blockKey);
          continue;
        }
      }
      const r = await this.sendOne(d.chatId, d.text);
      const attempts = d.attempts + 1;
      if (r.ok) {
        sent++;
        await this.deliveries.update(
          { id: d.id },
          {
            status: 'sent',
            attempts,
            sentAt: this.clock.now(),
            telegramMessageId: r.messageId,
            lastError: null,
          },
        );
      } else {
        const age = this.clock.now().getTime() - d.createdAt.getTime();
        const giveUp =
          r.permanent ||
          (r.network ? age > NETWORK_RETRY_WINDOW_MS : attempts >= MAX_DELIVERY_ATTEMPTS);
        if (giveUp) failed++;
        else deferred++;
        const backoffMs =
          r.retryAfterMs ??
          Math.min(
            r.network ? NETWORK_BACKOFF_CAP_MS : MAX_BACKOFF_MS,
            15_000 * 2 ** Math.min(attempts - 1, 10),
          );
        await this.deliveries.update(
          { id: d.id },
          {
            status: 'failed',
            attempts: giveUp ? Math.max(attempts, MAX_DELIVERY_ATTEMPTS) : attempts,
            lastError: redact(r.error).slice(0, 500),
            nextAttemptAt: giveUp ? null : new Date(this.clock.now().getTime() + backoffMs),
          },
        );
        blockedReports.add(blockKey);
        if (r.retryAfterMs) break; // rate limited: stop this cycle
      }
    }
    return { sent, failed, deferred };
  }

  /** Make unsent deliveries (including given-up ones) eligible again right now. Returns how many were reset. */
  async requeue(runId: string, chatIds?: string[]): Promise<number> {
    const res = await this.deliveries.update(
      {
        runId,
        mode: 'live',
        status: In(['pending', 'failed']),
        ...(chatIds ? { chatId: In(chatIds) } : {}),
      },
      { status: 'pending', attempts: 0, nextAttemptAt: this.clock.now(), lastError: null },
    );
    return res.affected ?? 0;
  }

  /** Queue a fresh copy of a report for specific chats (distinct hash, so earlier sends never suppress it). */
  async queueCopy(runId: string, parts: string[], chatIds: string[]): Promise<number> {
    const hash = TelegramService.reportHash(
      runId,
      parts,
      `live:manual:${this.clock.now().getTime()}`,
    );
    return insertRows(
      this.db.manager,
      TelegramDelivery,
      chatIds.flatMap((chatId) =>
        parts.map((text, i) => ({
          runId,
          reportHash: hash,
          partIndex: i,
          partCount: parts.length,
          chatId,
          mode: 'live' as const,
          status: 'pending' as const,
          text,
          nextAttemptAt: this.clock.now(),
        })),
      ),
      { ignoreConflicts: true },
    );
  }

  /** Direct reply (used by the command handler); same rate spacing, retries are the caller's. */
  reply(chatId: string, text: string) {
    return this.sendOne(chatId, text);
  }

  private async sendOne(chatId: string, text: string): Promise<SendResult> {
    const doc = parseDocumentPart(text);
    let upload: FormData | null = null;
    if (doc) {
      // Read the file before spacing/sending: a pruned or oversized export is a permanent failure.
      let data: Buffer;
      try {
        data = await readFile(doc.path);
      } catch {
        return {
          ok: false,
          error: `export file ${basename(doc.path)} is no longer available (pruned after EXPORT_RETENTION_DAYS?)`,
          permanent: true,
        };
      }
      if (data.length > TELEGRAM_DOCUMENT_LIMIT_BYTES)
        return {
          ok: false,
          error: `export file is ${data.length} bytes, above Telegram's 50 MB bot limit`,
          permanent: true,
        };
      upload = new FormData();
      upload.append('chat_id', chatId);
      if (doc.caption) {
        upload.append('caption', doc.caption);
        upload.append('parse_mode', 'HTML');
      }
      upload.append(
        'document',
        new Blob([new Uint8Array(data)], { type: doc.mimeType }),
        doc.filename,
      );
    }
    const wait = this.lastSentAt + MIN_SPACING_MS - this.clock.now().getTime();
    if (wait > 0) await this.sleep(wait);
    this.lastSentAt = this.clock.now().getTime();
    try {
      const res = upload
        ? await this.fetchImpl(
            `https://api.telegram.org/bot${this.cfg.TELEGRAM_BOT_TOKEN}/sendDocument`,
            { method: 'POST', body: upload, signal: AbortSignal.timeout(120_000) },
          )
        : await this.fetchImpl(
            `https://api.telegram.org/bot${this.cfg.TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                text,
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
              }),
              signal: AbortSignal.timeout(20_000),
            },
          );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: { message_id?: number };
        description?: string;
        parameters?: { retry_after?: number };
      };
      if (res.ok && body.ok) return { ok: true, messageId: String(body.result?.message_id ?? '') };
      if (res.status === 429)
        return {
          ok: false,
          error: `429 ${body.description ?? ''}`,
          permanent: false,
          retryAfterMs: ((body.parameters?.retry_after ?? 30) + 1) * 1000,
        };
      if (res.status >= 500)
        return { ok: false, error: `${res.status} ${body.description ?? ''}`, permanent: false };
      // 400/401/403/404: configuration or formatting problem; do not hammer the API.
      return { ok: false, error: `${res.status} ${body.description ?? ''}`, permanent: true };
    } catch (err) {
      return { ok: false, error: redact(err), permanent: false, network: true };
    }
  }
}
