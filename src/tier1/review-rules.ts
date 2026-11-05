import { z } from "zod";
import { D } from "../common/decimal.js";

/**
 * Human review record validation (PDF p.15, p.24–27). Judgments are recorded, never computed:
 * the code validates completeness and internal consistency only. No sizing, order type, fee
 * model or allocation rule is invented (p.26).
 */

export const VENUE_DECISIONS = ["ACCEPT", "REJECT", "PENDING"] as const;
export const EVENT_DAYS = ["FIRST", "SECOND", "LATER", "UNKNOWN"] as const;
export const JUDGMENTS = ["PASS", "REJECT", "UNCERTAIN"] as const;
export const CANDLE_STATES = ["PRE_MOVE", "ALREADY_PUMPED", "UNCERTAIN"] as const;
export const MARKET_REGIMES = ["FAVORABLE", "UNFAVORABLE", "UNCERTAIN"] as const;
export const FINAL_DECISIONS = ["REVIEW", "NO_TRADE", "PLAN_READY"] as const;

/** Time exit: 7 × 24 hours after the actual entry (p.26). */
export const TIME_EXIT_MS = 7 * 24 * 3_600_000;

const text = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));
const price = z.union([z.string(), z.number()]).transform(String).refine((s) => /^\d+(\.\d+)?$/.test(s.trim()), "must be a positive decimal number").transform((s) => s.trim());
const pct = z.union([z.string(), z.number()]).transform(String).refine((s) => /^\d+(\.\d+)?$/.test(s.trim()), "must be a number").transform((s) => s.trim());
const isoTime = z.string().trim().refine((s) => Number.isFinite(Date.parse(s)), "must be an ISO 8601 time");

export const PlanSchema = z
  .object({
    entryPrice: price.optional(),
    entryTime: isoTime.optional(),
    stopPrice: price.optional(),
    targets: z
      .array(z.object({ price: price.optional(), allocationPct: pct.optional(), rationale: text(500) }).strict())
      .max(3)
      .optional(),
    notes: text(2000),
    execution: z
      .object({
        exitTime: isoTime.optional(),
        exitReason: text(200),
        tpFilled: z.array(z.boolean()).max(3).optional(),
        remainingQuantity: text(60),
        finalNote: text(1000),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ReviewSchema = z
  .object({
    cmcId: z.number().int().positive(),
    batchId: z.string().uuid(),
    reviewer: z.string().trim().min(1, "reviewer is required").max(80),
    venueDecision: z.enum(VENUE_DECISIONS).default("PENDING"),
    venueNote: text(1000),
    eventDay: z.enum(EVENT_DAYS).default("UNKNOWN"),
    lbankPair: text(40),
    chartExchange: text(60),
    chartSymbol: text(60),
    chartQuote: text(20),
    chartUrl: text(500).refine((v) => v === undefined || /^https?:\/\/\S+$/i.test(v), "chartUrl must be an http(s) URL"),
    chartTimezone: text(60),
    chartProxyReason: text(500),
    chartTimestamp: isoTime.optional(),
    rangeLow: z.enum(JUDGMENTS).optional(),
    chartHistory: z.enum(JUDGMENTS).optional(),
    priorPumpResponse: z.enum(JUDGMENTS).optional(),
    candleState: z.enum(CANDLE_STATES).optional(),
    marketRegime: z.enum(MARKET_REGIMES).optional(),
    finalDecision: z.enum(FINAL_DECISIONS).default("REVIEW"),
    rationale: text(4000),
    plan: PlanSchema.optional(),
  })
  .strict();

export type ReviewInput = z.infer<typeof ReviewSchema>;

export interface ReviewContext {
  symbol: string;
  /** LBank pairs that are currently verified tradable for the asset (feed proof or reviewer). */
  verifiedLbankPairs: string[];
  /** All LBank pairs currently listed for the asset. */
  listedLbankPairs: string[];
}

export interface NormalizedPlan {
  entryPrice: string | null;
  entryTime: string | null;
  stopPrice: string | null;
  /** (entry − stop) / entry × 100, derived (p.26 "record the actual price and percentage"). */
  stopPct: string | null;
  targets: Array<{ price: string | null; allocationPct: string | null; rationale: string | null }>;
  /** entry time + 7 × 24 h (p.26). */
  deadline: string | null;
  notes: string | null;
  execution: NonNullable<z.infer<typeof PlanSchema>["execution"]> | null;
}

export interface ReviewValidation {
  errors: string[];
  warnings: string[];
  planStatus: "COMPLETE" | "INCOMPLETE" | null;
  plan: NormalizedPlan | null;
}

/** Validate a review against its Tier 1 context; plan problems keep the plan INCOMPLETE. */
export function validateReview(r: ReviewInput, ctx: ReviewContext): ReviewValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (r.finalDecision === "NO_TRADE" && !r.rationale) errors.push("NO_TRADE needs a rationale");
  if (r.chartUrl && !r.chartTimezone) errors.push("record the chart's daily candle-close timezone with the chart URL");
  if (r.chartExchange && r.chartExchange.toLowerCase() !== "lbank" && !r.chartProxyReason) errors.push("a non-LBank chart is a proxy: record the reason");
  if (r.chartSymbol && !r.chartSymbol.toUpperCase().startsWith(ctx.symbol.toUpperCase())) {
    warnings.push(`chart symbol ${r.chartSymbol} does not start with ${ctx.symbol}: confirm it is the same asset, not a ticker match`);
  }
  if (r.lbankPair && !ctx.listedLbankPairs.includes(r.lbankPair)) warnings.push(`${r.lbankPair} is not among the asset's listed LBank pairs`);
  for (const [field, v] of [["range-low judgment", r.rangeLow], ["chart history", r.chartHistory], ["prior pump response", r.priorPumpResponse]] as const) {
    if (v === "UNCERTAIN") warnings.push(`${field} marked UNCERTAIN`);
  }
  const lateOrUncertain = r.eventDay === "LATER" || r.eventDay === "UNKNOWN" || r.candleState === "ALREADY_PUMPED" || r.candleState === "UNCERTAIN";

  let plan: NormalizedPlan | null = null;
  let planStatus: ReviewValidation["planStatus"] = null;
  if (r.plan || r.finalDecision === "PLAN_READY") {
    const p: NonNullable<ReviewInput["plan"]> = r.plan ?? { notes: undefined };
    const planErrors: string[] = [];
    type Target = NonNullable<NonNullable<ReviewInput["plan"]>["targets"]>[number];
    const targets: Target[] = [0, 1, 2].map((i) => p.targets?.[i] ?? { price: undefined, allocationPct: undefined, rationale: undefined });
    const entry = p.entryPrice ? new D(p.entryPrice) : null;
    const stop = p.stopPrice ? new D(p.stopPrice) : null;
    const entryTime = p.entryTime ? new Date(p.entryTime) : null;

    if (!entry || entry.lte(0)) planErrors.push("entry price is required (> 0)");
    if (!entryTime) planErrors.push("entry time is required");
    if (!stop || stop.lte(0)) planErrors.push("stop price is required (> 0)");
    targets.forEach((t, i) => {
      if (!t.price || new D(t.price).lte(0)) planErrors.push(`TP${i + 1} price is required (> 0)`);
      if (!t.allocationPct) planErrors.push(`TP${i + 1} allocation is required`);
      else if (new D(t.allocationPct).lte(0) || new D(t.allocationPct).gt(100)) planErrors.push(`TP${i + 1} allocation must be > 0 and ≤ 100 %`);
    });
    if (!p.notes) planErrors.push("plan notes are required");
    if (entry && stop && !stop.lt(entry)) planErrors.push("stop must be below entry (long spot plan)");
    let prev = entry;
    targets.forEach((t, i) => {
      if (!t.price || !prev) return;
      const tp = new D(t.price);
      if (!tp.gt(prev)) planErrors.push(i === 0 ? "TP1 must be above entry" : `TP${i + 1} must be above TP${i}`);
      prev = tp;
    });
    const allocations = targets.map((t) => (t.allocationPct ? new D(t.allocationPct) : null));
    if (allocations.every((a) => a !== null)) {
      const total = allocations.reduce((s, a) => s.plus(a!), new D(0));
      if (total.gt(100)) planErrors.push(`target allocations add up to ${total.toFixed()} % (> 100 %)`);
      else if (total.lt(100)) warnings.push(`target allocations add up to ${total.toFixed()} % (< 100 %)`);
    }
    if (r.finalDecision === "PLAN_READY") {
      if (!r.lbankPair) planErrors.push("confirm the actual LBank Spot pair");
      else if (!ctx.verifiedLbankPairs.includes(r.lbankPair)) planErrors.push(`LBank pair ${r.lbankPair} is not verified tradable`);
      if (lateOrUncertain && !r.rationale) planErrors.push("a later/uncertain event or candle needs an explicit disposition (rationale)");
    }
    const deadline = entryTime ? new Date(entryTime.getTime() + TIME_EXIT_MS) : null;
    const exec = p.execution ?? null;
    if (exec?.exitTime && entryTime && new Date(exec.exitTime) < entryTime) planErrors.push("exit time is before entry time");
    if (exec?.exitTime && deadline && new Date(exec.exitTime) > deadline) warnings.push("exit recorded after the 7 × 24 h time exit");
    plan = {
      entryPrice: p.entryPrice ?? null,
      entryTime: entryTime?.toISOString() ?? null,
      stopPrice: p.stopPrice ?? null,
      stopPct: entry && stop && entry.gt(0) ? entry.minus(stop).div(entry).times(100).toFixed() : null,
      targets: targets.map((t) => ({ price: t.price ?? null, allocationPct: t.allocationPct ?? null, rationale: t.rationale ?? null })),
      deadline: deadline?.toISOString() ?? null,
      notes: p.notes ?? null,
      execution: exec,
    };
    planStatus = planErrors.length ? "INCOMPLETE" : "COMPLETE";
    errors.push(...planErrors.map((e) => `plan: ${e}`));
  }
  return { errors, warnings, planStatus, plan };
}

/** Errors that make the record itself unusable (rejected); plan errors only mark it INCOMPLETE. */
export const blockingErrors = (v: ReviewValidation) => v.errors.filter((e) => !e.startsWith("plan: "));
