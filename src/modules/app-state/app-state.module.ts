import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppStateService } from './app-state.service.js';
import { AppState } from './entities/app-state.entity.js';

/** Small durable key/value store shared by Telegram (access list, bot offset), retention and the fixture source. */
@Module({
  imports: [TypeOrmModule.forFeature([AppState])],
  providers: [AppStateService],
  exports: [AppStateService],
})
export class AppStateModule {}
