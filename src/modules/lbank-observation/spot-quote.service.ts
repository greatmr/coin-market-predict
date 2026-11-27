import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DataSource } from 'typeorm';

import { redact } from '../../common/security/redact.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { parseSpotPrices } from './kline.js';
import type { SpotPriceFetch } from './lbank-market.source.js';

/**
 * The indicative LBank Spot quote at publication (M020, docs § 13b): the Spot price request is queued
 * together with the Futures quote the moment a Review Queue is published (right behind it, both in the
 * client's `immediate` lane), and each observation of the batch gets its pair's price from that one
 * response, with the request's real queue / send / receive times. Context for a same-moment
 * Spot / Futures comparison only: it never becomes the Spot reference (the first verified trade at or
 * after the start), never enters a Spot return, extreme, status or coverage, and is never retried
 * later (a later price would not be "at publication").
 */
@Injectable()
export class SpotQuoteService {
  private readonly log = new Logger(SpotQuoteService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  get providerId() {
    return this.cfg.DATA_SOURCE;
  }

  /** Record the publication's Spot price request, then give the batch's observations their quote. */
  async capture(batchId: string, pending: Promise<SpotPriceFetch>, queuedAt: Date): Promise<void> {
    try {
      const f = await pending;
      await this.record(batchId, f, queuedAt);
      if (f.ok) await this.assignBatch(batchId);
    } catch (err) {
      this.log.warn(`Spot price at publication failed: ${redact(err)}`);
    }
  }

  /** One row per request (its failed attempts inside), with the raw body of a success. */
  async record(batchId: string, f: SpotPriceFetch, queuedAt: Date): Promise<string> {
    const [row] = (await this.db.query(
      `INSERT INTO lbank_spot_price_request (batch_id, endpoint, request_queued_at, request_started_at,
              response_received_at, ok, error, failed_attempts, lbank_server_at, pairs, invalid,
              response_sha256, body_gzip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id::text`,
      [
        batchId,
        f.url,
        queuedAt,
        f.requestStartedAt,
        f.fetchedAt,
        f.ok,
        f.ok ? null : f.error.slice(0, 300),
        JSON.stringify(
          f.failedAttempts.map((a) => ({
            sentAt: a.sentAt?.toISOString() ?? null,
            failedAt: a.failedAt.toISOString(),
            message: a.message.slice(0, 300),
          })),
        ),
        f.ok ? f.serverAt : null,
        f.ok ? f.rows.length : 0,
        f.ok ? f.invalid : 0,
        f.ok ? f.sha256 : null,
        f.ok ? gzipSync(Buffer.from(f.body)) : null,
      ],
    )) as Array<{ id: string }>;
    return row!.id;
  }

  /**
   * One indicative quote per observation of the batch (idempotent): its pair's price in the batch's
   * first successful Spot price response, only when that request was sent at or after the
   * observation's start and the pair mapping is OK. Called when the response is stored and again
   * after the intake (whichever comes second finds both).
   */
  async assignBatch(batchId: string): Promise<number> {
    const [req] = (await this.db.query(
      `SELECT id::text, request_queued_at, request_started_at, response_received_at, lbank_server_at, body_gzip
         FROM lbank_spot_price_request
        WHERE batch_id = $1 AND ok AND body_gzip IS NOT NULL AND request_started_at IS NOT NULL
        ORDER BY response_received_at, id LIMIT 1`,
      [batchId],
    )) as Array<{
      id: string;
      request_queued_at: Date;
      request_started_at: Date;
      response_received_at: Date;
      lbank_server_at: Date | null;
      body_gzip: Buffer;
    }>;
    if (!req) return 0;
    const obs = (await this.db.query(
      `SELECT o.id, o.pair_symbol, o.observation_start
         FROM lbank_observation o JOIN lbank_obs_event e ON e.id = o.event_id
        WHERE o.provider_id = $1 AND e.source_batch_id = $2 AND o.mapping_status = 'OK'
          AND o.pair_symbol IS NOT NULL AND o.observation_start IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM lbank_spot_indicative_quote q WHERE q.observation_id = o.id)`,
      [this.providerId, batchId],
    )) as Array<{ id: string; pair_symbol: string; observation_start: Date }>;
    if (!obs.length) return 0;
    const parsed = parseSpotPrices(gunzipSync(req.body_gzip).toString('utf8'));
    if (parsed.kind !== 'ok') return 0;
    const prices = new Map(parsed.rows.map((r) => [r.symbol, r.price]));
    let n = 0;
    for (const o of obs) {
      const price = prices.get(o.pair_symbol.toLowerCase());
      // Not in the response, or sent before this observation's start: no quote "at publication".
      if (!price || req.request_started_at.getTime() < o.observation_start.getTime()) continue;
      const res = (await this.db.query(
        `INSERT INTO lbank_spot_indicative_quote (observation_id, request_id, pair_symbol, actionable_start,
                price, request_queued_at, request_started_at, response_received_at, lbank_server_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (observation_id) DO NOTHING RETURNING id`,
        [
          o.id,
          req.id,
          o.pair_symbol,
          o.observation_start,
          price,
          req.request_queued_at,
          req.request_started_at,
          req.response_received_at,
          req.lbank_server_at,
        ],
      )) as unknown[];
      n += res.length;
    }
    return n;
  }
}
