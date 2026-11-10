import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppSettingChange } from './entities/app-setting-change.entity.js';
import { AppSetting } from './entities/app-setting.entity.js';
import { SettingsService } from './settings.service.js';

/**
 * Dashboard settings (`docs/adr/0005-dashboard-settings.md`): the operational configuration saved in
 * the database, validated with the environment and applied to the running process. The HTTP routes
 * are in the dashboard module (`/api/settings`, owner only); the CLI has `settings:*`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AppSetting, AppSettingChange])],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
