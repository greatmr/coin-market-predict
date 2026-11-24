import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, In, LessThanOrEqual } from 'typeorm';

import { D, type DValue } from '../../common/utils/decimal.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { VenueCrawl } from '../venues/entities/venue-crawl.entity.js';
import { EXCHANGE_LISTS, availability, listView } from '../venues/exchange-lists.js';

import { MarketListFetch } from './entities/market-list-fetch.entity.js';
import type { FuturesContract } from './kline.js';
import { LBANK_MARKET_SOURCE, type LbankMarketSource } from './lbank-market.source.js';
import { type FuturesEvidenceInput, lbankContractFromUrl } from './observation-rules.js';
import type { ListingStatus, MarketListKind } from './observation.constants.js';

/** LBank's own markets lists, fetched once per run when an observation needs evidence. */
export interface FetchedLists {
  spot:
    | { fetchId: number; fetchedAt: Date; symbols: ReadonlySet<string> }
    | { fetchId: number; error: string }
    | null;
  futures:
    | { fetchId: number; fetchedAt: Date; contracts: ReadonlyMap<string, FuturesContract> }
    | { fetchId: number; error: string }
    | null;
}

/** CMC's LBank Futures list as it stood before a signal (the latest list fetched at or before t0). */
export interface CmcFuturesAt {
  status: ListingStatus;
  reason: string | null;
  contracts: string[];
  marketPairs: readonly string[];
  crawlId: string | null;
  fetchedAt: string | null;
  listStatus: string;
}

/**
 * Eligibility evidence for observations (docs/lbank-spot-observation.md § 3): LBank's own Spot pairs
 * and Futures contracts lists fetched near the signal, and CMC's LBank Futures list (by CMC id) as
 * it stood before the signal. Each observation keeps only the extract it used.
 */
@Injectable()
export class ListingEvidenceService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(LBANK_MARKET_SOURCE) private readonly source: LbankMarketSource,
  ) {}

  private async record(
    kind: MarketListKind,
    f: {
      ok: boolean;
      url: string;
      fetchedAt: Date;
      count: number;
      sha256: string | null;
      error: string | null;
    },
  ) {
    const row = await this.db.getRepository(MarketListFetch).save(
      this.db.getRepository(MarketListFetch).create({
        kind,
        fetchedAt: f.fetchedAt,
        ok: f.ok,
        source: f.url,
        itemCount: f.count,
        contentSha256: f.sha256,
        error: f.error,
      }),
    );
    return row.id;
  }

  /** Fetch both LBank lists now (two to three requests) and record each fetch. */
  async fetchLists(): Promise<FetchedLists> {
    const spot = await this.source.spotPairs();
    const spotId = await this.record('spot_pairs', {
      ok: spot.ok,
      url: spot.url,
      fetchedAt: spot.fetchedAt,
      count: spot.ok ? spot.items.length : 0,
      sha256: spot.ok ? spot.sha256 : null,
      error: spot.ok ? null : spot.error.slice(0, 500),
    });
    const fut = await this.source.futuresContracts();
    const futId = await this.record('futures_instruments', {
      ok: fut.ok,
      url: fut.url,
      fetchedAt: fut.fetchedAt,
      count: fut.ok ? fut.items.length : 0,
      sha256: fut.ok ? fut.sha256 : null,
      error: fut.ok ? null : fut.error.slice(0, 500),
    });
    return {
      spot: spot.ok
        ? { fetchId: spotId, fetchedAt: spot.fetchedAt, symbols: new Set(spot.items) }
        : { fetchId: spotId, error: spot.error },
      futures: fut.ok
        ? {
            fetchId: futId,
            fetchedAt: fut.fetchedAt,
            contracts: new Map(fut.items.map((c) => [c.symbol, c])),
          }
        : { fetchId: futId, error: fut.error },
    };
  }

  /** CMC's LBank Futures list as of `at` for each CMC id (one list read per distinct signal time). */
  async cmcFuturesAt(
    providerId: string,
    at: Date,
    coins: ReadonlyArray<{ cmcId: number; symbol: string }>,
  ): Promise<Map<number, CmcFuturesAt>> {
    const spec = EXCHANGE_LISTS.lbankFutures;
    const repo = this.db.getRepository(VenueCrawl);
    const complete = await repo.findOne({
      where: { providerId, kind: spec.kind, status: 'COMPLETE', finishedAt: LessThanOrEqual(at) },
      order: { finishedAt: 'DESC' },
    });
    const attempt = await repo.findOne({
      where: {
        providerId,
        kind: spec.kind,
        status: In(['COMPLETE', 'INCOMPLETE', 'FAILED']),
        finishedAt: LessThanOrEqual(at),
      },
      order: { finishedAt: 'DESC' },
      select: { id: true, status: true, finishedAt: true, fetchedCount: true, error: true },
    });
    const view = listView(
      spec,
      complete
        ? {
            id: complete.id,
            status: complete.status as 'COMPLETE',
            finishedAt: complete.finishedAt,
            fetchedCount: complete.fetchedCount,
            error: complete.error,
            pairs: complete.pairs,
          }
        : null,
      attempt
        ? {
            id: attempt.id,
            status: attempt.status as 'COMPLETE' | 'INCOMPLETE' | 'FAILED',
            finishedAt: attempt.finishedAt,
            fetchedCount: attempt.fetchedCount,
            error: attempt.error,
          }
        : null,
      at,
      this.cfg.EXCHANGE_LISTS_MAX_AGE_HOURS * 3_600_000,
      true,
    );
    const out = new Map<number, CmcFuturesAt>();
    for (const c of coins) {
      const a = availability(view, c.cmcId, c.symbol);
      const contracts =
        a.status === 'YES' && complete
          ? [
              ...new Set(
                complete.pairs
                  .filter(
                    (p) => p.baseCurrencyId === c.cmcId && spec.categories.includes(p.category),
                  )
                  .map((p) => lbankContractFromUrl(p.marketUrl))
                  .filter((s): s is string => !!s),
              ),
            ]
          : [];
      out.set(c.cmcId, {
        status: a.status,
        reason: a.reason,
        contracts,
        marketPairs: a.pairs,
        crawlId: view.crawlId,
        fetchedAt: view.fetchedAt?.toISOString() ?? null,
        listStatus: view.status,
      });
    }
    return out;
  }
}

/** The LBank contract list as the futures rule reads it (base ticker and 24 h volume per symbol). */
export function futuresInput(
  cmc: CmcFuturesAt,
  lbank: ReadonlyMap<string, FuturesContract> | null,
  coinSymbol: string,
): FuturesEvidenceInput {
  return {
    cmc: {
      status: cmc.status,
      contracts: cmc.contracts,
      reason: cmc.listStatus === 'VERIFIED' ? cmc.reason : `LIST_${cmc.listStatus}`,
    },
    lbank: lbank
      ? {
          contracts: new Map(
            [...lbank.values()].map((c) => [
              c.symbol,
              {
                base: c.base,
                volume24h: c.volume24h === null ? null : (new D(c.volume24h) as DValue),
              },
            ]),
          ),
        }
      : null,
    coinSymbol,
  };
}
