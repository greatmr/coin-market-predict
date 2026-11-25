import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DataSource, EntityManager } from 'typeorm';

import { redact } from '../../common/security/redact.js';
import { D, sha256 } from '../../common/utils/decimal.js';

import { CandleArchive } from './entities/candle-archive.entity.js';
import { SpotCandle } from './entities/spot-candle.entity.js';
import { SpotPair } from './entities/spot-pair.entity.js';
import { LBANK_MARKET_SOURCE, type LbankMarketSource } from './lbank-market.source.js';
import type { Bar } from './observation-rules.js';
import { CLOSED_BAR_MARGIN_MS, KLINE_MAX_SIZE, MINUTE_MS } from './observation.constants.js';

export interface SyncReport {
  symbol: string;
  requests: number;
  stored: number;
  /** Requests that answered (with or without bars): the fetch reached LBank. */
  answered: number;
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
      answered: 0,
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
        pair.lastFetchStatus = 'error';
        pair.lastError = report.error;
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
        pair.lastFetchStatus = 'unsupported';
        pair.lastError = `${r.code} ${r.message}`;
        return report;
      }
      if (r.kind === 'error') {
        report.outcome = 'error';
        report.error = `${r.code ?? 'no code'} ${r.message}`;
        await pairs.update(
          { id: pair.id },
          { lastFetchAt: now, lastFetchStatus: 'error', lastError: report.error },
        );
        pair.lastFetchStatus = 'error';
        pair.lastError = report.error;
        return report;
      }
      report.answered++;
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
          lastSuccessAt: now,
          lastFetchStatus: 'ok',
          lastError: null,
          unsupportedSince: null,
        },
      );
      pair.unsupportedSince = null;
      pair.lastSuccessAt = now;
      pair.lastFetchStatus = 'ok';
      pair.lastError = null;
      report.outcome = 'ok';
      report.syncedUntil = pair.syncedUntil.toISOString();
      // Fewer rows than asked for: the series reached the present.
      if (!progressed || r.rows < size) break;
      start = next;
    }
    return report;
  }

  /** Request one known gap again ([fromMs, toMs), at most one page); returns the bars it added. */
  async refetchGap(pair: SpotPair, fromMs: number, toMs: number, now: Date): Promise<number> {
    const size = Math.min(KLINE_MAX_SIZE, Math.ceil((toMs - fromMs) / MINUTE_MS));
    const r = (await this.source.klines(pair.symbol, fromMs, size)).response;
    if (r.kind !== 'ok') return 0;
    await this.db.getRepository(SpotPair).update({ id: pair.id }, { lastSuccessAt: now });
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
   * Retention (docs/lbank-spot-observation.md § 7): raw candles older than `retentionDays` that no
   * unfinished observation needs (its look-back hour through its window end) are first archived per
   * pair and UTC day (gzip of the exact CSV, SHA-256), then deleted, whole days only. A day whose raw
   * bars are not all in its archive is kept raw. Archives are never deleted, so finished windows
   * stay reproducible without duplicating a series per overlapping event.
   */
  async prune(
    now: Date,
    retentionDays: number,
  ): Promise<{ deleted: number; archivedDays: number }> {
    if (retentionDays <= 0) return { deleted: 0, archivedDays: 0 };
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    const pairs: Array<{ pair_id: number; keep_from: Date | null }> = await this.db.query(
      `SELECT p.id AS pair_id,
              (SELECT min(coalesce(o.observation_start, o.t0)) - interval '61 minutes'
                 FROM lbank_observation o
                WHERE o.pair_id = p.id AND o.finalized_at IS NULL) AS keep_from
         FROM lbank_spot_pair p
        WHERE EXISTS (SELECT 1 FROM lbank_spot_candle c WHERE c.pair_id = p.id AND c.open_time < $1)`,
      [cutoff],
    );
    let deleted = 0;
    let archivedDays = 0;
    for (const p of pairs) {
      const until = p.keep_from && new Date(p.keep_from) < cutoff ? new Date(p.keep_from) : cutoff;
      const dayEnd = Math.floor(until.getTime() / 86_400_000) * 86_400_000;
      const days: Array<{ d: string }> = await this.db.query(
        `SELECT DISTINCT to_char(open_time AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d
           FROM lbank_spot_candle WHERE pair_id = $1 AND open_time < $2 ORDER BY 1`,
        [p.pair_id, new Date(dayEnd)],
      );
      for (const { d } of days) {
        const from = Date.parse(`${d}T00:00:00Z`);
        const bars = await this.rawBars(p.pair_id, from, from + 86_400_000);
        const existing = await this.db
          .getRepository(CandleArchive)
          .findOneBy({ pairId: p.pair_id, utcDate: d });
        if (!existing) {
          await this.archive(p.pair_id, d, bars, now);
          archivedDays++;
        } else {
          const archived = new Map(decodeArchive(existing).map((b) => [b.openMs, csvLine(b)]));
          if (bars.some((b) => archived.get(b.openMs) !== csvLine(b))) {
            this.log.warn(`pair ${p.pair_id} ${d}: raw candles not all in the archive; kept raw`);
            continue;
          }
        }
        const [, n] = (await this.db.query(
          `DELETE FROM lbank_spot_candle WHERE pair_id = $1 AND open_time >= $2 AND open_time < $3`,
          [p.pair_id, new Date(from), new Date(from + 86_400_000)],
        )) as [unknown, number];
        deleted += n;
      }
    }
    return { deleted, archivedDays };
  }

  private async archive(pairId: number, utcDate: string, bars: Bar[], now: Date): Promise<void> {
    const csv = bars.map(csvLine).join('\n');
    const content = gzipSync(Buffer.from(csv, 'utf8'), { level: 9 });
    await this.db
      .createQueryBuilder()
      .insert()
      .into(CandleArchive)
      .values({
        pairId,
        utcDate,
        firstMinute: new Date(bars[0]!.openMs),
        lastMinute: new Date(bars.at(-1)!.openMs),
        bars: bars.length,
        tradedBars: bars.filter((b) => b.volume.gt(0)).length,
        encoding: ARCHIVE_ENCODING,
        content,
        contentSha256: sha256(csv),
        rawBytes: Buffer.byteLength(csv, 'utf8'),
        archivedAt: now,
      })
      .orIgnore()
      .updateEntity(false)
      .execute();
  }

  /** Stored bars of a pair in [fromMs, toMs), ascending: raw rows, then archived days. */
  async loadBars(pairId: number, fromMs: number, toMs: number): Promise<Bar[]> {
    if (toMs <= fromMs) return [];
    const raw = await this.rawBars(pairId, fromMs, toMs);
    const archives = await this.db
      .getRepository(CandleArchive)
      .createQueryBuilder('a')
      .where('a.pair_id = :pairId', { pairId })
      .andWhere('a.last_minute >= :from AND a.first_minute < :to', {
        from: new Date(fromMs),
        to: new Date(toMs),
      })
      .getMany();
    if (!archives.length) return raw;
    const byMinute = new Map<number, Bar>();
    for (const a of archives)
      for (const b of decodeArchive(a))
        if (b.openMs >= fromMs && b.openMs < toMs) byMinute.set(b.openMs, b);
    for (const b of raw) byMinute.set(b.openMs, b);
    return [...byMinute.values()].sort((a, b) => a.openMs - b.openMs);
  }

  private async rawBars(pairId: number, fromMs: number, toMs: number): Promise<Bar[]> {
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

export const ARCHIVE_ENCODING = 'csv-gzip-v1';

/** One canonical archive line: `open_ms,open,high,low,close,volume` with the exact stored digits. */
export const csvLine = (b: Bar) =>
  `${b.openMs},${b.open.toFixed()},${b.high.toFixed()},${b.low.toFixed()},${b.close.toFixed()},${b.volume.toFixed()}`;

/** The bars of an archive row (checked against its SHA-256). */
export function decodeArchive(
  a: Pick<CandleArchive, 'content' | 'contentSha256' | 'encoding'>,
): Bar[] {
  if (a.encoding !== ARCHIVE_ENCODING)
    throw new Error(`unknown candle archive encoding ${a.encoding}`);
  const csv = gunzipSync(a.content).toString('utf8');
  if (sha256(csv) !== a.contentSha256)
    throw new Error('candle archive content does not match its SHA-256');
  return csv
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ms, o, h, l, c, v] = line.split(',');
      return {
        openMs: Number(ms),
        open: new D(o!),
        high: new D(h!),
        low: new D(l!),
        close: new D(c!),
        volume: new D(v!),
      };
    });
}
