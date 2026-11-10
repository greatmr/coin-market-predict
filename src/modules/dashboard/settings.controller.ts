import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import { ErrorCodes } from '../../common/dto/error-codes.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';

import { type AuthContext, CurrentAuth, RequirePermission } from '../auth/auth.guard.js';
import { SettingsError } from '../settings/settings.plan.js';
import { SettingsService } from '../settings/settings.service.js';

import {
  type SaveSettingsDto,
  SaveSettingsSchema,
  type SettingsHistoryQueryDto,
  SettingsHistoryQuerySchema,
} from './dto/settings.dto.js';

/** One error per setting, as `KEY: message`, so the dashboard can show it next to the field. */
function settingsHttpError(err: unknown): never {
  if (err instanceof SettingsError)
    throw new BadRequestException({
      errors: err.issues.map((i) => ({
        message: `${i.key}: ${i.message}`,
        code: ErrorCodes.SETTINGS_INVALID,
      })),
    });
  throw err;
}

/**
 * Owner-only dashboard settings: the operational configuration with where each value comes from,
 * validated saves (applied to the running server, or at the next start for start-up settings), the
 * import of values still set in the environment, and the change history.
 */
@Controller('settings')
@RequirePermission('settings:manage')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  view() {
    return this.settings.view();
  }

  @Put()
  save(
    @CurrentAuth() a: AuthContext,
    @Body(new ZodValidationPipe(SaveSettingsSchema)) body: SaveSettingsDto,
  ) {
    return this.settings
      .save(body, { userId: a.user.id, name: a.user.username, source: 'dashboard' })
      .catch(settingsHttpError);
  }

  @Post('import-env')
  @HttpCode(200)
  importEnvironment(@CurrentAuth() a: AuthContext) {
    return this.settings
      .importEnvironment({ userId: a.user.id, name: a.user.username })
      .catch(settingsHttpError);
  }

  @Get('history')
  history(@Query(new ZodValidationPipe(SettingsHistoryQuerySchema)) q: SettingsHistoryQueryDto) {
    return this.settings.history(q.limit);
  }
}
