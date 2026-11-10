import { isoDate } from '../../common/utils/dates.js';

import type { DailySourceRow } from '../sources/source.types.js';

/**
 * Parser for the CSV an operator downloads with "Download CSV" on a CoinMarketCap coin's
 * Historical Data page — a manual, explicit source of completed daily rows (same semantics as the
 * website history route: the day's volume and the market cap at that day's close).
 *
 * Tolerant by design (the export is not versioned by CMC): delimiter `;` or `,`, optional quotes,
 * header names matched case/space-insensitively (timeOpen | date, timeClose, open, high, low,
 * close, volume, marketCap | "market cap", timestamp, name); dates as ISO timestamps or
 * "Nov 02, 2026"; numbers may contain `$` and thousands separators. The current (open) UTC day is
 * skipped.
 */

export interface CsvParseResult {
  rows: DailySourceRow[];
  name: string | null;
  skippedIncomplete: number;
  skippedUnparseable: number;
  columns: string[];
}

function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
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
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const norm = (h: string) => h.toLowerCase().replace(/[\s_"*]/g, '');

function parseDate(v: string): Date | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(/T/.test(v) ? v : `${v.slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/.exec(v);
  if (m) {
    const month = [
      'jan',
      'feb',
      'mar',
      'apr',
      'may',
      'jun',
      'jul',
      'aug',
      'sep',
      'oct',
      'nov',
      'dec',
    ].indexOf(m[1]!.toLowerCase());
    if (month >= 0) return new Date(Date.UTC(Number(m[3]), month, Number(m[2])));
  }
  return null;
}

/** A full ISO instant only: a date without a time must never become a time of the High. */
function parseInstant(v: string): Date | null {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? parseDate(v) : null;
}

/** Exact decimal text from a CSV cell, or null (the daily validity rules handle null/negative). */
function cleanNumber(v: string | undefined): string | null {
  if (v === undefined) return null;
  const s = v.replace(/[$\s]/g, '').replace(/,/g, '');
  return /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) ? s : null;
}

export function parseCmcHistoryCsv(text: string, cmcId: number, now: Date): CsvParseResult {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error('CSV is empty');
  const header = lines[0]!;
  const delim = (header.match(/;/g)?.length ?? 0) >= (header.match(/,/g)?.length ?? 0) ? ';' : ',';
  const cols = splitLine(header, delim).map(norm);
  const idx = (...names: string[]) => cols.findIndex((c) => names.includes(c));
  const iOpen = idx('timeopen', 'date');
  const iClose = idx('timeclose');
  const iVol = idx('volume');
  const iCap = idx('marketcap');
  const iTs = idx('timestamp');
  const iName = idx('name');
  const iO = idx('open'),
    iH = idx('high'),
    iL = idx('low'),
    iC = idx('close'),
    iTimeHigh = idx('timehigh'),
    iTimeLow = idx('timelow');
  if (iOpen < 0 || iVol < 0 || iCap < 0) {
    throw new Error(
      `CSV must contain date/timeOpen, volume and marketCap columns; found: ${cols.join(', ')}`,
    );
  }
  const today = isoDate(now);
  const rows = new Map<string, DailySourceRow>();
  let skippedIncomplete = 0;
  let skippedUnparseable = 0;
  let name: string | null = null;
  for (const line of lines.slice(1)) {
    const f = splitLine(line, delim);
    const open = parseDate(f[iOpen] ?? '');
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
    const close = iClose >= 0 ? parseDate(f[iClose] ?? '') : null;
    const ts = iTs >= 0 ? parseDate(f[iTs] ?? '') : null;
    const cell = (i: number) => (i >= 0 ? cleanNumber(f[i]) : null);
    const reasons: string[] = [];
    if (f[iVol] && cell(iVol) === null) reasons.push('volume_not_numeric');
    if (f[iCap] && cell(iCap) === null) reasons.push('market_cap_not_numeric');
    rows.set(dateUtc, {
      cmcId,
      dateUtc,
      volume: cell(iVol),
      marketCap: cell(iCap),
      open: cell(iO),
      high: cell(iH),
      low: cell(iL),
      close: cell(iC),
      timeHigh: iTimeHigh >= 0 ? parseInstant(f[iTimeHigh] ?? '') : null,
      timeLow: iTimeLow >= 0 ? parseInstant(f[iTimeLow] ?? '') : null,
      invalidReasons: reasons,
      periodStart: new Date(`${dateUtc}T00:00:00Z`),
      periodEnd: close ?? new Date(`${dateUtc}T23:59:59.999Z`),
      sourceCloseAt: ts ?? close,
      sourceFields: { line, delimiter: delim },
    });
  }
  return {
    rows: [...rows.values()].sort((a, b) => a.dateUtc.localeCompare(b.dateUtc)),
    name,
    skippedIncomplete,
    skippedUnparseable,
    columns: cols,
  };
}
