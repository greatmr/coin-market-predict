import { Module } from '@nestjs/common';

import { StrategyService } from './strategy.service.js';

/**
 * Core business: the Two-Tier VMC strategy (docs/strategy-two-tier-vmc.md). It owns the rules —
 * eligibility, VMC windows, LBank resolution, venue facts, queue order, review and trade-plan
 * validation, overrides — and nothing else: no database, HTTP, scheduling or delivery code. Other
 * modules import its pure functions and types from `index.ts` and inject `StrategyService` for the
 * configured thresholds.
 */
@Module({ providers: [StrategyService], exports: [StrategyService] })
export class StrategyModule {}
