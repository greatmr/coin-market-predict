import { createHash } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";

/**
 * Decimal-safe arithmetic for financial values (decimal.js via Prisma.Decimal).
 * - Inputs keep the exact digits from the API response (see parseExactJson).
 * - Ratios are stored with RATIO_DP decimal places, ROUND_HALF_EVEN.
 * - The baseline mean is computed from the stored (rounded) daily ratios, so it is reproducible
 *   from database rows alone, then rounded the same way.
 */
export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;

export const RATIO_DP = 18;
const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_EVEN });

/** JSON.parse that keeps every number as its exact source text (Node ≥ 21 reviver context). */
export function parseExactJson(text: string): unknown {
  return JSON.parse(text, (_k, v, ctx?: { source?: string }) => (typeof v === "number" && ctx?.source ? ctx.source : v));
}

/** Parse a source value into a Decimal; returns null with a reason when unusable. */
export function toDecimal(v: unknown): { value: Decimal | null; reason: string | null } {
  if (v === null || v === undefined || v === "") return { value: null, reason: "missing" };
  if (typeof v !== "string" && typeof v !== "number") return { value: null, reason: "not_numeric" };
  const s = String(v).trim();
  if (!/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return { value: null, reason: "not_finite" };
  const d = new D(s);
  if (!d.isFinite()) return { value: null, reason: "not_finite" };
  return { value: new Decimal(d.toString()), reason: null };
}

export function ratio(volume: Decimal, marketCap: Decimal): Decimal {
  return new Decimal(new D(volume.toString()).div(new D(marketCap.toString())).toDecimalPlaces(RATIO_DP, Decimal.ROUND_HALF_EVEN).toString());
}

export function meanOf(values: Decimal[]): { sum: Decimal; mean: Decimal } {
  let sum = new D(0);
  for (const v of values) sum = sum.plus(new D(v.toString()));
  const mean = sum.div(values.length).toDecimalPlaces(RATIO_DP, Decimal.ROUND_HALF_EVEN);
  return { sum: new Decimal(sum.toString()), mean: new Decimal(mean.toString()) };
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
