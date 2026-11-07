import { Decimal as DecimalJs } from 'decimal.js';
import { createHash } from 'node:crypto';

/**
 * Exact decimal arithmetic for monetary values and ratios (decimal.js).
 * - Source numbers keep their exact JSON digits (`parseExactJson`).
 * - Computations use an 80-significant-digit context (ROUND_HALF_EVEN), so the PDF's boundary
 *   cases (0.15 vs 1.5 × 0.10) compare exactly; results are rounded only for storage/display.
 * - `numeric` columns are read back as `D` instances (see `common/entities/decimal.transformer.ts`).
 */
export const Decimal = DecimalJs;
export type Decimal = DecimalJs;

/** Calculation context. Use `D` (never the default 20-digit Decimal) for divisions and means. */
export const D = DecimalJs.clone({
  precision: 80,
  rounding: DecimalJs.ROUND_HALF_EVEN,
  toExpNeg: -100,
  toExpPos: 100,
});
export type DValue = InstanceType<typeof D>;

/** Scale of `numeric(65,30)` columns; values are rounded half-even to this before storage. */
export const STORE_DP = 30;
/** `numeric(65,30)` holds 35 integer digits. */
const STORE_LIMIT = new D('1e35');

/** JSON.parse that keeps every number as its exact source text (Node ≥ 21 reviver context). */
export function parseExactJson(text: string): unknown {
  return JSON.parse(text, (_k, v, ctx?: { source?: string }) =>
    typeof v === 'number' && ctx?.source ? ctx.source : v,
  );
}

/** Parse a source value into an exact decimal; returns null with a reason when unusable. */
export function toDecimal(v: unknown): { value: DValue | null; reason: string | null } {
  if (v === null || v === undefined || v === '') return { value: null, reason: 'missing' };
  if (typeof v !== 'string' && typeof v !== 'number') return { value: null, reason: 'not_numeric' };
  if (typeof v === 'number' && !Number.isFinite(v)) return { value: null, reason: 'not_finite' };
  const s = String(v).trim();
  if (!/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return { value: null, reason: 'not_finite' };
  const d = new D(s);
  if (!d.isFinite()) return { value: null, reason: 'not_finite' };
  return { value: d, reason: null };
}

/** Plain (never exponential) decimal string at full calculation precision. */
export function plain(d: DValue | Decimal | null | undefined): string | null {
  return d === null || d === undefined ? null : new D(d.toString()).toFixed();
}

/** Value rounded half-even to the storage scale; null when it cannot be stored in numeric(65,30). */
export function forStorage(d: DValue | null): string | null {
  if (d === null) return null;
  if (d.abs().gte(STORE_LIMIT)) return null;
  return d.toDecimalPlaces(STORE_DP, DecimalJs.ROUND_HALF_EVEN).toFixed();
}

/** Stored decimal / string / number → calculation decimal (null stays null). */
export function dec(v: { toString(): string } | string | number | null | undefined): DValue | null {
  if (v === null || v === undefined) return null;
  return new D(v.toString());
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
