import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, MoreThanOrEqual, Not } from 'typeorm';

import { insertRows } from '../../common/entities/insert.js';
import { redact } from '../../common/security/redact.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { stopsCrawl } from '../sources/coinmarketcap-web/errors.js';
import { SourceHealthService } from '../sources/source-health.service.js';
import { TIER1_SOURCE, type Tier1Source } from '../sources/source.types.js';
import { LBANK, type VenuePair } from '../strategy/index.js';

import { VenueCrawl, type VenueCrawlKind } from './entities/venue-crawl.entity.js';
import { VenuePairEvent } from './entities/venue-pair-event.entity.js';
import {
  EXCHANGE_LISTS,
  EXCHANGE_LIST_KEYS,
  EXTRA_EXCHANGE_LISTS,
  type ExchangeListKey,
  LIST_REQUEST_ALLOWANCE,
  LIST_RETRY_MS,
  type ListView,
  listView,
  refreshDue,
} from './exchange-lists.js';

export interface LbankCrawlReport {
  /** REUSED = the stored list is younger than LBANK_PAIRS_REFRESH_DAYS, nothing was fetched. */
  status: 'COMPLETE' | 'INCOMPLETE' | 'FAILED' | 'SKIPPED' | 'REUSED';
  /** The crawl that was fetched now, or the stored list that was reused. */
  crawlId: string | null;
  pairs: number;
  expected: number | null;
  listedEvents: number;
  absentEvents: number;
  notes: string[];
  /** A COMPLETE list no older than LBANK_PAIRS_MAX_AGE_DAYS exists after this call. */
  usable: boolean;
  /** Fetch time of the newest COMPLETE list and when it is next refreshed automatically. */
  listFetchedAt: string | null;
  nextRefreshAt: string | null;
}

export interface LbankListStatus {
  crawlId: string;
  fetchedAt: string;
  pairs: number;
  expected: number | null;
  ageDays: number;
  nextRefreshAt: string;
  staleAt: string;
  stale: boolean;
  trigger: string | null;
  lastAttempt: { at: string; status: string; error: string | null } | null;
}

export interface VenueRefreshReport {
  candidates: number;
  due: number;
  attempted: number;
  fetched: number;
  failed: number;
  stoppedBy: 'max_assets' | 'time_budget' | 'request_budget_reserve' | 'source_unavailable' | null;
  notes: string[];
}

/** One LBank Futures / Bithumb list in the `venues` stage or a manual refresh (ADR-0007). */
export interface ExchangeListReport {
  key: ExchangeListKey;
  label: string;
  /**
   * COMPLETE / INCOMPLETE / FAILED: fetched now. REUSED: the stored list is younger than
   * EXCHANGE_LISTS_REFRESH_HOURS. RETRY_LATER: a recent attempt failed; it is retried later.
   * SKIPPED: no exchange lists from this source, the request reserve, or the source stopped.
   */
  status: 'COMPLETE' | 'INCOMPLETE' | 'FAILED' | 'REUSED' | 'RETRY_LATER' | 'SKIPPED';
  crawlId: string | null;
  pairs: number;
  expected: number | null;
  notes: string[];
}

const LIST_PAIRS_CACHE = 6;

/**
 * Venue inputs collected by the existing CMC website crawler (gaps G6, G7): LBank Spot pairs
 * for every batch and CMC Markets spot pairs for review candidates. Every crawl keeps the
 * normalized pair rows it produced, so scans and reviews can show the exact evidence.
 */
@Injectable()
export class VenuesService {
  private readonly log = new Logger(VenuesService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(TIER1_SOURCE) private readonly source: Tier1Source | null,
    private readonly health: SourceHealthService,
  ) {}

  get available() {
    return this.source !== null;
  }

  private get refreshMs() {
    return this.cfg.LBANK_PAIRS_REFRESH_DAYS * 86_400_000;
  }

  private get maxAgeMs() {
    return this.cfg.LBANK_PAIRS_MAX_AGE_DAYS * 86_400_000;
  }

  private get crawls() {
    return this.db.getRepository(VenueCrawl);
  }

  private get listRefreshMs() {
    return this.cfg.EXCHANGE_LISTS_REFRESH_HOURS * 3_600_000;
  }

  private get listMaxAgeMs() {
    return this.cfg.EXCHANGE_LISTS_MAX_AGE_HOURS * 3_600_000;
  }

  /** Crawls are never changed after they are stored, so their pairs are cached by id. */
  private readonly listPairs = new Map<string, VenuePair[]>();

  /** Newest COMPLETE LBank Spot markets list (the one scans use). */
  latestLbankList(providerId: string) {
    return this.crawls.findOne({
      where: { providerId, kind: 'lbank_spot_pairs', status: 'COMPLETE' },
      order: { finishedAt: 'DESC' },
    });
  }

  /** Age, next automatic refresh and the last attempt of the stored LBank list (dashboard, API). */
  async lbankListStatus(providerId: string, now = new Date()): Promise<LbankListStatus | null> {
    const [list, attempt] = await Promise.all([
      this.latestLbankList(providerId),
      this.crawls.findOne({
        where: { providerId, kind: 'lbank_spot_pairs' },
        order: { finishedAt: 'DESC' },
      }),
    ]);
    if (!list) return null;
    const summary = (list.summary ?? {}) as { trigger?: string };
    return {
      crawlId: list.id,
      fetchedAt: list.finishedAt.toISOString(),
      pairs: list.fetchedCount,
      expected: list.expectedCount,
      ageDays: Math.round(((now.getTime() - list.finishedAt.getTime()) / 86_400_000) * 100) / 100,
      nextRefreshAt: new Date(list.finishedAt.getTime() + this.refreshMs).toISOString(),
      staleAt: new Date(list.finishedAt.getTime() + this.maxAgeMs).toISOString(),
      stale: now.getTime() - list.finishedAt.getTime() > this.maxAgeMs,
      trigger: summary.trigger ?? null,
      lastAttempt:
        attempt && attempt.id !== list.id
          ? { at: attempt.finishedAt.toISOString(), status: attempt.status, error: attempt.error }
          : null,
    };
  }

  /**
   * LBank Spot pairs (stage `lbank`, and the manual refresh). The list is fetched once and reused
   * until it is LBANK_PAIRS_REFRESH_DAYS old (operator decision D2); `force` fetches it now. A
   * failed or incomplete refresh is recorded and the previous COMPLETE list stays in use until it
   * is LBANK_PAIRS_MAX_AGE_DAYS old. Never throws.
   */
  async ensureLbankPairs(
    providerId: string,
    batchId: string | null,
    at: Date,
    opts: { force?: boolean; trigger?: 'schedule' | 'manual' } = {},
  ): Promise<LbankCrawlReport> {
    const base = { listedEvents: 0, absentEvents: 0 };
    if (!this.source || this.source.providerId !== providerId) {
      return {
        ...base,
        status: 'SKIPPED',
        crawlId: null,
        pairs: 0,
        expected: null,
        usable: false,
        listFetchedAt: null,
        nextRefreshAt: null,
        notes: ['this data source supplies no LBank pair feed: LBank status stays UNKNOWN'],
      };
    }
    const previous = await this.latestLbankList(providerId);
    const describe = (list: { finishedAt: Date } | null) => ({
      usable: !!list && at.getTime() - list.finishedAt.getTime() <= this.maxAgeMs,
      listFetchedAt: list?.finishedAt.toISOString() ?? null,
      nextRefreshAt: list
        ? new Date(list.finishedAt.getTime() + this.refreshMs).toISOString()
        : null,
    });
    if (!opts.force && previous && at.getTime() - previous.finishedAt.getTime() < this.refreshMs) {
      return {
        ...base,
        status: 'REUSED',
        crawlId: previous.id,
        pairs: previous.fetchedCount,
        expected: previous.expectedCount,
        ...describe(previous),
        notes: [`reusing the LBank list fetched ${previous.finishedAt.toISOString()}`],
      };
    }
    const trigger = opts.trigger ?? (opts.force ? 'manual' : 'schedule');
    const startedAt = new Date();
    try {
      const r = await this.source.lbankSpotPairs(at);
      const status = r.complete ? 'COMPLETE' : 'INCOMPLETE';
      const crawl = await this.crawls.save(
        this.crawls.create({
          providerId,
          kind: 'lbank_spot_pairs',
          batchId,
          startedAt,
          finishedAt: new Date(),
          status,
          expectedCount: r.expectedCount,
          fetchedCount: r.pairs.length,
          requests: r.requests,
          pairs: r.pairs,
          summary: { trigger },
          source: r.source,
          sourceParams: r.params,
          responseSha256: r.responseSha256,
          notes: r.notes,
        }),
      );
      const events =
        status === 'COMPLETE'
          ? await this.recordListingEvents(providerId, crawl.id, r.pairs, crawl.finishedAt)
          : { listed: 0, absent: 0 };
      this.log.log(
        `LBank spot pairs (${trigger}): ${r.pairs.length}/${r.expectedCount ?? '?'} (${status}); ${events.listed} listed, ${events.absent} absent events`,
      );
      const notes =
        status === 'COMPLETE' || !previous
          ? r.notes
          : [...r.notes, `keeping the LBank list fetched ${previous.finishedAt.toISOString()}`];
      return {
        status,
        crawlId: crawl.id,
        pairs: r.pairs.length,
        expected: r.expectedCount,
        listedEvents: events.listed,
        absentEvents: events.absent,
        ...describe(status === 'COMPLETE' ? crawl : previous),
        notes,
      };
    } catch (err) {
      const message = redact(err).slice(0, 500);
      const crawl = await this.crawls.save(
        this.crawls.create({
          providerId,
          kind: 'lbank_spot_pairs',
          batchId,
          startedAt,
          finishedAt: new Date(),
          status: 'FAILED',
          fetchedCount: 0,
          pairs: [],
          summary: { trigger },
          source: 'lbank_spot_pairs',
          sourceParams: {},
          error: message,
        }),
      );
      this.log.warn(`LBank pair crawl failed (${trigger}): ${message}`);
      return {
        ...base,
        status: 'FAILED',
        crawlId: crawl.id,
        pairs: 0,
        expected: null,
        ...describe(previous),
        notes: previous
          ? [message, `keeping the LBank list fetched ${previous.finishedAt.toISOString()}`]
          : [message],
      };
    }
  }

  /**
   * Listing transitions per (CMC id, LBank pair): LISTED when first seen or back after an absence,
   * ABSENT when a complete crawl no longer contains a listed pair (assumptions A9, A12).
   */
  async recordListingEvents(
    providerId: string,
    crawlId: string,
    pairs: VenuePair[],
    at: Date,
  ): Promise<{ listed: number; absent: number }> {
    const current = new Set(
      pairs
        .filter((p) => p.category === 'spot' && p.baseCurrencyId !== null)
        .map((p) => `${p.baseCurrencyId}|${p.marketPair}`),
    );
    const latest = (await this.db.query(
      `SELECT DISTINCT ON (cmc_id, market_pair) cmc_id AS "cmcId", market_pair AS "marketPair", event
         FROM venue_pair_event WHERE provider_id = $1 AND exchange = $2 AND at <= $3
        ORDER BY cmc_id, market_pair, at DESC, id DESC`,
      [providerId, LBANK, at],
    )) as Array<{ cmcId: number; marketPair: string; event: string }>;
    const last = new Map(latest.map((e) => [`${e.cmcId}|${e.marketPair}`, e.event]));
    const rows: Array<
      Pick<
        VenuePairEvent,
        'providerId' | 'exchange' | 'cmcId' | 'marketPair' | 'event' | 'crawlId' | 'at'
      >
    > = [];
    for (const key of current) {
      if (last.get(key) === 'LISTED') continue;
      const [id, ...pair] = key.split('|');
      rows.push({
        providerId,
        exchange: LBANK,
        cmcId: Number(id),
        marketPair: pair.join('|'),
        event: 'LISTED',
        crawlId,
        at,
      });
    }
    for (const [key, ev] of last) {
      if (ev !== 'LISTED' || current.has(key)) continue;
      const [id, ...pair] = key.split('|');
      rows.push({
        providerId,
        exchange: LBANK,
        cmcId: Number(id),
        marketPair: pair.join('|'),
        event: 'ABSENT',
        crawlId,
        at,
      });
    }
    await insertRows(this.db.manager, VenuePairEvent, rows);
    return {
      listed: rows.filter((r) => r.event === 'LISTED').length,
      absent: rows.filter((r) => r.event === 'ABSENT').length,
    };
  }

  private latestCrawl(providerId: string, kind: VenueCrawlKind, complete: boolean) {
    return this.crawls.findOne({
      where: { providerId, kind, ...(complete ? { status: 'COMPLETE' as const } : {}) },
      order: { finishedAt: 'DESC', id: 'DESC' },
      select: {
        id: true,
        status: true,
        finishedAt: true,
        fetchedCount: true,
        expectedCount: true,
        error: true,
      },
    });
  }

  /**
   * LBank Futures and Bithumb Spot markets lists (ADR-0007), fetched when the stored one is
   * EXCHANGE_LISTS_REFRESH_HOURS old (a failed attempt is retried after LIST_RETRY_MS at most), or
   * now with `force`. Every attempt is stored, failures too. No Tier 1 rule reads these lists, so
   * nothing is rescanned. Never throws for a source problem; stops at the request reserve or when
   * the source becomes unavailable.
   */
  async ensureExchangeLists(
    providerId: string,
    batchId: string | null,
    at: Date,
    opts: { force?: boolean; trigger?: 'schedule' | 'manual' } = {},
  ): Promise<ExchangeListReport[]> {
    const trigger = opts.trigger ?? (opts.force ? 'manual' : 'schedule');
    const out: ExchangeListReport[] = [];
    let stopped: string | null = null;
    for (const spec of EXTRA_EXCHANGE_LISTS) {
      const report = (
        status: ExchangeListReport['status'],
        notes: string[],
        list: { id: string; fetchedCount: number; expectedCount: number | null } | null = null,
      ) =>
        out.push({
          key: spec.key,
          label: spec.label,
          status,
          crawlId: list?.id ?? null,
          pairs: list?.fetchedCount ?? 0,
          expected: list?.expectedCount ?? null,
          notes,
        });
      if (!this.source || this.source.providerId !== providerId) {
        report('SKIPPED', [
          'this data source supplies no exchange markets lists: listings stay Unknown',
        ]);
        continue;
      }
      const [complete, attempt] = await Promise.all([
        this.latestCrawl(providerId, spec.kind, true),
        this.latestCrawl(providerId, spec.kind, false),
      ]);
      const due = opts.force ? 'DUE' : refreshDue(complete, attempt, at, this.listRefreshMs);
      if (due === 'FRESH') {
        report(
          'REUSED',
          [`reusing the ${spec.label} list fetched ${complete!.finishedAt.toISOString()}`],
          complete,
        );
        continue;
      }
      if (due === 'RETRY_LATER') {
        const retryHours = Math.min(this.listRefreshMs, LIST_RETRY_MS) / 3_600_000;
        report(
          'RETRY_LATER',
          [
            `the ${attempt!.status} attempt of ${attempt!.finishedAt.toISOString()} is retried ${retryHours} h after it`,
          ],
          complete,
        );
        continue;
      }
      if (stopped) {
        report('SKIPPED', [`not fetched: ${stopped}`], complete);
        continue;
      }
      if ((await this.health.spendableRequests(providerId, at)) < LIST_REQUEST_ALLOWANCE) {
        report('SKIPPED', ['not fetched: request budget reserve for the hourly listing'], complete);
        continue;
      }
      const startedAt = new Date();
      const summary = { trigger, list: spec.key, categories: [...spec.categories] };
      try {
        const r = await this.source.exchangePairs(
          { exchange: spec.exchange, categories: spec.categories },
          at,
        );
        const status = r.complete ? 'COMPLETE' : 'INCOMPLETE';
        const crawl = await this.crawls.save(
          this.crawls.create({
            providerId,
            kind: spec.kind,
            batchId,
            startedAt,
            finishedAt: new Date(),
            status,
            expectedCount: r.expectedCount,
            fetchedCount: r.pairs.length,
            requests: r.requests,
            pairs: r.pairs,
            summary,
            source: r.source,
            sourceParams: r.params,
            responseSha256: r.responseSha256,
            notes: r.notes,
          }),
        );
        this.log.log(
          `${spec.label} markets list (${trigger}): ${r.pairs.length}/${r.expectedCount ?? '?'} (${status})`,
        );
        report(status, r.notes, crawl);
      } catch (err) {
        const message = redact(err).slice(0, 500);
        const crawl = await this.crawls.save(
          this.crawls.create({
            providerId,
            kind: spec.kind,
            batchId,
            startedAt,
            finishedAt: new Date(),
            status: 'FAILED',
            fetchedCount: 0,
            pairs: [],
            summary,
            source: spec.kind,
            sourceParams: {},
            error: message,
          }),
        );
        this.log.warn(`${spec.label} markets list failed (${trigger}): ${message}`);
        report('FAILED', [message], { ...crawl, fetchedCount: 0, expectedCount: null });
        if (stopsCrawl(err)) stopped = 'the source is unavailable';
      }
    }
    return out;
  }

  /**
   * What each exchange list can say now: the LBank Spot list (the scanner's, valid for
   * LBANK_PAIRS_MAX_AGE_DAYS) and the LBank Futures and Bithumb lists (valid for
   * EXCHANGE_LISTS_MAX_AGE_HOURS).
   */
  async exchangeListViews(
    providerId: string,
    now = new Date(),
  ): Promise<Record<ExchangeListKey, ListView>> {
    const supported = !!this.source && this.source.providerId === providerId;
    const views = await Promise.all(
      EXCHANGE_LIST_KEYS.map(async (key) => {
        const spec = EXCHANGE_LISTS[key];
        const [complete, attempt] = await Promise.all([
          this.latestCrawl(providerId, spec.kind, true),
          this.latestCrawl(providerId, spec.kind, false),
        ]);
        const maxAgeMs = key === 'lbankSpot' ? this.maxAgeMs : this.listMaxAgeMs;
        const pairs = complete ? await this.cachedPairs(complete.id) : [];
        return listView(
          spec,
          complete ? { ...complete, status: 'COMPLETE', pairs } : null,
          attempt,
          now,
          maxAgeMs,
          supported,
        );
      }),
    );
    return Object.fromEntries(views.map((v) => [v.key, v])) as Record<ExchangeListKey, ListView>;
  }

  private async cachedPairs(crawlId: string): Promise<VenuePair[]> {
    const hit = this.listPairs.get(crawlId);
    if (hit) return hit;
    const row = await this.crawls.findOne({
      where: { id: crawlId },
      select: { id: true, pairs: true },
    });
    const pairs = row?.pairs ?? [];
    if (this.listPairs.size >= LIST_PAIRS_CACHE)
      this.listPairs.delete(this.listPairs.keys().next().value!);
    this.listPairs.set(crawlId, pairs);
    return pairs;
  }

  /** CMC Markets spot pairs for review candidates (stage `venues`), at most once per refresh period each. */
  async refreshAssetMarkets(
    providerId: string,
    batchId: string,
    candidates: Array<{ cmcId: number; slug: string | null }>,
    at: Date,
    onProgress?: (done: number, total: number) => void,
  ): Promise<VenueRefreshReport> {
    const report: VenueRefreshReport = {
      candidates: candidates.length,
      due: 0,
      attempted: 0,
      fetched: 0,
      failed: 0,
      stoppedBy: null,
      notes: [],
    };
    if (!this.source || this.source.providerId !== providerId || !candidates.length) return report;
    const since = new Date(at.getTime() - this.cfg.TIER1_VENUE_REFRESH_HOURS * 3_600_000);
    const recent = new Set(
      (
        await this.crawls.find({
          where: {
            providerId,
            kind: 'asset_markets',
            cmcId: In(candidates.map((c) => c.cmcId)),
            finishedAt: MoreThanOrEqual(since),
            status: Not('FAILED'),
          },
          select: { id: true, cmcId: true },
        })
      ).map((c) => c.cmcId),
    );
    const due = candidates.filter((c) => !recent.has(c.cmcId));
    report.due = due.length;
    const deadline = Date.now() + 10 * 60_000;
    let allowance = await this.health.spendableRequests(providerId, at);
    const planned = Math.min(due.length, this.cfg.TIER1_VENUE_MAX_ASSETS_PER_RUN);
    if (planned) onProgress?.(0, planned);
    for (const c of due) {
      if (report.attempted > 0) onProgress?.(report.attempted, planned);
      if (report.attempted >= this.cfg.TIER1_VENUE_MAX_ASSETS_PER_RUN) {
        report.stoppedBy = 'max_assets';
        break;
      }
      if (Date.now() > deadline) {
        report.stoppedBy = 'time_budget';
        break;
      }
      if (allowance <= 0) {
        report.stoppedBy = 'request_budget_reserve';
        break;
      }
      report.attempted++;
      allowance--;
      const startedAt = new Date();
      try {
        const r = await this.source.assetMarkets(c, at);
        await this.crawls.insert({
          providerId,
          kind: 'asset_markets',
          cmcId: c.cmcId,
          batchId,
          startedAt,
          finishedAt: new Date(),
          status: r.complete ? 'COMPLETE' : 'INCOMPLETE',
          expectedCount: r.expectedCount,
          fetchedCount: r.pairs.length,
          requests: r.requests,
          pairs: r.pairs as never,
          source: r.source,
          sourceParams: r.params,
          responseSha256: r.responseSha256,
          notes: r.notes,
        });
        report.fetched++;
      } catch (err) {
        report.failed++;
        const message = redact(err).slice(0, 300);
        await this.crawls.insert({
          providerId,
          kind: 'asset_markets',
          cmcId: c.cmcId,
          batchId,
          startedAt,
          finishedAt: new Date(),
          status: 'FAILED',
          fetchedCount: 0,
          pairs: [] as never,
          source: 'asset_markets',
          sourceParams: {},
          error: message,
        });
        if (report.failed <= 5) report.notes.push(`CMC id ${c.cmcId}: ${message}`);
        if (stopsCrawl(err)) {
          report.stoppedBy = 'source_unavailable';
          break;
        }
      }
    }
    if (planned) onProgress?.(report.attempted, planned);
    return report;
  }
}
