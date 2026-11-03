import { z } from "zod";

/**
 * Structured outputs returned by the agents. They are validated twice: by the SDK against the
 * JSON Schema (draft-07) and again by Zod in application code. There is deliberately no
 * probability field: agents produce heuristic assessments, not calibrated probabilities.
 */

export const SIGNAL_STATUSES = ["candidate", "watch", "insufficient_data", "no_signal"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

const text = (max: number) => z.string().min(1).max(max);

export const EvidenceItem = z.object({
  metric: text(64).describe("Exact key from the evidence pack (feature name or latest.* field)"),
  value: z.number().nullable().describe("Value exactly as supplied in the evidence pack"),
  observedAt: text(40).describe("Source observation timestamp (ISO 8601) the value refers to"),
  interpretation: text(300),
});

export const CounterEvidenceItem = z.object({
  point: text(300),
  metric: z.string().max(64).nullable(),
});

export const DataQuality = z.object({
  assessment: z.enum(["good", "degraded", "poor"]),
  issues: z.array(text(200)).max(8),
  missing: z.array(text(80)).max(16),
});

export const AssetAssessment = z.object({
  assetId: z.string().uuid(),
  status: z.enum(SIGNAL_STATUSES),
  signalType: z.enum(["advance", "move_underway", "none"]),
  horizonHours: z.number().int().min(1).max(72),
  score: z.number().min(0).max(100).describe("Heuristic conviction 0-100. NOT a probability."),
  evidence: z.array(EvidenceItem).max(8),
  counterevidence: z.array(CounterEvidenceItem).max(8),
  dataQuality: DataQuality,
  entryTrigger: text(300),
  invalidation: text(300),
  exitConditions: z.object({
    target: text(200),
    trailing: text(200),
    maxHoldingHours: z.number().int().min(1).max(168),
  }),
  expiresAt: z.string().datetime({ offset: true }),
  rationale: text(800),
});
export type AssetAssessment = z.infer<typeof AssetAssessment>;

export const AnalystOutput = z.object({ assessments: z.array(AssetAssessment).max(25) });
export type AnalystOutput = z.infer<typeof AnalystOutput>;

export const Review = z.object({
  assetId: z.string().uuid(),
  verdict: z.enum(["agree", "downgrade", "reject"]),
  recommendedStatus: z.enum(SIGNAL_STATUSES),
  confidence: z.enum(["low", "medium", "high"]),
  concerns: z.array(text(300)).max(8),
  failureConditions: z.array(text(300)).max(8),
  dataQualityIssues: z.array(text(200)).max(8),
});
export type Review = z.infer<typeof Review>;

export const ReviewOutput = z.object({ reviews: z.array(Review).max(25) });
export type ReviewOutput = z.infer<typeof ReviewOutput>;

export const CoordinatorOutput = z.object({
  signals: z.array(AssetAssessment).max(25),
  reportSummary: text(600).describe("Two or three sentences for the report header. No promises, no guaranteed outcomes."),
});
export type CoordinatorOutput = z.infer<typeof CoordinatorOutput>;

/** JSON Schema (draft-07, as required by the Agent SDK) for an output schema. */
export function toSdkSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
}
