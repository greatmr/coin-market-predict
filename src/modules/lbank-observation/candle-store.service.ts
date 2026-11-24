import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { redact } from '../../common/security/redact.js';
import { D } from '../../common/utils/decimal.js';

import { SpotCandle } from './entities/spot-candle.entity.js';
import { SpotPair } from './entities/spot-pair.entity.js';
import { LBANK_MARKET_SOURCE, type LbankMarketSource } from './lbank-market.source.js';
import type { Bar } from './observation-rules.js';
import { CLOSED_BAR_MARGIN_MS, KLINE_MAX_SIZE, MINUTE_MS } from './observation.constants.js';

export interface SyncReport {
  symbol: string;
  requests: number;
  stored: number;
  syncedUntil: string | null;
  outcome: 'ok' | 'unsupported' | 'error' | 'nothing_due';
  error?: string;
  /** Anomalies the API showed (duplicate or unordered rows, invalid rows): counted, never stored. */
  anomalies: { duplicates: number; unordered: number; invalid: number };
}

const minuteFloor = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

/**
 * Shared LBank Spot 1-minute candles per pair (docs/lbank-spot-observation.md § 3): overlapping
 * events of a pair reuse the same stored bars; each minute is requested once. `synced_until` advances
 * over every minute the API answered (with or without a bar), so a minute without a bar is a known
 * gap, retried separately, never an unfetched one.
 */
@Injectable()
export class CandleStoreService {
  private readonly log = new Logger(CandleStoreService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(LBANK_MARKET_SOURCE) private readonly source: LbankMarketSource,
  ) {}

  /** The pair's row (created on first use), by LBank symbol. */
  async ensurePair(m: EntityManager, symbol: string, base: string, quote: string): Promise<number> {
    await m
      .createQueryBuilder()
      .insert()
      .into(SpotPair)
      .values({ symbol, base, quote })
      .orIgnore()
      .updateEntity(false)
      .execute();
    return (await m.getRepository(SpotPair).findOneByOrFail({ symbol })).id;
  }

  /** The pair's first 1-minute bar (listing evidence): one request per pair, once. */
  async ensureFirstBar(pair: SpotPair): Promise<Date | null> {
    if (pair.firstBarAt) return pair.firstBarAt;
    const r = await this.source.klines(pair.symbol, 1000, 1);
    if (r.response.kind === 'ok' && r.response.bars[0]) {
      const at = new Date(r.response.bars[0].openMs);
      await this.db.getRepository(SpotPair).update({ id: pair.id }, { firstBarAt: at });
      pair.firstBarAt = at;
      return at;
    }
    return null;
  }

  /**
   * Fetch closed bars of `pair` from `fromMs` toward `untilMs` (exclusive), page by page (≤ 2000
   * bars each), at most `maxPages` requests. Bars are inserted once (closed bars are immutable).
   */
  async sync(
    pair: SpotPair,
    fromMs: number,
    untilMs: number,
    now: Date,
    maxPages: number,
  ): Promise<SyncReport> {
    const report: SyncReport = {
      symbol: pair.symbol,
      requests: 0,
      stored: 0,
      syncedUntil: pair.syncedUntil?.toISOString() ?? null,
      outcome: 'nothing_due',
      anomalies: { duplicates: 0, unordered: 0, invalid: 0 },
    };
    let start = minuteFloor(fromMs);
    if (start >= untilMs) return report;
    const pairs = this.db.getRepository(SpotPair);
    while (start < untilMs && report.requests < maxPages) {
      const size = Math.min(KLINE_MAX_SIZE, Math.ceil((untilMs - start) / MINUTE_MS) + 1);
      let fetch;
      try {
        fetch = await this.source.klines(pair.symbol, start, size);
      } catch (err) {
        report.outcome = 'error';
        report.error = redact(err).slice(0, 300);
        await pairs.update(
          { id: pair.id },
          { lastFetchAt: now, lastFetchStatus: 'error', lastError: report.error },
        );
        return report;
      }
      report.requests++;
      const r = fetch.response;
      if (r.kind === 'unsupported') {
        report.outcome = 'unsupported';
        await pairs.update(
          { id: pair.id },
          {
            lastFetchAt: now,
            lastFetchStatus: 'unsupported',
            lastError: `${r.code} ${r.message}`,
            unsupportedSince: pair.unsupportedSince ?? now,
          },
        );
        pair.unsupportedSince = pair.unsupportedSince ?? now;
        return report;
      }
      if (r.kind === 'error') {
        report.outcome = 'error';
        report.error = `${r.code ?? 'no code'} ${r.message}`;
        await pairs.update(
          { id: pair.id },
          { lastFetchAt: now, lastFetchStatus: 'error', lastError: report.error },
        );
        return report;
      }
      report.anomalies.duplicates += r.duplicates;
      report.anomalies.unordered += r.unordered ? 1 : 0;
      report.anomalies.invalid += r.invalid.length;
      // Only closed bars in [start, untilMs) are stored (nothing past what an observation needs).
      const closed = r.closed.filter((b) => b.openMs >= start && b.openMs < untilMs);
      if (closed.length) report.stored += await this.insertBars(pair.id, closed, now);
      // Every minute before the last closed bar's end was answered; a closed bar at or past untilMs
      // means every minute up to untilMs was; with no bar at all, the minutes up to the server's
      // closed horizon were answered without a bar.
      const closedEnd = minuteFloor(r.serverTsMs - CLOSED_BAR_MARGIN_MS);
      const next = r.closed.some((b) => b.openMs >= untilMs)
        ? untilMs
        : closed.length
          ? closed.at(-1)!.openMs + MINUTE_MS
          : r.bars.length
            ? start
            : Math.min(untilMs, Math.max(start, closedEnd));
      const progressed = next > start;
      const synced = Math.max(pair.syncedUntil?.getTime() ?? 0, next);
      pair.syncedUntil = new Date(synced);
      await pairs.update(
        { id: pair.id },
        {
          syncedUntil: pair.syncedUntil,
          lastFetchAt: now,
          lastFetchStatus: 'ok',
          lastError: null,
          unsupportedSince: null,
        },
      );
      pair.unsupportedSince = null;
      report.outcome = 'ok';
      report.syncedUntil = pair.syncedUntil.toISOString();
      // Fewer rows than asked for: the series reached the present.
      if (!progressed || r.rows < size) break;
      start = next;
    }
    return report;
  }

  /** Request one known gap again ([fromMs, toMs)); returns the bars it added. */
  async refetchGap(pair: SpotPair, fromMs: number, toMs: number, now: Date): Promise<number> {
    const size = Math.min(KLINE_MAX_SIZE, Math.ceil((toMs - fromMs) / MINUTE_MS));
    const r = (await this.source.klines(pair.symbol, fromMs, size)).response;
    if (r.kind !== 'ok') return 0;
    const inGap = r.closed.filter((b) => b.openMs >= fromMs && b.openMs < toMs);
    return inGap.length ? this.insertBars(pair.id, inGap, now) : 0;
  }

  private async insertBars(pairId: number, bars: readonly Bar[], now: Date): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < bars.length; i += 1000) {
      const chunk = bars.slice(i, i + 1000);
      const res = (await this.db
        .createQueryBuilder()
        .insert()
        .into(SpotCandle)
        .values(
          chunk.map((b) => ({
            pairId,
            openTime: new Date(b.openMs),
            open: b.open.toFixed() as never,
            high: b.high.toFixed() as never,
            low: b.low.toFixed() as never,
            close: b.close.toFixed() as never,
            volume: b.volume.toFixed() as never,
            fetchedAt: now,
          })),
        )
        .orIgnore()
        .returning('1')
        .updateEntity(false)
        .execute()) as { raw: unknown[] };
      inserted += Array.isArray(res.raw) ? res.raw.length : 0;
    }
    return inserted;
  }

  /**
   * Delete candles older than `retentionDays` that no unfinished observation of their pair needs
   * (its look-back hour through its window end). Range deletes on the primary key, pair by pair.
   * Finalized results keep their values and the SHA-256 of the exact series they rest on.
   */
  async prune(now: Date, retentionDays: number): Promise<number> {
    if (retentionDays <= 0) return 0;
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    const pairs: Array<{ pair_id: number; keep_from: Date | null }> = await this.db.query(
      `SELECT p.id AS pair_id,
              (SELECT min(o.t0) - interval '61 minutes' FROM lbank_observation o
                WHERE o.pair_id = p.id AND o.finalized_at IS NULL) AS keep_from
         FROM lbank_spot_pair p
        WHERE EXISTS (SELECT 1 FROM lbank_spot_candle c WHERE c.pair_id = p.id AND c.open_time < $1)`,
      [cutoff],
    );
    let deleted = 0;
    for (const p of pairs) {
      const until = p.keep_from && new Date(p.keep_from) < cutoff ? new Date(p.keep_from) : cutoff;
      const [, n] = (await this.db.query(
        `DELETE FROM lbank_spot_candle WHERE pair_id = $1 AND open_time < $2`,
        [p.pair_id, until],
      )) as [unknown, number];
      deleted += n;
    }
    return deleted;
  }

  /** Stored bars of a pair in [fromMs, toMs), ascending, with their exact stored values. */
  async loadBars(pairId: number, fromMs: number, toMs: number): Promise<Bar[]> {
    if (toMs <= fromMs) return [];
    const rows: Array<{
      ms: string;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }> = await this.db.query(
      `SELECT (extract(epoch FROM open_time) * 1000)::bigint::text AS ms,
                open::text, high::text, low::text, close::text, volume::text
           FROM lbank_spot_candle
          WHERE pair_id = $1 AND open_time >= $2 AND open_time < $3
          ORDER BY open_time`,
      [pairId, new Date(fromMs), new Date(toMs)],
    );
    return rows.map((r) => ({
      openMs: Number(r.ms),
      open: new D(r.open),
      high: new D(r.high),
      low: new D(r.low),
      close: new D(r.close),
      volume: new D(r.volume),
    }));
  }
}
