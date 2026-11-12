import {
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
  AgentBusyError,
  AgentLimitError,
  AgentNoRecordError,
  AgentService,
  AgentUnavailableError,
} from '../agent/agent.service.js';
import { type AuthContext, CurrentAuth, RequirePermission } from '../auth/auth.guard.js';

import { CmcIdSchema } from './dto/common.dto.js';

/**
 * The Claude coin agent (owner only): its status and history for one coin, and starting a run.
 * Runs are limited to AGENT_MAX_RUNS per rolling AGENT_WINDOW_HOURS for all owners together.
 */
@Controller('assets')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @RequirePermission('agent:use')
  @Get(':cmcId/agent')
  status(@Param('cmcId', new ZodValidationPipe(CmcIdSchema)) cmcId: number) {
    return this.agent.forCoin(cmcId);
  }

  /** Start an analysis; it runs in the background and the response is its RUNNING record. */
  @RequirePermission('agent:use')
  @Post(':cmcId/agent')
  async run(
    @Param('cmcId', new ZodValidationPipe(CmcIdSchema)) cmcId: number,
    @CurrentAuth() a: AuthContext,
  ) {
    try {
      return await this.agent.start(cmcId, { id: a.user.id, username: a.user.username });
    } catch (err) {
      if (err instanceof AgentUnavailableError)
        throw new ServiceUnavailableException({
          message: err.message,
          code: ErrorCodes.AGENT_UNAVAILABLE,
        });
      if (err instanceof AgentNoRecordError)
        throw new NotFoundException({
          message: err.message,
          code: ErrorCodes.TIER1_RECORD_NOT_FOUND,
        });
      if (err instanceof AgentBusyError)
        throw new ConflictException({
          message: `Claude is already analysing ${err.running.symbol} (started ${err.running.requestedAt.toISOString()} by ${err.running.requestedBy}). Wait for it to finish.`,
          code: ErrorCodes.AGENT_BUSY,
        });
      if (err instanceof AgentLimitError) {
        const q = err.quota;
        throw new HttpException(
          {
            message: `The agent has used ${q.used} of ${q.max} runs in the last ${q.windowHours} hours. The next run is possible at ${q.nextFreeAt ?? 'a later time'} (UTC).`,
            code: ErrorCodes.AGENT_LIMIT_REACHED,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw err;
    }
  }
}
