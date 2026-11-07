import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { And, type DataSource, LessThan, MoreThanOrEqual } from 'typeorm';
import type { z } from 'zod';

import { isUniqueViolation } from '../../common/entities/unique-violation.js';
import { zodIssueList } from '../../common/pipes/zod-validation.pipe.js';
import { addDays, isoDate } from '../../common/utils/dates.js';
import { plain } from '../../common/utils/plain.js';

import { DailyMetric } from '../daily-metrics/entities/daily-metric.entity.js';
import { CrawlBatch } from '../ingestion/entities/crawl-batch.entity.js';
import { ScanResult } from '../scan/entities/scan-result.entity.js';
import {
  LBANK,
  type ResolvedPair,
  ReviewSchema,
  type ReviewValidation,
  blockingErrors,
  validateReview,
} from '../strategy/index.js';
import { VenueDecision } from '../venues/entities/venue-decision.entity.js';
import { VenueMappingTask } from '../venues/entities/venue-mapping-task.entity.js';

import { VenueDecisionSchema } from './dto/venue-decision.dto.js';
import { Review } from './entities/review.entity.js';

export { VenueDecisionSchema } from './dto/venue-decision.dto.js';

export class ReviewInputError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join('; '));
    this.name = 'ReviewInputError';
  }
}

/** Reviews are created over HTTP, by the CLI and by tests: the service validates its own input. */
const parse = <T>(schema: z.ZodType<T>, v: unknown): T => {
  const r = schema.safeParse(v);
  if (!r.success) throw new ReviewInputError(zodIssueList(r.error));
  return r.data;
};

/**
 * Human decisions (PDF p.15, p.24–27). Every save is a new, immutable revision: a later scan or a
 * later review never overwrites an earlier one. The Tier 1 record the reviewer saw is copied into
 * the review, so it can be exported or printed alongside its evidence.
 */
@Injectable()
export class ReviewService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** LBank pairs of the asset that are verified tradable now (feed proof in the record or a reviewer). */
  private async lbankPairsNow(providerId: string, cmcId: number, recordPairs: ResolvedPair[]) {
    const listed = recordPairs
      .filter((p) => p.mapping === 'OK' || p.mapping === 'CONFIRMED')
      .map((p) => p.marketPair);
    const decisions = await this.db
      .getRepository(VenueDecision)
      .find({ where: { providerId, cmcId, exchange: LBANK }, order: { decidedAt: 'ASC' } });
    const latest = new Map<string, string>();
    for (const d of decisions)
      if (d.marketPair && (d.decision === 'VERIFIED_TRADABLE' || d.decision === 'NOT_TRADABLE'))
        latest.set(d.marketPair, d.decision);
    const verified = listed.filter(
      (mp) =>
        latest.get(mp) !== 'NOT_TRADABLE' &&
        (latest.get(mp) === 'VERIFIED_TRADABLE' ||
          recordPairs.find((p) => p.marketPair === mp)?.trading === 'TRADING'),
    );
    return { listed, verified };
  }

  async create(
    body: unknown,
  ): Promise<{ review: Record<string, unknown>; validation: ReviewValidation }> {
    const input = parse(ReviewSchema, body);
    const record = await this.db
      .getRepository(ScanResult)
      .findOneBy({ batchId: input.batchId, cmcId: input.cmcId });
    if (!record)
      throw new ReviewInputError([
        `no Tier 1 record for CMC id ${input.cmcId} in batch ${input.batchId}`,
      ]);
    const pairs = record.lbankPairs ?? [];
    const lb = await this.lbankPairsNow(record.providerId, record.cmcId, pairs);
    const validation = validateReview(input, {
      symbol: record.symbol,
      verifiedLbankPairs: lb.verified,
      listedLbankPairs: lb.listed,
    });
    const blocking = blockingErrors(validation);
    if (blocking.length) throw new ReviewInputError(blocking);

    const asOfDate = isoDate(record.crawledAt);
    const [batch, recentDaily] = await Promise.all([
      this.db.getRepository(CrawlBatch).findOneByOrFail({ id: record.batchId }),
      this.db.getRepository(DailyMetric).find({
        where: {
          providerId: record.providerId,
          cmcId: record.cmcId,
          dateUtc: And(MoreThanOrEqual(addDays(asOfDate, -7)), LessThan(asOfDate)),
        },
        order: { dateUtc: 'DESC' },
      }),
    ]);
    const tier1Snapshot = plain<Record<string, unknown>>({
      record,
      batch: {
        id: batch.id,
        slotTime: batch.slotTime,
        crawledAt: batch.crawledAt,
        status: batch.status,
        statusReasons: batch.statusReasons,
        isLive: batch.isLive,
      },
      lastSevenDays: recentDaily.map((d) => ({
        dateUtc: d.dateUtc,
        volumeUsd: d.volumeUsd?.toString() ?? null,
        marketCapUsd: d.marketCapUsd?.toString() ?? null,
        vmc: d.vmc?.toString() ?? null,
        closeUsd: d.closeUsd?.toString() ?? null,
        valid: d.valid,
        revision: d.revision,
      })),
      lbankPairsAtReview: lb,
    });

    const reviews = this.db.getRepository(Review);
    for (let attempt = 0; attempt < 3; attempt++) {
      const prev = await reviews.findOne({
        where: { providerId: record.providerId, cmcId: record.cmcId, batchId: record.batchId },
        order: { revision: 'DESC' },
      });
      try {
        const saved = await reviews.save(
          reviews.create({
            providerId: record.providerId,
            cmcId: record.cmcId,
            batchId: record.batchId,
            revision: (prev?.revision ?? 0) + 1,
            supersedesId: prev?.id ?? null,
            reviewer: input.reviewer,
            reviewedAt: new Date(),
            venueDecision: input.venueDecision,
            venueNote: input.venueNote ?? null,
            eventDay: input.eventDay,
            lbankPair: input.lbankPair ?? null,
            chartExchange: input.chartExchange ?? null,
            chartSymbol: input.chartSymbol ?? null,
            chartQuote: input.chartQuote ?? null,
            chartUrl: input.chartUrl ?? null,
            chartTimezone: input.chartTimezone ?? null,
            chartProxyReason: input.chartProxyReason ?? null,
            chartTimestamp: input.chartTimestamp ? new Date(input.chartTimestamp) : null,
            rangeLow: input.rangeLow ?? null,
            chartHistory: input.chartHistory ?? null,
            priorPumpResponse: input.priorPumpResponse ?? null,
            candleState: input.candleState ?? null,
            marketRegime: input.marketRegime ?? null,
            finalDecision: input.finalDecision,
            rationale: input.rationale ?? null,
            plan: validation.plan ?? null,
            planStatus: validation.planStatus,
            validation: { errors: validation.errors, warnings: validation.warnings },
            tier1Snapshot,
          }),
        );
        return { review: plain(await reviews.findOneByOrFail({ id: saved.id })), validation };
      } catch (err) {
        // Two saves at once: the unique (asset, batch, revision) key rejects one; take the next number.
        if (attempt === 2 || !isUniqueViolation(err)) throw err;
      }
    }
    throw new Error('unreachable');
  }

  async list(providerId: string, cmcId: number) {
    const rows = await this.db
      .getRepository(Review)
      .find({ where: { providerId, cmcId }, order: { reviewedAt: 'DESC', revision: 'DESC' } });
    return plain<Array<Record<string, unknown>>>(rows.map(({ tier1Snapshot: _s, ...r }) => r));
  }

  /** One review with the Tier 1 record it was based on (PDF p.27: export alongside its Tier 1 snapshot). */
  async exportReview(id: string) {
    const reviews = this.db.getRepository(Review);
    const r = await reviews.findOneBy({ id });
    if (!r) return null;
    const history = await reviews.find({
      where: { providerId: r.providerId, cmcId: r.cmcId, batchId: r.batchId },
      order: { revision: 'ASC' },
      select: {
        id: true,
        revision: true,
        reviewer: true,
        reviewedAt: true,
        finalDecision: true,
        planStatus: true,
      },
    });
    return plain<Record<string, unknown>>({
      review: r,
      revisions: history,
      note: 'Human review record. Research tooling only: no order was placed and none is implied.',
    });
  }

  /** Append a venue decision (LBank tradability verification or mapping evidence). */
  async decideVenue(body: unknown, providerId: string) {
    const input = parse(VenueDecisionSchema, body);
    if (input.decision !== 'NOT_TRADABLE' && !input.marketPair)
      throw new ReviewInputError([`${input.decision} needs the LBank market pair`]);
    const record = await this.db.getRepository(ScanResult).findOne({
      where: {
        providerId,
        cmcId: input.cmcId,
        ...(input.batchId ? { batchId: input.batchId } : {}),
      },
      order: { crawledAt: 'DESC' },
    });
    if (!record) throw new ReviewInputError([`no Tier 1 record for CMC id ${input.cmcId}`]);
    if (input.marketPair) {
      const pairs = (record.lbankPairs ?? []).map((p) => p.marketPair);
      if (!pairs.includes(input.marketPair))
        throw new ReviewInputError([
          `${input.marketPair} is not an LBank pair of CMC id ${input.cmcId} in batch ${record.batchId}`,
        ]);
    }
    const decisions = this.db.getRepository(VenueDecision);
    const decision = await decisions.save(
      decisions.create({
        providerId,
        cmcId: input.cmcId,
        exchange: input.exchange,
        marketPair: input.marketPair ?? null,
        decision: input.decision,
        reviewer: input.reviewer,
        note: input.note ?? null,
        batchId: record.batchId,
        decidedAt: new Date(),
      }),
    );
    if (
      input.marketPair &&
      (input.decision === 'MAPPING_CONFIRMED' || input.decision === 'MAPPING_REJECTED')
    ) {
      await this.db.getRepository(VenueMappingTask).update(
        {
          providerId,
          cmcId: input.cmcId,
          exchange: input.exchange,
          marketPair: input.marketPair,
          status: 'OPEN',
        },
        { status: 'RESOLVED', resolvedAt: decision.decidedAt, resolvedByDecisionId: decision.id },
      );
    }
    return plain<Record<string, unknown>>({
      decision,
      note: 'Applies from the next scan; reprocess the latest batch to see it now.',
    });
  }
}
