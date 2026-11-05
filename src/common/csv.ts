export type Cell = string | number | boolean | null | undefined;

/** RFC 4180 field: quoted when it contains a delimiter, quote or line break; null/undefined → empty. */
export function csvField(v: Cell): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 CSV (no BOM, CRLF line endings) with a header row. */
export function toCsv(header: string[], rows: Cell[][]): string {
  return [header, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}
