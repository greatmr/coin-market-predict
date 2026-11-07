import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';

import { ErrorCodes } from '../../common/dto/error-codes.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';

import { ReadModelService } from '../read-model/read-model.service.js';

import {
  type AssetsQueryDto,
  AssetsQuerySchema,
  type SnapshotsQueryDto,
  SnapshotsQuerySchema,
} from './dto/assets.dto.js';
import { CmcIdSchema, type OptionalBatchDto, OptionalBatchSchema } from './dto/common.dto.js';

/** CMC assets, their stored snapshots and the full Tier 1 calculation trace (PDF p.20 #2). */
@Controller('assets')
export class AssetsController {
  constructor(private readonly read: ReadModelService) {}

  @Get()
  list(@Query(new ZodValidationPipe(AssetsQuerySchema)) q: AssetsQueryDto) {
    return this.read.listAssets({ search: q.search, limit: q.limit, offset: q.offset });
  }

  @Get(':cmcId/trace')
  async trace(
    @Param('cmcId', new ZodValidationPipe(CmcIdSchema)) cmcId: number,
    @Query(new ZodValidationPipe(OptionalBatchSchema)) q: OptionalBatchDto,
  ) {
    const t = await this.read.assetTrace(cmcId, q.batchId);
    if (!t)
      throw new NotFoundException({
        message: 'no Tier 1 record for this CMC id',
        code: ErrorCodes.TIER1_RECORD_NOT_FOUND,
      });
    return t;
  }

  @Get(':cmcId/snapshots')
  snapshots(
    @Param('cmcId', new ZodValidationPipe(CmcIdSchema)) cmcId: number,
    @Query(new ZodValidationPipe(SnapshotsQuerySchema)) q: SnapshotsQueryDto,
  ) {
    return this.read.snapshots(cmcId, q.hours);
  }
}
