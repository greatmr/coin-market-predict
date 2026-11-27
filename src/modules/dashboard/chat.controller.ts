import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';

import { ErrorCodes } from '../../common/dto/error-codes.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';

import {
  ChatBusyError,
  ChatLimitError,
  ChatNotFoundError,
  ChatService,
  ChatUnavailableError,
} from '../agent/chat/chat.service.js';
import { type AuthContext, CurrentAuth, RequirePermission } from '../auth/auth.guard.js';

import { type ChatSendDto, ChatSendSchema } from './dto/chat.dto.js';
import { UuidSchema } from './dto/common.dto.js';

/**
 * The Claude chat (owner only, `chat:use`). Read-only towards the panel: it stores its own
 * conversations and nothing else. A reply is written in the background; the page polls the
 * conversation.
 */
@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @RequirePermission('chat:use')
  @Get('status')
  status() {
    return this.chat.status();
  }

  @RequirePermission('chat:use')
  @Get('conversations')
  list(@CurrentAuth() a: AuthContext) {
    return this.chat.list({ id: a.user.id, username: a.user.username });
  }

  @RequirePermission('chat:use')
  @Get('conversations/:id')
  async one(
    @Param('id', new ZodValidationPipe(UuidSchema)) id: string,
    @CurrentAuth() a: AuthContext,
  ) {
    try {
      return await this.chat.get(id, { id: a.user.id, username: a.user.username });
    } catch (err) {
      throw mapChatError(err);
    }
  }

  @RequirePermission('chat:use')
  @Post('messages')
  async send(
    @Body(new ZodValidationPipe(ChatSendSchema)) body: ChatSendDto,
    @CurrentAuth() a: AuthContext,
  ) {
    try {
      return await this.chat.send(body, { id: a.user.id, username: a.user.username });
    } catch (err) {
      throw mapChatError(err);
    }
  }
}

function mapChatError(err: unknown): unknown {
  if (err instanceof ChatUnavailableError)
    return new ServiceUnavailableException({
      message: err.message,
      code: ErrorCodes.CHAT_UNAVAILABLE,
    });
  if (err instanceof ChatNotFoundError)
    return new NotFoundException({ message: err.message, code: ErrorCodes.CHAT_NOT_FOUND });
  if (err instanceof ChatBusyError)
    return new ConflictException({
      message: 'Claude is still writing a reply. Wait for it to finish.',
      code: ErrorCodes.CHAT_BUSY,
    });
  if (err instanceof ChatLimitError)
    return new HttpException(
      {
        message: `This conversation has used its ${err.quota.max} messages. Start a new conversation to continue.`,
        code: ErrorCodes.CHAT_LIMIT_REACHED,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  return err;
}
