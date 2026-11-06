import { redact } from '../../../common/security/redact.js';
import { DAY_MS, parseIsoDate } from '../../../common/utils/dates.js';

import { LBANK } from '../../strategy/index.js';
import type { VenuePair } from '../../strategy/index.js';
import type {
  CollectOptions,
  CollectResult,
  DailyFetch,
  DiscoveryResult,
  MarketDataSource,
  Tier1Source,
  VenueFetch,
} from '../source.types.js';

import {
  CMC_WEB_PROVIDER,
  CmcWebClient,
  WEB_COIN_PAIRS,
  WEB_EXCHANGE_PAIRS,
  WEB_HISTORY,
  WEB_LISTING,
} from './client.js';
import { CmcApiError } from './errors.js';
import { parseVenuePairs, parseWebDaily, parseWebListing } from './parse.js';

/**
 * Default page size. Verified 2026-11-03: limit=10000 returned all 8,041 listed coins in one
 * response. Multi-page sweeps sorted by market cap are unstable among the ~3,900 coins tied at
 * zero cap (rows repeat or vanish between requests), so one page is the reliable path.
 */
export const WEB_LISTING_PAGE_SIZE = 10_000;
/** LBank publishes ~900 spot pairs (2026-11-05); pages advance by what the server returns. */
const EXCHANGE_PAGE_SIZE = 500;
/** Rows each further page re-reads from the previous one (the list is volume-ordered and moves). */
const EXCHANGE_PAGE_OVERLAP = 50;
/** Coin Markets table: the top pairs by CMC's default ranking (coverage is reported). */
const COIN_PAIRS_LIMIT = 100;
const MAX_EXCHANGE_PAGES = 10;

/** One exchange market: CMC's market id when present, never the pair name alone (tickers can repeat). */
function pairKey(p: VenuePair): string {
  return p.marketId
    ? `market:${p.marketId}`
    : `${p.marketPair}|${p.category}|${p.baseCurrencyId ?? '?'}|${p.quoteCurrencyId ?? '?'}`;
}

export class CoinMarketCapWebSource implements MarketDataSource {
  readonly info = CMC_WEB_PROVIDER;
  private discoveryPage: {
    at: number;
    data: Awaited<ReturnType<CoinMarketCapWebSource['sweep']>>;
  } | null = null;
  constructor(
    private readonly client: CmcWebClient,
    private readonly discoveryMaxPages = 50,
    private readonly pageSize = WEB_LISTING_PAGE_SIZE,
  ) {}

  private async sweep(maxPages: number) {
    const before = this.client.requestsMade;
    const assets = new Map<string, ReturnType<typeof parseWebListing>['assets'][number]>();
    const observations = new Map<
      string,
      ReturnType<typeof parseWebListing>['observations'][number]
    >();
    let total = 0,
      pages = 0,
      skipped = 0,
      complete = false,
      start = 1;
    // Ranks can shift between page requests; re-reading a few rows at each boundary keeps a coin
    // that moved across it from being missed (duplicates collapse by provider id).
    const overlap = Math.min(50, Math.floor(this.pageSize / 20));
    const notes: string[] = [];
    while (pages < maxPages) {
      let page: ReturnType<typeof parseWebListing>;
      try {
        const r = await this.client.get(WEB_LISTING, {
          start,
          limit: this.pageSize,
          convertId: 2781,
          sortBy: 'market_cap',
          sortType: 'desc',
          cryptoType: 'all',
          tagType: 'all',
          audited: 'false',
        });
        page = parseWebListing(r.body);
      } catch (err) {
        if (pages === 0) throw err;
        notes.push(`listing stopped on page ${pages + 1}: ${redact(err).slice(0, 250)}`);
        break;
      }
      pages++;
      total = page.total;
      skipped += page.skipped;
      const previous = assets.size;
      page.assets.forEach((a) => assets.set(a.providerAssetId, a));
      page.observations.forEach((o) => observations.set(o.providerAssetId, o));
      // Featured coins may be repeated on every page. Only unique ids count toward coverage.
      if (assets.size >= total && skipped === 0 && total > 0) {
        complete = true;
        break;
      }
      if (page.count === 0 || assets.size === previous) {
        notes.push('listing ended or repeated before all reported assets were collected');
        break;
      }
      // Advance by what the source actually returned, so a smaller server-side cap never skips ranks.
      start += Math.max(1, page.count - overlap);
      if (start > total) {
        notes.push('listing ended before all reported assets were collected');
        break;
      }
    }
    if (!complete)
      notes.push(
        `partial website coverage: ${assets.size}/${total} unique coins in ${pages} pages`,
      );
    if (skipped) notes.push(`${skipped} malformed listing entries skipped`);
    return {
      assets: [...assets.values()],
      observations: [...observations.values()],
      total,
      pages,
      complete,
      notes,
      requests: this.client.requestsMade - before,
    };
  }

  async discover(): Promise<DiscoveryResult> {
    const s = await this.sweep(this.discoveryMaxPages);
    this.discoveryPage = { at: Date.now(), data: s };
    return {
      assets: s.assets,
      complete: s.complete,
      sourceTotal: s.total,
      pagesFetched: s.pages,
      requestsUsed: s.requests,
      categoryMembers: {},
      notes: s.notes,
    };
  }

  async collect(opts: CollectOptions): Promise<CollectResult> {
    const cached = this.discoveryPage;
    this.discoveryPage = null;
    const reuse =
      cached && Date.now() - cached.at < 60_000 && opts.maxPages === this.discoveryMaxPages;
    const s = reuse ? { ...cached.data, requests: 0 } : await this.sweep(opts.maxPages);
    return {
      observations: s.observations,
      complete: s.complete,
      universeSize: s.total,
      pagesFetched: s.pages,
      requestsUsed: s.requests,
      notes: s.notes,
      quoteCurrency: 'USD',
    };
  }
}

const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

/**
 * Tier 1 inputs from the same website client (shared queue, budget, circuit breaker): completed
 * daily rows (existing history route), LBank Spot pairs (CMC's LBank markets data) and one coin's
 * CMC Markets spot pairs. Targeted crawler extensions for gaps G4, G6, G7.
 */
export class CmcWebTier1Source implements Tier1Source {
  readonly providerId = CMC_WEB_PROVIDER.id;
  constructor(private readonly client: CmcWebClient) {}

  async dailyHistory(
    asset: { cmcId: number },
    from: string,
    to: string,
    now: Date,
  ): Promise<DailyFetch> {
    const params = {
      id: asset.cmcId,
      convertId: 2781,
      timeStart: seconds(parseIsoDate(from)),
      timeEnd: seconds(new Date(parseIsoDate(to).getTime() + DAY_MS)) - 1,
      interval: '1d',
    };
    const r = await this.client.get(WEB_HISTORY, params);
    const parsed = parseWebDaily(r.body, asset.cmcId, now);
    const rows = parsed.rows.filter((x) => x.dateUtc >= from && x.dateUtc <= to);
    return {
      rows,
      incompleteSkipped: parsed.incompleteSkipped,
      outOfRange: parsed.rows.length - rows.length,
      source: `cmc_web:${WEB_HISTORY}`,
      params: r.params,
      responseSha256: r.sha256,
      retrievedAt: r.retrievedAt,
    };
  }

  async lbankSpotPairs(): Promise<VenueFetch> {
    const seen = new Map<string, VenuePair>();
    const hashes: string[] = [];
    const notes: string[] = [];
    let expected: number | null = null;
    let start = 1,
      requests = 0,
      retrievedAt = new Date(),
      complete = false;
    const params = { slug: LBANK, category: 'spot', limit: String(EXCHANGE_PAGE_SIZE) };
    for (let page = 0; page < MAX_EXCHANGE_PAGES; page++) {
      let parsed: ReturnType<typeof parseVenuePairs>;
      try {
        const r = await this.client.get(WEB_EXCHANGE_PAIRS, {
          slug: LBANK,
          category: 'spot',
          start,
          limit: EXCHANGE_PAGE_SIZE,
        });
        requests++;
        hashes.push(r.sha256);
        retrievedAt = r.retrievedAt;
        parsed = parseVenuePairs(r.body);
      } catch (err) {
        if (page === 0) throw err;
        notes.push(`LBank pairs stopped on page ${page + 1}: ${redact(err).slice(0, 200)}`);
        break;
      }
      expected = parsed.expected ?? expected;
      const before = seen.size;
      for (const p of parsed.pairs) if (p.exchange === LBANK) seen.set(pairKey(p), p);
      if (parsed.skipped) notes.push(`${parsed.skipped} malformed pair rows skipped`);
      if (expected !== null && seen.size >= expected) {
        complete = true;
        break;
      }
      if (parsed.returned === 0 || seen.size === before) {
        notes.push('pair list ended before the reported count');
        break;
      }
      // The list is ordered by volume and can shift between requests: re-read an overlap so a pair
      // moving across a page boundary is not skipped (repeats are removed by market id).
      start += Math.max(1, parsed.returned - EXCHANGE_PAGE_OVERLAP);
    }
    if (!complete) notes.push(`partial LBank pair list: ${seen.size}/${expected ?? 'unknown'}`);
    return {
      pairs: [...seen.values()],
      expectedCount: expected,
      complete,
      requests,
      source: `cmc_web:${WEB_EXCHANGE_PAIRS}`,
      params,
      responseSha256: hashes,
      retrievedAt,
      notes,
    };
  }

  async assetMarkets(asset: { cmcId: number; slug: string | null }): Promise<VenueFetch> {
    if (!asset.slug || !/^[a-z0-9-]+$/.test(asset.slug))
      throw new CmcApiError('bad_request', `no usable slug for CMC id ${asset.cmcId}`, null, null);
    const r = await this.client.get(WEB_COIN_PAIRS, {
      slug: asset.slug,
      start: 1,
      limit: COIN_PAIRS_LIMIT,
      category: 'spot',
      centerType: 'all',
      sort: 'cmc_rank_advanced',
      direction: 'desc',
      spotUntracked: 'true',
    });
    const parsed = parseVenuePairs(r.body);
    const complete = parsed.expected !== null && parsed.pairs.length >= parsed.expected;
    const notes = parsed.skipped ? [`${parsed.skipped} malformed pair rows skipped`] : [];
    if (!complete)
      notes.push(`top ${parsed.pairs.length} of ${parsed.expected ?? 'unknown'} spot pairs`);
    return {
      pairs: parsed.pairs,
      expectedCount: parsed.expected,
      complete,
      requests: 1,
      source: `cmc_web:${WEB_COIN_PAIRS}`,
      params: r.params,
      responseSha256: [r.sha256],
      retrievedAt: r.retrievedAt,
      notes,
    };
  }
}
