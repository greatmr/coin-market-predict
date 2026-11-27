import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DataSource } from 'typeorm';

import { redact } from '../../common/security/redact.js';
import { D } from '../../common/utils/decimal.js';
import { type Clock, systemClock } from '../../common/utils/time.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { CutoverService } from '../star-events/cutover.service.js';

import { FuturesObservation } from './entities/futures-observation.entity.js';
import { FuturesPoll } from './entities/futures-poll.entity.js';
import type { FuturesReferenceKind } from './entities/futures-reference.entity.js';
import {
  FUTURES_QUOTE_RULES_VERSION,
  type QuoteObservation,
  type QuoteSource,
  type QuoteWindow,
  evaluateQuote,
  isEligible,
  mapAtPublication,
} from './futures-quote-rules.js';
import { FUTURES_TERMINAL, type FuturesMapping } from './futures-rules.js';
import { type FuturesMarketRow, parseFuturesMarketData } from './kline.js';
import {
  type FuturesMarketFetch,
  LBANK_MARKET_SOURCE,
  type LbankMarketSource,
} from './lbank-market.source.js';
import { ListingEvidenceService } from './listing-evidence.service.js';

/** A stored, successful `marketData` response held in memory by its caller. */
export interface PolledResponse {
  pollId: string;
  trigger: QuoteSource;
  requestStartedMs: number | null;
  fetchedMs: number;
  sha256: string;
  /** Valid rows (positive last price). */
  rows: Map<string, FuturesMarketRow>;
  /** Every contract symbol present in the response (listing evidence for the mapping). */
  symbols: Set<string>;
}

/**
 * Prompt retries after the publication request failed or lacked a mapped contract's valid price
 * (delays after the previous attempt). Operational cadence, not a measurement threshold: every
 * attempt and its real delay is recorded; the minute ticks continue afterwards.
 */
export const QUOTE_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;
/** Levels requested from `marketOrder` for the order-book context. */
export const BOOK_DEPTH = 10;
/** Candidate requests examined per observation when choosing its first observed quote. */
const CANDIDATES = 50;

interface QuoteRow {
  id: string;
  observation_id: string;
  rules_version: string;
  mapping_status: string;
  contract: string | null;
  reasons: string[];
  mapping_evidence: Record<string, unknown>;
  observation_start: Date | null;
  observation_end: Date | null;
  t0: Date;
  cmc_id: number;
  symbol: string;
  cmc_price_usd: string;
  source_batch_id: string;
}

const ms = (d: Date | null | undefined) => (d ? new Date(d).getTime() : null);

/**
 * LBank Futures observed quotes (rules `lbank-futures-quote-1`, docs § 13): the request fired the
 * moment a Review Queue is published, its prompt retries, the contract mapping at publication, the
 * atomic earliest-receipt selection of each observation's first observed quote (ENTRY), the
 * post-fix quote of events already running at the fix (POST_FIX), the window's observed values and
 * the order-book context. Every request attempt is logged with its queue, send and receive times.
 * Never writes a Spot row; never uses a Spot price, a listing snapshot or LBank's 24 h figures.
 */
@Injectable()
export class FuturesQuoteService implements OnApplicationShutdown {
  private readonly log = new Logger(FuturesQuoteService.name);
  clock: Clock = systemClock;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly booking = new Set<string>();

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(LBANK_MARKET_SOURCE) private readonly source: LbankMarketSource,
    private readonly evidence: ListingEvidenceService,
    private readonly cutover: CutoverService,
  ) {}

  get providerId() {
    return this.cfg.DATA_SOURCE;
  }

  /** The immediate path runs with the scheduler (production); tests call the methods directly. */
  private get immediateEnabled() {
    return (
      this.cfg.SCHEDULER_ENABLED &&
      this.cfg.LBANK_OBSERVATION_ENABLED &&
      this.cfg.LBANK_FUTURES_ENABLED
    );
  }

  onApplicationShutdown() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // ── Requests ──────────────────────────────────────────────────────────────────────────────

  /**
   * Log one `marketData` request: each failed attempt (the HTTP client retries) and the outcome,
   * with queue, send and receive times. Returns the stored success, or null.
   */
  async recordRequest(
    f: FuturesMarketFetch,
    meta: {
      trigger: QuoteSource;
      queuedAt: Date;
      batchId: string | null;
      keepBody: boolean;
      stored?: number;
    },
  ): Promise<PolledResponse | null> {
    const polls = this.db.getRepository(FuturesPoll);
    const base = {
      trigger: meta.trigger,
      requestQueuedAt: meta.queuedAt,
      endpoint: f.url,
      batchId: meta.batchId,
    };
    let attempt = 0;
    for (const a of f.failedAttempts)
      await polls.insert({
        ...base,
        attempt: ++attempt,
        requestStartedAt: a.sentAt,
        fetchedAt: a.failedAt,
        serverAt: null,
        ok: false,
        error: a.message.slice(0, 300),
        responseSha256: null,
      });
    if (!f.ok) {
      const last = f.failedAttempts.at(-1);
      // The final failure is a new row unless the client already reported that very attempt.
      const reported =
        !!last && !!f.requestStartedAt && last.sentAt?.getTime() === f.requestStartedAt.getTime();
      if (!reported)
        await polls.insert({
          ...base,
          attempt: attempt + 1,
          requestStartedAt: f.requestStartedAt,
          fetchedAt: f.fetchedAt,
          serverAt: null,
          ok: false,
          error: f.error.slice(0, 300),
          responseSha256: null,
        });
      return null;
    }
    const rows = new Map(f.rows.map((r) => [r.symbol, r]));
    const serverMs = f.rows.length ? Math.max(...f.rows.map((r) => r.serverMs)) : null;
    const ins = await polls
      .createQueryBuilder()
      .insert()
      .values({
        ...base,
        attempt: attempt + 1,
        requestStartedAt: f.requestStartedAt,
        fetchedAt: f.fetchedAt,
        serverAt: serverMs === null ? null : new Date(serverMs),
        ok: true,
        contracts: rows.size,
        stored: meta.stored ?? 0,
        invalid: f.invalid,
        error: null,
        responseSha256: f.sha256,
        bodyGzip: meta.keepBody ? gzipSync(Buffer.from(f.body)) : null,
      })
      .returning(['id'])
      .execute();
    const pollId = String((ins.raw as Array<{ id: string }>)[0]!.id);
    return {
      pollId,
      trigger: meta.trigger,
      requestStartedMs: ms(f.requestStartedAt),
      fetchedMs: f.fetchedAt.getTime(),
      sha256: f.sha256,
      rows,
      symbols: new Set([...(f.symbols ?? []), ...rows.keys()]),
    };
  }

  /** Snapshot rows of a stored response for the given contracts (idempotent). */
  async storeSamples(p: PolledResponse, contracts: Iterable<string>): Promise<number> {
    let n = 0;
    for (const c of contracts) {
      const r = p.rows.get(c);
      if (!r) continue;
      const res: unknown[] = await this.db.query(
        `INSERT INTO lbank_futures_sample (contract, server_at, fetched_at, last_price, turnover_24h,
                volume_24h, high_24h, low_24h, mark_price, instrument_status, response_sha256, poll_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (contract, server_at) DO NOTHING RETURNING contract`,
        [
          c,
          new Date(r.serverMs),
          new Date(p.fetchedMs),
          r.lastPrice,
          r.turnover24h,
          r.volume24h,
          r.high24h,
          r.low24h,
          r.markPrice,
          r.instrumentStatus,
          p.sha256,
          p.pollId,
        ],
      );
      n += res.length;
    }
    return n;
  }

  // ── Immediate request at publication ──────────────────────────────────────────────────────

  /**
   * Called right after the Review Queue is published (the scan committed). Fires the request at
   * once and returns: publication never waits for LBank.
   */
  onPublished(batchId: string): void {
    if (!this.immediateEnabled) return;
    void this.capture(batchId, 'PUBLICATION', 0);
  }

  /** Called right after the intake committed the batch's observations. */
  afterIntake(batchId: string): void {
    if (!this.immediateEnabled) return;
    void this.settleBatch(batchId)
      .then((ids) => this.books(ids))
      .catch((err: unknown) =>
        this.log.warn(`Futures quote settle after intake failed: ${redact(err)}`),
      );
  }

  /** One immediate (or retry) request for a published batch; retries promptly when needed. */
  async capture(batchId: string, trigger: QuoteSource, retryIndex: number): Promise<void> {
    try {
      if (!(await this.cutover.get(this.providerId))) return;
      const queuedAt = this.clock.now();
      const f = await this.source.futuresMarketData();
      const resp = await this.recordRequest(f, { trigger, queuedAt, batchId, keepBody: true });
      const ids = await this.settleBatch(batchId, resp ?? undefined);
      const missing = await this.batchMissingEntry(batchId);
      if ((!resp || missing > 0) && retryIndex < QUOTE_RETRY_DELAYS_MS.length) {
        const t = setTimeout(() => {
          this.timers.delete(t);
          void this.capture(batchId, 'RETRY', retryIndex + 1);
        }, QUOTE_RETRY_DELAYS_MS[retryIndex]);
        t.unref?.();
        this.timers.add(t);
      }
      // Context only, after the quote and any retry are settled or scheduled: never blocks them.
      void this.books(ids).catch(() => undefined);
    } catch (err) {
      this.log.warn(`Futures quote capture (${trigger}) failed: ${redact(err)}`);
    }
  }

  /** Create, map, assign and evaluate the batch's observed-quote rows; returns their ids. */
  async settleBatch(batchId: string, latest?: PolledResponse): Promise<string[]> {
    const obsIds: Array<{ id: string }> = await this.db.query(
      `SELECT o.id FROM lbank_observation o JOIN lbank_obs_event e ON e.id = o.event_id
        WHERE o.provider_id = $1 AND e.source_batch_id = $2`,
      [this.providerId, batchId],
    );
    if (!obsIds.length) return [];
    await this.ensureRows(obsIds.map((o) => o.id));
    const rows = await this.quoteRows({ batchId });
    await this.settle(rows, latest ?? (await this.latestBody(batchId)) ?? undefined);
    await this.evaluate(await this.quoteRows({ batchId }));
    return rows.map((r) => r.id);
  }

  private async batchMissingEntry(batchId: string): Promise<number> {
    const [r] = (await this.db.query(
      `SELECT count(*)::int AS n FROM lbank_futures_observation f
         JOIN lbank_observation o ON o.id = f.observation_id JOIN lbank_obs_event e ON e.id = o.event_id
        WHERE e.source_batch_id = $1 AND f.rules_version = $2 AND f.finalized_at IS NULL
          AND f.mapping_status IN ('OK', 'PENDING')
          AND NOT EXISTS (SELECT 1 FROM lbank_futures_reference r WHERE r.futures_observation_id = f.id AND r.kind = 'ENTRY')`,
      [batchId, FUTURES_QUOTE_RULES_VERSION],
    )) as Array<{ n: number }>;
    return r?.n ?? 0;
  }

  /** The batch's latest stored publication / retry response (raw body kept for reconciliation). */
  private async latestBody(batchId: string): Promise<PolledResponse | null> {
    const [p] = (await this.db.query(
      `SELECT id::text, trigger, request_started_at, fetched_at, response_sha256, body_gzip
         FROM lbank_futures_poll WHERE batch_id = $1 AND ok AND body_gzip IS NOT NULL
        ORDER BY fetched_at DESC LIMIT 1`,
      [batchId],
    )) as Array<{
      id: string;
      trigger: QuoteSource;
      request_started_at: Date | null;
      fetched_at: Date;
      response_sha256: string;
      body_gzip: Buffer;
    }>;
    if (!p) return null;
    const parsed = parseFuturesMarketData(gunzipSync(p.body_gzip).toString('utf8'));
    if (parsed.kind !== 'ok') return null;
    return {
      pollId: p.id,
      trigger: p.trigger,
      requestStartedMs: ms(p.request_started_at),
      fetchedMs: p.fetched_at.getTime(),
      sha256: p.response_sha256,
      rows: new Map(parsed.rows.map((r) => [r.symbol, r])),
      symbols: new Set(parsed.symbols),
    };
  }

  // ── Rows, mapping and the first observed quote ────────────────────────────────────────────

  /** Observed-quote rows for observations that have no Futures row yet (never for older ones). */
  async ensureRows(observationIds?: string[]): Promise<number> {
    const r: Array<{ id: string }> = await this.db.query(
      `INSERT INTO lbank_futures_observation (observation_id, provider_id, rules_version, mapping_status, status, reasons, last_update_at)
       SELECT o.id, o.provider_id, $2, 'PENDING', 'PENDING', ARRAY['FUTURES_MAPPING_PENDING'], $3
         FROM lbank_observation o
        WHERE o.provider_id = $1 ${observationIds ? 'AND o.id = ANY($4)' : ''}
          AND NOT EXISTS (SELECT 1 FROM lbank_futures_observation f WHERE f.observation_id = o.id)
       ON CONFLICT (observation_id) DO NOTHING
       RETURNING id`,
      observationIds
        ? [this.providerId, FUTURES_QUOTE_RULES_VERSION, this.clock.now(), observationIds]
        : [this.providerId, FUTURES_QUOTE_RULES_VERSION, this.clock.now()],
    );
    return r.length;
  }

  async quoteRows(scope: { batchId?: string; open?: boolean } = {}): Promise<QuoteRow[]> {
    const params: unknown[] = [this.providerId, FUTURES_QUOTE_RULES_VERSION];
    let extra = '';
    if (scope.batchId) {
      params.push(scope.batchId);
      extra += ` AND e.source_batch_id = $${params.length}`;
    }
    if (scope.open !== false) extra += ' AND f.finalized_at IS NULL';
    return (await this.db.query(
      `SELECT f.id, f.observation_id, f.rules_version, f.mapping_status, f.contract, f.reasons, f.mapping_evidence,
              o.observation_start, o.observation_end, o.t0, e.cmc_id, e.symbol,
              e.cmc_price_usd::text AS cmc_price_usd, e.source_batch_id
         FROM lbank_futures_observation f
         JOIN lbank_observation o ON o.id = f.observation_id
         JOIN lbank_obs_event e ON e.id = o.event_id
        WHERE f.provider_id = $1 AND f.rules_version = $2 ${extra}`,
      params,
    )) as QuoteRow[];
  }

  /** Map PENDING rows (CMC list as of the crawl + an LBank response), then assign first quotes. */
  async settle(rows: QuoteRow[], latest?: PolledResponse): Promise<void> {
    const pending = rows.filter((r) => r.mapping_status === 'PENDING');
    if (pending.length && latest) {
      const byT0 = new Map<number, QuoteRow[]>();
      for (const r of pending) byT0.set(r.t0.getTime(), [...(byT0.get(r.t0.getTime()) ?? []), r]);
      for (const [t0, group] of byT0) {
        const cmc = await this.evidence.cmcFuturesAt(
          this.providerId,
          new Date(t0),
          group.map((r) => ({ cmcId: r.cmc_id, symbol: r.symbol })),
        );
        for (const r of group) {
          const c = cmc.get(r.cmc_id) ?? null;
          const m = mapAtPublication({
            cmc: c
              ? {
                  status: c.listStatus === 'VERIFIED' ? c.status : 'UNKNOWN',
                  contracts: c.contracts,
                  fetchedAt: c.fetchedAt,
                }
              : null,
            lbankSymbols: latest.symbols,
            lbankPollId: latest.pollId,
            coinSymbol: r.symbol,
          });
          if (m.status === 'PENDING') {
            // Keep waiting, with the reason (e.g. not in this LBank response).
            await this.db
              .getRepository(FuturesObservation)
              .update(
                { id: r.id, mappingStatus: 'PENDING' },
                { reasons: m.reasons, mappingEvidence: m.evidence as never },
              );
            r.reasons = m.reasons;
            continue;
          }
          await this.db.getRepository(FuturesObservation).update(
            { id: r.id, mappingStatus: 'PENDING' },
            {
              mappingStatus: m.status,
              contract: m.contract,
              mappingEvidence: m.evidence as never,
              reasons: m.reasons,
              lastUpdateAt: this.clock.now(),
            },
          );
          r.mapping_status = m.status;
          r.contract = m.contract;
        }
      }
    }
    for (const r of rows)
      if (r.mapping_status === 'OK' && r.contract && r.observation_start && r.observation_end)
        await this.assign(r, 'ENTRY', latest);
  }

  /**
   * The first observed quote of an observation: among our successful responses sent at or after its
   * start (and received before its end), the one received first that carries a valid price for the
   * contract. Stored with an earliest-receipt-wins upsert (and a trigger), so concurrent requests,
   * retries and ticks can never replace it with a later one.
   */
  async assign(
    r: QuoteRow,
    kind: FuturesReferenceKind,
    latest?: PolledResponse,
    notBeforeMs?: number,
  ): Promise<boolean> {
    const w: QuoteWindow = {
      startMs: r.observation_start!.getTime(),
      endMs: r.observation_end!.getTime(),
    };
    const from = new Date(Math.max(w.startMs, notBeforeMs ?? w.startMs));
    const cands = (await this.db.query(
      `SELECT p.id::text, p.trigger, p.request_queued_at, p.request_started_at, p.fetched_at, p.endpoint,
              p.body_gzip IS NOT NULL AS has_body,
              s.last_price::text AS price, s.server_at, s.turnover_24h::text AS turnover, s.volume_24h::text AS volume
         FROM lbank_futures_poll p
         LEFT JOIN lbank_futures_sample s ON s.poll_id = p.id AND s.contract = $1
        WHERE p.ok AND p.request_started_at >= $2 AND p.fetched_at < $3
        ORDER BY p.fetched_at, p.request_started_at, p.id
        LIMIT ${CANDIDATES}`,
      [r.contract, from, new Date(w.endMs)],
    )) as Array<{
      id: string;
      trigger: QuoteSource;
      request_queued_at: Date | null;
      request_started_at: Date;
      fetched_at: Date;
      endpoint: string | null;
      has_body: boolean;
      price: string | null;
      server_at: Date | null;
      turnover: string | null;
      volume: string | null;
    }>;
    for (const c of cands) {
      let row: {
        price: string | null;
        serverMs: number | null;
        turnover: string | null;
        volume: string | null;
      } = {
        price: c.price,
        serverMs: ms(c.server_at),
        turnover: c.turnover,
        volume: c.volume,
      };
      if (row.price === null) {
        // Not sampled for this contract: read it from the response itself (in memory or kept body).
        const resp = latest?.pollId === c.id ? latest : c.has_body ? await this.bodyOf(c.id) : null;
        const x = resp?.rows.get(r.contract!);
        if (!x) continue;
        row = {
          price: x.lastPrice,
          serverMs: x.serverMs,
          turnover: x.turnover24h,
          volume: x.volume24h,
        };
        if (resp) await this.storeSamples(resp, [r.contract!]);
      }
      const o: QuoteObservation = {
        pollId: c.id,
        source: c.trigger,
        requestStartedMs: c.request_started_at.getTime(),
        responseMs: c.fetched_at.getTime(),
        price: row.price === null ? null : new D(row.price),
      };
      if (!isEligible(o, w)) continue;
      const [failed] = (await this.db.query(
        `SELECT count(*)::int AS n FROM lbank_futures_poll
          WHERE NOT ok AND coalesce(request_started_at, fetched_at) >= $1 AND coalesce(request_started_at, fetched_at) < $2`,
        [from, c.request_started_at],
      )) as Array<{ n: number }>;
      await this.db.query(
        `INSERT INTO lbank_futures_reference
           (futures_observation_id, kind, rules_version, contract, actionable_start, poll_id, source, endpoint,
            request_queued_at, request_started_at, response_received_at, last_price, quote_refreshed_at,
            turnover_24h, volume_24h, failed_attempts_before)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (futures_observation_id, kind) DO UPDATE SET
           poll_id = EXCLUDED.poll_id, source = EXCLUDED.source, endpoint = EXCLUDED.endpoint,
           request_queued_at = EXCLUDED.request_queued_at, request_started_at = EXCLUDED.request_started_at,
           response_received_at = EXCLUDED.response_received_at, stored_at = clock_timestamp(),
           last_price = EXCLUDED.last_price, quote_refreshed_at = EXCLUDED.quote_refreshed_at,
           turnover_24h = EXCLUDED.turnover_24h, volume_24h = EXCLUDED.volume_24h,
           failed_attempts_before = EXCLUDED.failed_attempts_before
         WHERE EXCLUDED.response_received_at < lbank_futures_reference.response_received_at
            OR (EXCLUDED.response_received_at = lbank_futures_reference.response_received_at
                AND EXCLUDED.request_started_at < lbank_futures_reference.request_started_at)`,
        [
          r.id,
          kind,
          FUTURES_QUOTE_RULES_VERSION,
          r.contract,
          r.observation_start,
          c.id,
          c.trigger,
          c.endpoint ?? 'marketData',
          c.request_queued_at,
          c.request_started_at,
          c.fetched_at,
          row.price,
          row.serverMs === null ? null : new Date(row.serverMs),
          row.turnover,
          row.volume,
          failed?.n ?? 0,
        ],
      );
      return true;
    }
    return false;
  }

  private async bodyOf(pollId: string): Promise<PolledResponse | null> {
    const [p] = (await this.db.query(
      `SELECT id::text, trigger, request_started_at, fetched_at, response_sha256, body_gzip
         FROM lbank_futures_poll WHERE id = $1 AND body_gzip IS NOT NULL`,
      [pollId],
    )) as Array<{
      id: string;
      trigger: QuoteSource;
      request_started_at: Date | null;
      fetched_at: Date;
      response_sha256: string;
      body_gzip: Buffer;
    }>;
    if (!p) return null;
    const parsed = parseFuturesMarketData(gunzipSync(p.body_gzip).toString('utf8'));
    if (parsed.kind !== 'ok') return null;
    return {
      pollId: p.id,
      trigger: p.trigger,
      requestStartedMs: ms(p.request_started_at),
      fetchedMs: p.fetched_at.getTime(),
      sha256: p.response_sha256,
      rows: new Map(parsed.rows.map((x) => [x.symbol, x])),
      symbols: new Set(parsed.symbols),
    };
  }

  /**
   * Events whose window was already running when this method was deployed keep their older
   * reference; the first price observed after the fix is recorded apart (POST_FIX), with its real
   * delay — never as their entry reference.
   */
  async postFix(latest: PolledResponse): Promise<number> {
    const rows = (await this.db.query(
      `SELECT f.id, f.observation_id, f.rules_version, f.mapping_status, f.contract, f.reasons, f.mapping_evidence,
              o.observation_start, o.observation_end, o.t0, e.cmc_id, e.symbol,
              e.cmc_price_usd::text AS cmc_price_usd, e.source_batch_id
         FROM lbank_futures_observation f
         JOIN lbank_observation o ON o.id = f.observation_id
         JOIN lbank_obs_event e ON e.id = o.event_id
        WHERE f.provider_id = $1 AND f.rules_version <> $2 AND f.finalized_at IS NULL
          AND f.mapping_status = 'OK' AND f.contract IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM lbank_futures_reference r WHERE r.futures_observation_id = f.id AND r.kind = 'POST_FIX')`,
      [this.providerId, FUTURES_QUOTE_RULES_VERSION],
    )) as QuoteRow[];
    let n = 0;
    for (const r of rows)
      if (r.observation_start && r.observation_end && (await this.assign(r, 'POST_FIX', latest)))
        n++;
    return n;
  }

  // ── Evaluation ────────────────────────────────────────────────────────────────────────────

  /** Status and observed window values of observed-quote rows (never a Spot value). */
  async evaluate(rows: QuoteRow[]): Promise<{ evaluated: number; finalized: number }> {
    if (!rows.length) return { evaluated: 0, finalized: 0 };
    const [lr] = (await this.db.query(
      `SELECT max(coalesce(request_started_at, fetched_at)) AS at FROM lbank_futures_poll`,
    )) as Array<{ at: Date | null }>;
    const latestRequestStartedMs = ms(lr?.at);
    const now = this.clock.now();
    let finalized = 0;
    for (const r of rows) {
      const window =
        r.observation_start && r.observation_end
          ? { startMs: r.observation_start.getTime(), endMs: r.observation_end.getTime() }
          : null;
      const mapping: FuturesMapping = {
        status: r.mapping_status as FuturesMapping['status'],
        contract: r.contract,
        reasons: r.mapping_status === 'OK' ? [] : r.reasons,
        evidence: r.mapping_evidence ?? {},
      };
      const [ref] = (await this.db.query(
        `SELECT poll_id::text, source, request_started_at, response_received_at, last_price::text AS price
           FROM lbank_futures_reference WHERE futures_observation_id = $1 AND kind = 'ENTRY'`,
        [r.id],
      )) as Array<{
        poll_id: string;
        source: QuoteSource;
        request_started_at: Date;
        response_received_at: Date;
        price: string;
      }>;
      const reference: QuoteObservation | null = ref
        ? {
            pollId: ref.poll_id,
            source: ref.source,
            requestStartedMs: ref.request_started_at.getTime(),
            responseMs: ref.response_received_at.getTime(),
            price: new D(ref.price),
          }
        : null;
      let values: WindowValues = {
        count: 0,
        highest: null,
        lowest: null,
        maxGapMs: 0,
        throughMs: null,
      };
      if (window && r.contract && mapping.status === 'OK')
        values = await this.windowValuesSql(r.contract, window, reference);
      const e = evaluateQuote({
        mapping,
        window,
        reference,
        values,
        latestRequestStartedMs,
        cmcPriceUsd: new D(r.cmc_price_usd),
      });
      const terminal = e.terminal && FUTURES_TERMINAL.includes(e.status);
      await this.db.getRepository(FuturesObservation).update(
        { id: r.id },
        {
          status: e.status,
          reasons: e.reasons,
          flags: e.flags,
          referencePrice: (reference ? reference.price!.toFixed() : null) as never,
          highestPrice: (values.highest?.price ??
            (reference ? reference.price!.toFixed() : null)) as never,
          highestObservedAt: values.highest
            ? new Date(values.highest.observedMs)
            : reference
              ? new Date(reference.responseMs)
              : null,
          highestReturnPct: (e.highestReturnPct?.toFixed() ?? null) as never,
          lowestPrice: (values.lowest?.price ??
            (reference ? reference.price!.toFixed() : null)) as never,
          lowestObservedAt: values.lowest
            ? new Date(values.lowest.observedMs)
            : reference
              ? new Date(reference.responseMs)
              : null,
          lowestReturnPct: (e.lowestReturnPct?.toFixed() ?? null) as never,
          samplesInWindow: Math.max(values.count, reference ? 1 : 0),
          bracketedInWindow: 0,
          maxGapMs: String(values.maxGapMs),
          sampledThrough:
            values.throughMs === null
              ? reference
                ? new Date(reference.responseMs)
                : null
              : new Date(values.throughMs),
          lastUpdateAt: now,
          finalizedAt: terminal ? now : null,
        },
      );
      if (terminal) finalized++;
    }
    return { evaluated: rows.length, finalized };
  }

  /** Observed values from the stored eligible snapshots (in SQL; the reference always included). */
  private async windowValuesSql(
    contract: string,
    w: QuoteWindow,
    reference: QuoteObservation | null,
  ) {
    const [x] = (await this.db.query(
      `WITH e AS (
         SELECT s.last_price AS p, q.fetched_at AS t, q.id AS poll
           FROM lbank_futures_sample s JOIN lbank_futures_poll q ON q.id = s.poll_id
          WHERE s.contract = $1 AND q.ok AND q.request_started_at >= $2 AND q.fetched_at < $3 AND s.last_price > 0),
       g AS (SELECT t - lag(t, 1, $2::timestamptz) OVER (ORDER BY t) AS gap FROM e)
       SELECT (SELECT count(*)::int FROM e) AS n,
              (SELECT extract(epoch FROM max(gap)) * 1000 FROM g) AS gap_ms,
              (SELECT max(t) FROM e) AS through,
              (SELECT json_build_object('p', p::text, 't', t, 'poll', poll::text) FROM e ORDER BY p DESC, t LIMIT 1) AS hi,
              (SELECT json_build_object('p', p::text, 't', t, 'poll', poll::text) FROM e ORDER BY p ASC, t LIMIT 1) AS lo`,
      [contract, new Date(w.startMs), new Date(w.endMs)],
    )) as Array<{
      n: number;
      gap_ms: string | null;
      through: Date | null;
      hi: { p: string; t: string; poll: string } | null;
      lo: { p: string; t: string; poll: string } | null;
    }>;
    const ext = (v: { p: string; t: string; poll: string } | null) =>
      v ? { price: new D(v.p).toFixed(), observedMs: Date.parse(v.t), pollId: v.poll } : null;
    let highest = ext(x?.hi ?? null);
    let lowest = ext(x?.lo ?? null);
    if (reference) {
      const rp = reference.price!.toFixed();
      const ro = { price: rp, observedMs: reference.responseMs, pollId: reference.pollId };
      if (!highest || new D(rp).gt(highest.price)) highest = ro;
      if (!lowest || new D(rp).lt(lowest.price)) lowest = ro;
    }
    return {
      count: x?.n ?? 0,
      highest,
      lowest,
      maxGapMs: x?.gap_ms ? Math.round(Number(x.gap_ms)) : 0,
      throughMs: ms(x?.through ?? null),
    };
  }

  // ── Order-book context ────────────────────────────────────────────────────────────────────

  /** One order-book read per observation, right after its first quote (never blocks the quote). */
  async books(futuresIds: string[]): Promise<void> {
    if (!futuresIds.length) return;
    const todo = (await this.db.query(
      `SELECT f.id, f.contract FROM lbank_futures_observation f
        WHERE f.id = ANY($1) AND f.contract IS NOT NULL AND f.mapping_status = 'OK'
          AND EXISTS (SELECT 1 FROM lbank_futures_reference r WHERE r.futures_observation_id = f.id AND r.kind = 'ENTRY')
          AND NOT EXISTS (SELECT 1 FROM lbank_futures_book b WHERE b.futures_observation_id = f.id)`,
      [futuresIds],
    )) as Array<{ id: string; contract: string }>;
    for (const t of todo) {
      if (this.booking.has(t.id)) continue;
      this.booking.add(t.id);
      try {
        const b = await this.source.futuresOrderBook(t.contract, BOOK_DEPTH);
        await this.db.query(
          `INSERT INTO lbank_futures_book (futures_observation_id, contract, endpoint, request_started_at,
                  response_received_at, ok, error, best_bid, best_ask, bids, asks, response_sha256)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            t.id,
            t.contract,
            b.url,
            b.requestStartedAt,
            b.fetchedAt,
            b.ok,
            b.ok ? null : b.error.slice(0, 300),
            b.ok ? (b.bids[0]?.price ?? null) : null,
            b.ok ? (b.asks[0]?.price ?? null) : null,
            b.ok ? JSON.stringify(b.bids) : null,
            b.ok ? JSON.stringify(b.asks) : null,
            b.ok ? b.sha256 : null,
          ],
        );
      } catch (err) {
        this.log.warn(`Futures order book for ${t.contract} failed: ${redact(err)}`);
      } finally {
        this.booking.delete(t.id);
      }
    }
  }
}

interface WindowValues {
  count: number;
  highest: { price: string; observedMs: number; pollId: string } | null;
  lowest: { price: string; observedMs: number; pollId: string } | null;
  maxGapMs: number;
  throughMs: number | null;
}
