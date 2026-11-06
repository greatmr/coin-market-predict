import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { ErrorCodes } from '../../common/dto/error-codes.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { assertTrustedWrite } from '../../common/security/write-guard.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { ReadModelService } from '../read-model/read-model.service.js';
import { type CreateReviewDto, CreateReviewSchema } from '../reviews/dto/create-review.dto.js';
import { type VenueDecisionDto, VenueDecisionSchema } from '../reviews/dto/venue-decision.dto.js';
import { ReviewInputError, ReviewService } from '../reviews/review.service.js';

import { UuidSchema } from './dto/common.dto.js';
import {
  type MappingTasksQueryDto,
  MappingTasksQuerySchema,
  type ReviewsQueryDto,
  ReviewsQuerySchema,
} from './dto/reviews.dto.js';

/** Human records: review revisions (Tier 1 venue decision + Tier 2 chart review / trade plan), LBank decisions, mapping tasks. */
@Controller()
export class ReviewsController {
  constructor(
    private readonly reviews: ReviewService,
    private readonly read: ReadModelService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** A review the strategy's rules refuse is a 400 with every reason. */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ReviewInputError)
        throw new BadRequestException({
          message: err.issues.join('; '),
          code: ErrorCodes.REVIEW_INVALID,
        });
      throw err;
    }
  }

  @Get('reviews')
  list(@Query(new ZodValidationPipe(ReviewsQuerySchema)) q: ReviewsQueryDto) {
    return this.reviews.list(this.cfg.DATA_SOURCE, q.cmcId);
  }

  @Get('reviews/:id/export')
  async export(@Param('id', new ZodValidationPipe(UuidSchema)) id: string) {
    const r = await this.reviews.exportReview(id);
    if (!r)
      throw new NotFoundException({
        message: 'review not found',
        code: ErrorCodes.REVIEW_NOT_FOUND,
      });
    return r;
  }

  /** Append a review revision (Tier 1 venue/event-day decision and/or Tier 2 chart review + trade plan). */
  @Post('reviews')
  create(
    @Body(new ZodValidationPipe(CreateReviewSchema)) body: CreateReviewDto,
    @Req() req: Request,
  ) {
    assertTrustedWrite(req, this.cfg);
    return this.guarded(() => this.reviews.create(body));
  }

  /** Append an LBank venue decision (tradability verification or mapping evidence). */
  @Post('venue-decisions')
  venueDecision(
    @Body(new ZodValidationPipe(VenueDecisionSchema)) body: VenueDecisionDto,
    @Req() req: Request,
  ) {
    assertTrustedWrite(req, this.cfg);
    return this.guarded(() => this.reviews.decideVenue(body, this.cfg.DATA_SOURCE));
  }

  @Get('mapping-tasks')
  mappingTasks(@Query(new ZodValidationPipe(MappingTasksQuerySchema)) q: MappingTasksQueryDto) {
    return this.read.mappingTasks(q.status, 200);
  }
}
