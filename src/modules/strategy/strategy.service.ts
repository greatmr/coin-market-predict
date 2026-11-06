import { Inject, Injectable } from '@nestjs/common';

import type { IsoDate } from '../../common/utils/dates.js';
import { sha256 } from '../../common/utils/decimal.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { type Overrides, loadOverrides } from './overrides/overrides.js';
import { RULES, RULESET_VERSION, STRATEGY_NAME } from './strategy.constants.js';
import { type LbankContext, type LbankCrawlView, buildLbankContext } from './tier1/lbank.js';
import { type AssetMarketsView, type VenueSummary, venueSummary } from './tier1/venue-summary.js';
import {
  type CurrentInput,
  type DailyInput,
  type VmcEvaluation,
  evaluateVmc,
} from './tier1/vmc.js';
import {
  CANDLE_STATES,
  EVENT_DAYS,
  FINAL_DECISIONS,
  JUDGMENTS,
  MARKET_REGIMES,
  VENUE_DECISIONS,
} from './tier2/review-rules.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The strategy's entry point for the other modules. The rules themselves are pure functions
 * (`tier1/*`, `tier2/*`, exported from `index.ts`); this service binds the operator-configurable
 * parts once — quote age, LBank list age and tradability policy (D1), venue data age, the override
 * file — so every caller applies the same values, and versions them for lineage.
 */
@Injectable()
export class StrategyService {
  readonly rulesetVersion = RULESET_VERSION;
  readonly rules = RULES;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** A current quote older than this is STALE (p.12; default 2 × the crawl interval). */
  get maxQuoteAgeMs(): number {
    return this.cfg.MAX_QUOTE_AGE_MINUTES * MINUTE;
  }

  /** Beyond this age the LBank Spot markets list is stale: LBank status UNKNOWN (D2). */
  get lbankMaxAgeMs(): number {
    return this.cfg.LBANK_PAIRS_MAX_AGE_DAYS * DAY;
  }

  /** Operator decision D1: a listed pair counts as tradable unless manual verification is required (A7). */
  get listingIsTradable(): boolean {
    return !this.cfg.LBANK_REQUIRE_MANUAL_VERIFICATION;
  }

  /** CMC Markets venue rows older than twice their refresh period are stale (p.15). */
  get venueMaxAgeMs(): number {
    return 2 * this.cfg.TIER1_VENUE_REFRESH_HOURS * HOUR;
  }

  /** The versioned manual override list (p.9, p.18); throws when the file is invalid. */
  loadOverrides(): Overrides {
    return loadOverrides(this.cfg.TIER1_OVERRIDES_FILE);
  }

  /** Hash of everything that can change a result besides the inputs: rules, thresholds, overrides. */
  configVersion(overrides: Overrides): string {
    return sha256(
      JSON.stringify({
        RULESET_VERSION,
        RULES,
        maxQuoteAgeMinutes: this.cfg.MAX_QUOTE_AGE_MINUTES,
        lbankMaxAgeDays: this.cfg.LBANK_PAIRS_MAX_AGE_DAYS,
        lbankManualVerification: this.cfg.LBANK_REQUIRE_MANUAL_VERIFICATION,
        overrides: overrides.hash,
      }),
    ).slice(0, 12);
  }

  lbankContext(crawl: LbankCrawlView | null, asOf: Date): LbankContext {
    return buildLbankContext(crawl, asOf, this.lbankMaxAgeMs, {
      listingIsTradable: this.listingIsTradable,
    });
  }

  evaluateVmc(
    asOf: Date,
    rows: ReadonlyMap<IsoDate, DailyInput>,
    current: CurrentInput,
  ): VmcEvaluation {
    return evaluateVmc(asOf, rows, current, this.maxQuoteAgeMs);
  }

  venueSummary(cmcId: number, crawl: AssetMarketsView | null, asOf: Date): VenueSummary {
    return venueSummary(cmcId, crawl, asOf, this.venueMaxAgeMs);
  }

  /** What the dashboard shows about the strategy (rules, thresholds, override list, review vocabulary). */
  describe() {
    let overrides: { version: string; count: number } | { error: string };
    try {
      const o = this.loadOverrides();
      overrides = { version: o.version, count: o.count };
    } catch (err) {
      overrides = { error: err instanceof Error ? err.message : String(err) };
    }
    return {
      strategy: {
        name: STRATEGY_NAME,
        rulesetVersion: RULESET_VERSION,
        rules: RULES,
        crawlIntervalMinutes: this.cfg.CRAWL_EXPECTED_INTERVAL_MINUTES,
        maxQuoteAgeMinutes: this.cfg.MAX_QUOTE_AGE_MINUTES,
        dailyLookbackDays: this.cfg.TIER1_DAILY_LOOKBACK_DAYS,
        venueRefreshHours: this.cfg.TIER1_VENUE_REFRESH_HOURS,
        lbank: {
          refreshDays: this.cfg.LBANK_PAIRS_REFRESH_DAYS,
          maxAgeDays: this.cfg.LBANK_PAIRS_MAX_AGE_DAYS,
          requireManualVerification: this.cfg.LBANK_REQUIRE_MANUAL_VERIFICATION,
        },
        overrides,
      },
      review: {
        venueDecisions: VENUE_DECISIONS,
        eventDays: EVENT_DAYS,
        judgments: JUDGMENTS,
        candleStates: CANDLE_STATES,
        marketRegimes: MARKET_REGIMES,
        finalDecisions: FINAL_DECISIONS,
      },
    };
  }
}
