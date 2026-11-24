import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CutoverService } from './cutover.service.js';
import { SignalCutover } from './entities/signal-cutover.entity.js';
import { PublishedQueueService } from './published-queue.service.js';

/**
 * The CMC star-event layer shared by both trackers (docs/adr/0009-lbank-spot-observation.md): the
 * event rule (`star-event.rules.ts`), the reader of a batch's published Review Queue, and the
 * persisted cutover that routes each sighting to exactly one tracker. It owns no events itself.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SignalCutover])],
  providers: [PublishedQueueService, CutoverService],
  exports: [PublishedQueueService, CutoverService],
})
export class StarEventsModule {}
