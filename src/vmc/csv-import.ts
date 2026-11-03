import type { DailyRow } from "./cmc-parse.js";
import { validatePair } from "./cmc-parse.js";
import { type IsoDate, isoDate } from "./window.js";

/**
 * Parser for the CSV a user downloads with "Download CSV" on a CoinMarketCap coin's
 * Historical Data page (PDF p.4) — a manual export, not automated crawling.
 *
 * Tolerant by design (the export format is not versioned by CMC):
 *  - delimiter `;` or `,`, optional quotes;
 *  - header names matched case/space-insensitively: timeOpen | date, timeClose, volume,
 *    marketCap | "market cap", timestamp, name;
 *  - dates as ISO timestamps or "Nov 02, 2026"; numbers may contain `$` and thousands `,`.
 * Semantics follow the website table = daily OHLCV: volume traded during the UTC day and the
 * market cap for that day. Rows for the current (incomplete) UTC day are skipped.
 */

export interface CsvParseResult {
  rows: DailyRow[];
  name: string | null;
  skippedIncomplete: number;
  skippedUnparseable: number;
  columns: string[];
}

function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === delim && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const norm = (h: string) => h.toLowerCase().replace(/[\s_"*]/g, "");

function parseDate(v: string): Date | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(/T/.test(v) ? v : `${v.slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/.exec(v);
  if (m) {
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[1]!.toLowerCase());
    if (month >= 0) return new Date(Date.UTC(Number(m[3]), month, Number(m[2])));
  }
  return null;
}

const cleanNumber = (v: string | undefined) => (v === undefined ? undefined : v.replace(/[$\s]/g, "").replace(/,/g, ""));

export function parseCmcHistoryCsv(text: string, cmcId: number, now: Date): CsvParseResult {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("CSV is empty");
  const header = lines[0]!;
  const delim = (header.match(/;/g)?.length ?? 0) >= (header.match(/,/g)?.length ?? 0) ? ";" : ",";
  const cols = splitLine(header, delim).map(norm);
  const idx = (...names: string[]) => cols.findIndex((c) => names.includes(c));
  const iOpen = idx("timeopen", "date");
  const iClose = idx("timeclose");
  const iVol = idx("volume");
  const iCap = idx("marketcap");
  const iTs = idx("timestamp");
  const iName = idx("name");
  if (iOpen < 0 || iVol < 0 || iCap < 0) {
    throw new Error(`CSV must contain date/timeOpen, volume and marketCap columns; found: ${cols.join(", ")}`);
  }
  const today: IsoDate = isoDate(now);
  const rows = new Map<IsoDate, DailyRow>();
  let skippedIncomplete = 0;
  let skippedUnparseable = 0;
  let name: string | null = null;
  for (const line of lines.slice(1)) {
    const f = splitLine(line, delim);
    const open = parseDate(f[iOpen] ?? "");
    if (!open) {
      skippedUnparseable++;
      continue;
    }
    const dateUtc = isoDate(open);
    if (dateUtc >= today) {
      skippedIncomplete++;
      continue;
    }
    if (iName >= 0 && !name) name = f[iName] || null;
    const close = iClose >= 0 ? parseDate(f[iClose] ?? "") : null;
    const ts = iTs >= 0 ? parseDate(f[iTs] ?? "") : null;
    const pair = validatePair(cleanNumber(f[iVol]) || null, cleanNumber(f[iCap]) || null);
    rows.set(dateUtc, {
      cmcId,
      dateUtc,
      sourceTimestamp: ts ?? close,
      periodStart: new Date(`${dateUtc}T00:00:00Z`),
      periodEnd: close ?? new Date(`${dateUtc}T23:59:59.999Z`),
      ...pair,
      sourceFields: { line, delimiter: delim },
    });
  }
  return { rows: [...rows.values()].sort((a, b) => a.dateUtc.localeCompare(b.dateUtc)), name, skippedIncomplete, skippedUnparseable, columns: cols };
}
