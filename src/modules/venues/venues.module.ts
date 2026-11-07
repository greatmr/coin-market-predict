import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SourcesModule } from '../sources/sources.module.js';

import { VenueCrawl } from './entities/venue-crawl.entity.js';
import { VenueDecision } from './entities/venue-decision.entity.js';
import { VenueMappingTask } from './entities/venue-mapping-task.entity.js';
import { VenuePairEvent } from './entities/venue-pair-event.entity.js';
import { VenuesService } from './venues.service.js';

/** Venue evidence: the LBank Spot markets list, CMC Markets venue rows, listing events, decisions and mapping tasks. */
@Module({
  imports: [
    TypeOrmModule.forFeature([VenueCrawl, VenuePairEvent, VenueDecision, VenueMappingTask]),
    SourcesModule,
  ],
  providers: [VenuesService],
  exports: [VenuesService],
})
export class VenuesModule {}
