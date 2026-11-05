import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { sha256 } from "../common/decimal.js";
import type { ClassOverride } from "./eligibility.js";
import type { VenueDecisionView } from "./lbank.js";

/**
 * Documented, versioned manual override list (PDF p.9, p.18): classification of ambiguous
 * assets and LBank exchange-mapping decisions. Changes are reviewed like code; the version and
 * content hash are stored with every scan.
 */
const entryBase = { providerId: z.string().min(1).optional(), cmcId: z.number().int().positive(), reason: z.string().trim().min(3), addedBy: z.string().trim().min(1), addedAt: z.string().trim().min(10) };

const Schema = z
  .object({
    version: z.string().trim().min(1),
    updatedAt: z.string().datetime(),
    description: z.string().optional(),
    classOverrides: z.array(z.object({ ...entryBase, class: z.enum(["eligible", "stablecoin", "tokenized"]) }).strict()).default([]),
    lbankMappingOverrides: z.array(z.object({ ...entryBase, marketPair: z.string().trim().min(3), decision: z.enum(["MAPPING_CONFIRMED", "MAPPING_REJECTED"]) }).strict()).default([]),
  })
  .strict();

export interface Overrides {
  version: string;
  hash: string;
  classFor(providerId: string, cmcId: number): ClassOverride | null;
  lbankDecisionsFor(providerId: string, cmcId: number): VenueDecisionView[];
  count: number;
}

export const EMPTY_OVERRIDES: Overrides = { version: "none", hash: "none", classFor: () => null, lbankDecisionsFor: () => [], count: 0 };

export function parseOverrides(text: string): Overrides {
  const parsed = Schema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`invalid overrides file: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const o = parsed.data;
  const at = new Date(o.updatedAt);
  const matches = (e: { providerId?: string; cmcId: number }, providerId: string, cmcId: number) => e.cmcId === cmcId && (!e.providerId || e.providerId === providerId);
  return {
    version: o.version,
    hash: sha256(text).slice(0, 16),
    count: o.classOverrides.length + o.lbankMappingOverrides.length,
    classFor: (providerId, cmcId) => {
      const e = o.classOverrides.findLast((x) => matches(x, providerId, cmcId));
      return e ? { class: e.class, reason: e.reason, version: o.version } : null;
    },
    lbankDecisionsFor: (providerId, cmcId) =>
      o.lbankMappingOverrides
        .filter((x) => matches(x, providerId, cmcId))
        .map((x, i) => ({ id: `overrides:${o.version}:${cmcId}:${i}`, marketPair: x.marketPair, decision: x.decision, decidedAt: at, reviewer: x.addedBy, source: "overrides_file" as const })),
  };
}

export function loadOverrides(path: string): Overrides {
  if (!existsSync(path)) return EMPTY_OVERRIDES;
  return parseOverrides(readFileSync(path, "utf8"));
}
