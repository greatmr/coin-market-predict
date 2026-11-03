/** Convert Prisma results (Decimal, BigInt, Date) into plain JSON-safe values. */
export function plain<T = unknown>(v: unknown): T {
  return convert(v) as T;
}

function convert(v: unknown): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(convert);
  if (typeof v === "object") {
    const o = v as Record<string, unknown> & { toNumber?: () => number; d?: unknown; s?: unknown; e?: unknown };
    if (typeof o.toNumber === "function" && "d" in o && "e" in o) return o.toNumber();
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = convert(val);
    return out;
  }
  return v;
}
