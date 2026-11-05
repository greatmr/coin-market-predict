import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { isoDate, parseIsoDate, addDays } from "../common/dates.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { plain } from "../read-model/plain.js";
import { LBANK } from "./constants.js";
import type { ResolvedPair } from "./lbank.js";
import { blockingErrors, ReviewSchema, validateReview, type ReviewValidation } from "./review-rules.js";

export class ReviewInputError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join("; "));
    this.name = "ReviewInputError";
  }
}

export const VenueDecisionSchema = z
  .object({
    cmcId: z.number().int().positive(),
    batchId: z.string().uuid().optional(),
    exchange: z.literal(LBANK).default(LBANK),
    marketPair: z.string().trim().min(3).max(40).nullable().optional(),
    decision: z.enum(["VERIFIED_TRADABLE", "NOT_TRADABLE", "MAPPING_CONFIRMED", "MAPPING_REJECTED"]),
    reviewer: z.string().trim().min(1, "reviewer is required").max(80),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

const parse = <T>(schema: z.ZodType<T>, v: unknown): T => {
  const r = schema.safeParse(v);
  if (!r.success) throw new ReviewInputError(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`));
  return r.data;
};

/**
 * Human decisions (PDF p.15, p.24–27). Every save is a new, immutable revision: a later scan or a
 * later review never overwrites an earlier one. The Tier 1 record the reviewer saw is copied into
 * the review, so it can be exported or printed alongside its evidence.
 */
@Injectable()
export class ReviewService {
  constructor(private readonly prisma: PrismaService) {}

  /** LBank pairs of the asset that are verified tradable now (feed proof in the record or a reviewer). */
  private async lbankPairsNow(providerId: string, cmcId: number, recordPairs: ResolvedPair[]) {
    const listed = recordPairs.filter((p) => p.mapping === "OK" || p.mapping === "CONFIRMED").map((p) => p.marketPair);
    const decisions = await this.prisma.venueDecision.findMany({ where: { providerId, cmcId, exchange: LBANK }, orderBy: { decidedAt: "asc" } });
    const latest = new Map<string, string>();
    for (const d of decisions) if (d.marketPair && (d.decision === "VERIFIED_TRADABLE" || d.decision === "NOT_TRADABLE")) latest.set(d.marketPair, d.decision);
    const verified = listed.filter((mp) => latest.get(mp) !== "NOT_TRADABLE" && (latest.get(mp) === "VERIFIED_TRADABLE" || recordPairs.find((p) => p.marketPair === mp)?.trading === "TRADING"));
    return { listed, verified };
  }

  async create(body: unknown): Promise<{ review: Record<string, unknown>; validation: ReviewValidation }> {
    const input = parse(ReviewSchema, body);
    const record = await this.prisma.scanResult.findUnique({ where: { batchId_cmcId: { batchId: input.batchId, cmcId: input.cmcId } } });
    if (!record) throw new ReviewInputError([`no Tier 1 record for CMC id ${input.cmcId} in batch ${input.batchId}`]);
    const pairs = (record.lbankPairs ?? []) as unknown as ResolvedPair[];
    const lb = await this.lbankPairsNow(record.providerId, record.cmcId, pairs);
    const validation = validateReview(input, { symbol: record.symbol, verifiedLbankPairs: lb.verified, listedLbankPairs: lb.listed });
    const blocking = blockingErrors(validation);
    if (blocking.length) throw new ReviewInputError(blocking);

    const [batch, recentDaily] = await Promise.all([
      this.prisma.crawlBatch.findUniqueOrThrow({ where: { id: record.batchId } }),
      this.prisma.dailyMetric.findMany({
        where: { providerId: record.providerId, cmcId: record.cmcId, dateUtc: { gte: parseIsoDate(addDays(isoDate(record.crawledAt), -7)), lt: parseIsoDate(isoDate(record.crawledAt)) } },
        orderBy: { dateUtc: "desc" },
      }),
    ]);
    const tier1Snapshot = plain({
      record,
      batch: { id: batch.id, slotTime: batch.slotTime, crawledAt: batch.crawledAt, status: batch.status, statusReasons: batch.statusReasons, isLive: batch.isLive },
      lastSevenDays: recentDaily.map((d) => ({ dateUtc: isoDate(d.dateUtc), volumeUsd: d.volumeUsd?.toString() ?? null, marketCapUsd: d.marketCapUsd?.toString() ?? null, vmc: d.vmc?.toString() ?? null, closeUsd: d.closeUsd?.toString() ?? null, valid: d.valid, revision: d.revision })),
      lbankPairsAtReview: lb,
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      const prev = await this.prisma.review.findFirst({ where: { providerId: record.providerId, cmcId: record.cmcId, batchId: record.batchId }, orderBy: { revision: "desc" } });
      try {
        const review = await this.prisma.review.create({
          data: {
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
            plan: (validation.plan ?? undefined) as never,
            planStatus: validation.planStatus,
            validation: { errors: validation.errors, warnings: validation.warnings } as never,
            tier1Snapshot: tier1Snapshot as never,
          },
        });
        return { review: plain(review), validation };
      } catch (err) {
        // Two saves at once: the unique (asset, batch, revision) key rejects one; take the next number.
        if (attempt === 2 || !(err instanceof Error) || !/Unique constraint/i.test(err.message)) throw err;
      }
    }
    throw new Error("unreachable");
  }

  async list(providerId: string, cmcId: number) {
    const rows = await this.prisma.review.findMany({ where: { providerId, cmcId }, orderBy: [{ reviewedAt: "desc" }, { revision: "desc" }] });
    return plain<Array<Record<string, unknown>>>(rows.map(({ tier1Snapshot: _s, ...r }) => r));
  }

  /** One review with the Tier 1 record it was based on (PDF p.27: export alongside its Tier 1 snapshot). */
  async exportReview(id: string) {
    const r = await this.prisma.review.findUnique({ where: { id } });
    if (!r) return null;
    const history = await this.prisma.review.findMany({ where: { providerId: r.providerId, cmcId: r.cmcId, batchId: r.batchId }, orderBy: { revision: "asc" }, select: { id: true, revision: true, reviewer: true, reviewedAt: true, finalDecision: true, planStatus: true } });
    return plain<Record<string, unknown>>({ review: r, revisions: history, note: "Human review record. Research tooling only: no order was placed and none is implied." });
  }

  /** Append a venue decision (LBank tradability verification or mapping evidence). */
  async decideVenue(body: unknown, providerId: string) {
    const input = parse(VenueDecisionSchema, body);
    if (input.decision !== "NOT_TRADABLE" && !input.marketPair) throw new ReviewInputError([`${input.decision} needs the LBank market pair`]);
    const record = await this.prisma.scanResult.findFirst({ where: { providerId, cmcId: input.cmcId, ...(input.batchId ? { batchId: input.batchId } : {}) }, orderBy: { crawledAt: "desc" } });
    if (!record) throw new ReviewInputError([`no Tier 1 record for CMC id ${input.cmcId}`]);
    if (input.marketPair) {
      const pairs = ((record.lbankPairs ?? []) as unknown as ResolvedPair[]).map((p) => p.marketPair);
      if (!pairs.includes(input.marketPair)) throw new ReviewInputError([`${input.marketPair} is not an LBank pair of CMC id ${input.cmcId} in batch ${record.batchId}`]);
    }
    const decision = await this.prisma.venueDecision.create({
      data: { providerId, cmcId: input.cmcId, exchange: input.exchange, marketPair: input.marketPair ?? null, decision: input.decision, reviewer: input.reviewer, note: input.note ?? null, batchId: record.batchId, decidedAt: new Date() },
    });
    if (input.marketPair && (input.decision === "MAPPING_CONFIRMED" || input.decision === "MAPPING_REJECTED")) {
      await this.prisma.venueMappingTask.updateMany({ where: { providerId, cmcId: input.cmcId, exchange: input.exchange, marketPair: input.marketPair, status: "OPEN" }, data: { status: "RESOLVED", resolvedAt: decision.decidedAt, resolvedByDecisionId: decision.id } });
    }
    return plain<Record<string, unknown>>({ decision, note: "Applies from the next scan; reprocess the latest batch to see it now." });
  }
}
