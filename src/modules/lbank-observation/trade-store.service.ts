import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { redact } from '../../common/security/redact.js';
import { D, type DValue } from '../../common/utils/decimal.js';

import { SpotPair } from './entities/spot-pair.entity.js';
import { SpotTrade } from './entities/spot-trade.entity.js';
import type { TradeRow } from './kline.js';
import { LBANK_MARKET_SOURCE, type LbankMarketSource } from './lbank-market.source.js';
import type { Bar, MinuteCheck, Trade } from './observation-rules.js';
import {
  MINUTE_MS,
  TRADES_MAX_PAGES_PER_MINUTE,
  TRADES_PAGE_SIZE,
  type TradeCheckStatus,
} from './observation.constants.js';

export interface MinuteCheckReport {
  check: MinuteCheck;
  requests: number;
  /** Trades priced outside their candle's [Low, High] (the candidate bound would not hold). */
  outsideCandle: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Trade evidence of the LBank Spot observation (docs/lbank-spot-observation.md § 3, § 5): the
 * complete trade list of one closed minute, read from `/v2/supplement/trades.do` and checked
 * against the minute's candle. The endpoint returns trades strictly after `time` (tested
 * 2026-11-25), so a minute m is read from `time = m − 1` and every next page from `last.time − 1`,
 * de-duplicated by trade id; a full page that brings no new id (more than 600 trades in one
 * millisecond) or the page cap leaves the minute PAGING_INCOMPLETE, never verified and never an
 * endless loop. Stored once per pair and shared by its observations.
 */
@Injectable()
export class TradeStoreService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(LBANK_MARKET_SOURCE) private readonly source: LbankMarketSource,
  ) {}

  /** Read and check the trades of the closed, traded minute `bar`; stores the trades when verified. */
  async checkMinute(pair: SpotPair, bar: Bar, now: Date): Promise<MinuteCheckReport> {
    const m = bar.openMs;
    const end = m + MINUTE_MS;
    const seen = new Set<string>();
    const inMinute: TradeRow[] = [];
    const hashes: string[] = [];
    const notes: string[] = [];
    let after = m - 1;
    let pages = 0;
    let requests = 0;
    let failed: { status: TradeCheckStatus; error: string } | null = null;
    for (;;) {
      if (pages >= TRADES_MAX_PAGES_PER_MINUTE) {
        failed = { status: 'PAGING_INCOMPLETE', error: `page cap ${TRADES_MAX_PAGES_PER_MINUTE}` };
        break;
      }
      let r;
      try {
        requests++;
        r = (await this.source.trades(pair.symbol, after, TRADES_PAGE_SIZE)).response;
      } catch (err) {
        failed = { status: 'FETCH_FAILED', error: redact(err).slice(0, 300) };
        break;
      }
      pages++;
      hashes.push(r.responseSha256);
      if (r.kind === 'unsupported') {
        failed = { status: 'PAIR_UNSUPPORTED', error: `${r.code} ${r.message}` };
        break;
      }
      if (r.kind === 'error') {
        failed = { status: 'FETCH_FAILED', error: `${r.code ?? 'no code'} ${r.message}` };
        break;
      }
      if (r.invalid.length) notes.push(`${r.invalid.length} invalid rows dropped`);
      if (r.unordered) notes.push('rows out of time order (sorted)');
      const rows = r.unordered ? [...r.rows].sort((a, b) => a.timeMs - b.timeMs) : r.rows;
      let fresh = 0;
      for (const t of rows) {
        if (t.timeMs <= after) notes.push(`row at ${iso(t.timeMs)} not after the requested time`);
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        fresh++;
        if (t.timeMs >= m && t.timeMs < end) inMinute.push(t);
      }
      // A short page holds every trade after `after` up to the server's present: complete.
      if (r.rowCount < TRADES_PAGE_SIZE) break;
      const last = rows.at(-1);
      if (!last) {
        failed = { status: 'PAGING_INCOMPLETE', error: 'a full page without a readable row' };
        break;
      }
      if (last.timeMs >= end) break;
      if (!fresh) {
        failed = {
          status: 'PAGING_INCOMPLETE',
          error: `more than ${TRADES_PAGE_SIZE} trades at ${iso(last.timeMs)}: one millisecond cannot be paged past`,
        };
        break;
      }
      after = last.timeMs - 1;
    }

    const trades: Trade[] = [];
    const perMs = new Map<number, number>();
    for (const t of [...inMinute].sort((a, b) => a.timeMs - b.timeMs)) {
      const ord = perMs.get(t.timeMs) ?? 0;
      perMs.set(t.timeMs, ord + 1);
      trades.push({ ...t, ord });
    }
    const qtySum = trades.reduce<DValue>((s, t) => s.plus(t.qty), new D(0));
    const outsideCandle = trades.filter((t) => t.price.gt(bar.high) || t.price.lt(bar.low)).length;
    if (outsideCandle) notes.push(`${outsideCandle} trades outside the candle's [Low, High]`);
    let status: TradeCheckStatus;
    let error: string | null;
    if (failed) ({ status, error } = failed);
    else if (qtySum.gte(bar.volume)) {
      status = 'VERIFIED';
      error = null;
    } else {
      status = 'TRADES_BELOW_CANDLE';
      error = `trade quantity ${qtySum.toFixed()} < candle volume ${bar.volume.toFixed()}`;
    }
    if (notes.length) error = [error, ...new Set(notes)].filter(Boolean).join('; ').slice(0, 500);
    const verified = status === 'VERIFIED';
    // Provenance: the moment this minute's trade list was actually read, not the run's start
    // (`now` is the run's clock for the rules; a run can take minutes before it reaches a pair).
    const checkedAt = new Date(Math.max(Date.now(), now.getTime()));

    await this.db.transaction(async (q) => {
      if (verified && trades.length)
        for (let i = 0; i < trades.length; i += 500)
          await q
            .createQueryBuilder()
            .insert()
            .into(SpotTrade)
            .values(
              trades.slice(i, i + 500).map((t) => ({
                pairId: pair.id,
                tradeId: t.id,
                tradedAt: new Date(t.timeMs),
                msOrd: t.ord,
                price: t.price.toFixed() as never,
                qty: t.qty.toFixed() as never,
                isBuyerMaker: t.buyerMaker,
                fetchedAt: checkedAt,
              })),
            )
            .orIgnore()
            .updateEntity(false)
            .execute();
      await q.query(
        `INSERT INTO lbank_spot_trade_minute
           (pair_id, minute_at, status, trade_count, qty_sum, candle_volume, candle_surplus, pages,
            attempts, responses_sha256, error, first_checked_at, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11, $11)
         ON CONFLICT (pair_id, minute_at) DO UPDATE SET
           status = EXCLUDED.status, trade_count = EXCLUDED.trade_count, qty_sum = EXCLUDED.qty_sum,
           candle_volume = EXCLUDED.candle_volume, candle_surplus = EXCLUDED.candle_surplus,
           pages = EXCLUDED.pages, attempts = lbank_spot_trade_minute.attempts + 1,
           responses_sha256 = EXCLUDED.responses_sha256, error = EXCLUDED.error,
           checked_at = EXCLUDED.checked_at
         WHERE lbank_spot_trade_minute.status <> 'VERIFIED'`,
        [
          pair.id,
          new Date(m),
          status,
          failed ? null : trades.length,
          failed ? null : qtySum.toFixed(),
          bar.volume.toFixed(),
          verified ? qtySum.minus(bar.volume).toFixed() : null,
          pages,
          hashes,
          error,
          checkedAt,
        ],
      );
      const fetchOk = status !== 'FETCH_FAILED' && status !== 'PAIR_UNSUPPORTED';
      const fresh = fetchOk
        ? { tradesLastAttemptAt: checkedAt, tradesLastSuccessAt: checkedAt, tradesLastError: null }
        : { tradesLastAttemptAt: checkedAt, tradesLastError: error };
      await q.getRepository(SpotPair).update({ id: pair.id }, fresh);
      Object.assign(pair, fresh);
    });
    return {
      check: {
        minuteMs: m,
        status,
        trades: verified ? trades : [],
        tradeCount: failed ? null : trades.length,
        qtySum: failed ? null : qtySum,
        candleVolume: bar.volume,
        attempts: 1,
        error,
      },
      requests,
      outsideCandle,
    };
  }

  /** The first trade strictly after `afterMs` (one request; context for review flags). */
  async nextTrade(pair: SpotPair, afterMs: number): Promise<TradeRow | null | { error: string }> {
    try {
      const r = (await this.source.trades(pair.symbol, afterMs, 1)).response;
      if (r.kind !== 'ok') return { error: `${r.code ?? 'no code'} ${r.message}` };
      return r.rows[0] ?? null;
    } catch (err) {
      return { error: redact(err).slice(0, 200) };
    }
  }

  /** Stored checks of a pair's minutes in [fromMs, toMs), with the trades of verified minutes. */
  async loadChecks(
    pairId: number,
    fromMs: number,
    toMs: number,
  ): Promise<Map<number, MinuteCheck>> {
    const out = new Map<number, MinuteCheck>();
    if (toMs <= fromMs) return out;
    const rows: Array<{
      ms: string;
      status: TradeCheckStatus;
      trade_count: number | null;
      qty_sum: string | null;
      candle_volume: string | null;
      attempts: number;
      error: string | null;
    }> = await this.db.query(
      `SELECT (extract(epoch FROM minute_at) * 1000)::bigint::text AS ms, status, trade_count,
              qty_sum::text AS qty_sum, candle_volume::text AS candle_volume, attempts, error
         FROM lbank_spot_trade_minute
        WHERE pair_id = $1 AND minute_at >= $2 AND minute_at < $3`,
      [pairId, new Date(fromMs), new Date(toMs)],
    );
    for (const r of rows)
      out.set(Number(r.ms), {
        minuteMs: Number(r.ms),
        status: r.status,
        trades: [],
        tradeCount: r.trade_count,
        qtySum: r.qty_sum === null ? null : new D(r.qty_sum),
        candleVolume: r.candle_volume === null ? null : new D(r.candle_volume),
        attempts: r.attempts,
        error: r.error,
      });
    const verified = [...out.values()].filter((c) => c.status === 'VERIFIED');
    if (!verified.length) return out;
    const trades: Array<{
      trade_id: string;
      ms: string;
      ms_ord: number;
      price: string;
      qty: string;
      is_buyer_maker: boolean | null;
    }> = await this.db.query(
      `SELECT trade_id, (extract(epoch FROM traded_at) * 1000)::bigint::text AS ms, ms_ord,
              price::text AS price, qty::text AS qty, is_buyer_maker
         FROM lbank_spot_trade t
        WHERE t.pair_id = $1 AND t.traded_at >= $2 AND t.traded_at < $3
          AND EXISTS (SELECT 1 FROM lbank_spot_trade_minute c
                       WHERE c.pair_id = t.pair_id AND c.status = 'VERIFIED'
                         AND c.minute_at = date_trunc('minute', t.traded_at))
        ORDER BY t.traded_at, t.ms_ord`,
      [pairId, new Date(fromMs), new Date(toMs)],
    );
    const byMinute = new Map<number, Trade[]>();
    for (const t of trades) {
      const ms = Number(t.ms);
      const minute = Math.floor(ms / MINUTE_MS) * MINUTE_MS;
      const list = byMinute.get(minute) ?? [];
      list.push({
        id: t.trade_id,
        timeMs: ms,
        ord: t.ms_ord,
        price: new D(t.price),
        qty: new D(t.qty),
        buyerMaker: t.is_buyer_maker,
      });
      byMinute.set(minute, list);
    }
    for (const c of verified) out.set(c.minuteMs, { ...c, trades: byMinute.get(c.minuteMs) ?? [] });
    return out;
  }
}
