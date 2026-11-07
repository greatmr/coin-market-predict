import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { ErrorCodes } from '../../common/dto/error-codes.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { RequirePermission } from '../auth/auth.guard.js';
import { TelegramAccessService } from '../telegram/access.service.js';
import { TelegramAdminService } from '../telegram/admin.service.js';

import {
  type AccessAction,
  AccessActionSchema,
  type AccessBodyDto,
  AccessBodySchema,
  type MissingQueryDto,
  MissingQuerySchema,
  type RetryBodyDto,
  RetryBodySchema,
  type SendBodyDto,
  SendBodySchema,
} from './dto/telegram.dto.js';

/** Who receives the Telegram report, what they missed, and manual retries / sends. */
@Controller('telegram')
@RequirePermission('telegram:manage')
export class TelegramAccessController {
  constructor(
    private readonly access: TelegramAccessService,
    private readonly admin: TelegramAdminService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Get('access')
  async list() {
    const s = await this.access.list();
    const rows = (o: Record<string, { label: string; at: string }>) =>
      Object.entries(o)
        .map(([chatId, e]) => ({ chatId, label: e.label, at: e.at }))
        .sort((a, b) => b.at.localeCompare(a.at));
    return {
      owner: this.access.owner || null,
      mode: this.cfg.TELEGRAM_MODE,
      commandsEnabled: this.cfg.TELEGRAM_COMMANDS_ENABLED,
      canManage: true, // the whole controller needs telegram:manage
      missingCount: (await this.admin.missing(6)).length,
      members: rows(s.approved),
      pending: rows(s.pending),
      denied: s.denied,
    };
  }

  /** Reports a recipient did not receive (queued, retrying, given up, or never queued). */
  @Get('missing')
  async missing(@Query(new ZodValidationPipe(MissingQuerySchema)) q: MissingQueryDto) {
    const rows = await this.admin.missing(q.hours);
    return {
      hours: q.hours,
      mode: this.cfg.TELEGRAM_MODE,
      recipients: await this.admin.recipients(),
      rows,
    };
  }

  @Post('retry')
  async retry(@Body(new ZodValidationPipe(RetryBodySchema)) b: RetryBodyDto) {
    await this.assertKnownChat(b.chatId);
    return { ok: true, ...(await this.admin.retry({ runId: b.runId, chatId: b.chatId })) };
  }

  @Post('send')
  async send(@Body(new ZodValidationPipe(SendBodySchema)) b: SendBodyDto) {
    for (const c of b.chatIds ?? []) await this.assertKnownChat(c);
    return { ok: true, ...(await this.admin.sendReport({ runId: b.runId, chatIds: b.chatIds })) };
  }

  @Post('access/:action')
  async change(
    @Param('action', new ZodValidationPipe(AccessActionSchema)) action: AccessAction,
    @Body(new ZodValidationPipe(AccessBodySchema)) { chatId }: AccessBodyDto,
  ) {
    if (chatId === this.access.owner)
      throw new BadRequestException({
        message: 'That is the owner.',
        code: ErrorCodes.TELEGRAM_OWNER_TARGET,
      });
    if (action === 'approve') return { ok: true, ...(await this.admin.approve(chatId)) };
    if (action === 'reject') {
      await this.admin.deny(chatId);
      return { ok: true };
    }
    return { ok: true, removed: await this.admin.remove(chatId) };
  }

  /** Only the owner or an approved member can be a delivery target. */
  private async assertKnownChat(chatId: string | undefined) {
    if (chatId === undefined) return;
    if (!(await this.admin.recipients()).some((r) => r.chatId === chatId)) {
      throw new BadRequestException({
        message: 'Unknown recipient: only the owner and approved members can receive reports.',
        code: ErrorCodes.TELEGRAM_UNKNOWN_RECIPIENT,
      });
    }
  }
}
