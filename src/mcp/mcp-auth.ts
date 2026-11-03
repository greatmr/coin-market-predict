import { createHash, timingSafeEqual } from "node:crypto";
import type { ToolScope } from "./tool-def.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

function same(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Resolve the scope granted by an Authorization header. Write token implies read.
 * Returns null when the token is missing or unknown.
 */
export function resolveScope(authHeader: string | undefined, tokens: { read?: string; write?: string }): ToolScope | null {
  const m = /^Bearer\s+(.+)$/i.exec(authHeader ?? "");
  if (!m) return null;
  const presented = m[1]!.trim();
  if (tokens.write && same(presented, tokens.write)) return "write";
  if (tokens.read && same(presented, tokens.read)) return "read";
  return null;
}
