import { D, plain } from "../common/decimal.js";
import type { VenuePair } from "./lbank.js";

/**
 * CMC Markets venue concentration for manual review (PDF p.15). Facts only: the source gives no
 * reliable share cutoff, so flags never reject anything and venue_review stays PENDING until a
 * reviewer decides (assumption A10). Wash trading is never diagnosed.
 */

export interface AssetMarketsView {
  id: string;
  status: "COMPLETE" | "INCOMPLETE" | "FAILED";
  finishedAt: Date;
  expectedCount: number | null;
  fetchedCount: number;
  pairs: VenuePair[];
}

export type VenueDataStatus = "AVAILABLE" | "INCOMPLETE" | "STALE" | "MISSING" | "FAILED";

export interface VenueExchangeShare {
  exchange: string;
  name: string;
  pairs: number;
  volumeUsd: string;
  /** Sum of CMC's per-pair volume percentages for this exchange (source values). */
  volumePercent: string | null;
}

export interface VenueSummary {
  crawlId: string | null;
  observedAt: string | null;
  dataStatus: VenueDataStatus;
  flags: string[];
  exchanges: VenueExchangeShare[];
  topExchange: string | null;
  pairsUsed: number;
  pairsSkipped: number;
  expectedCount: number | null;
}

export const UPBIT = "upbit";

export function venueSummary(cmcId: number, crawl: AssetMarketsView | null, asOf: Date, maxAgeMs: number): VenueSummary {
  if (!crawl) return { crawlId: null, observedAt: null, dataStatus: "MISSING", flags: ["VENUE_DATA_PENDING"], exchanges: [], topExchange: null, pairsUsed: 0, pairsSkipped: 0, expectedCount: null };
  const base = { crawlId: crawl.id, observedAt: crawl.finishedAt.toISOString(), expectedCount: crawl.expectedCount };
  if (crawl.status === "FAILED") return { ...base, dataStatus: "FAILED", flags: ["VENUE_DATA_PENDING"], exchanges: [], topExchange: null, pairsUsed: 0, pairsSkipped: 0 };

  const used = crawl.pairs.filter((p) => p.category === "spot" && p.baseCurrencyId === cmcId);
  const byExchange = new Map<string, { name: string; pairs: number; volume: InstanceType<typeof D>; percent: InstanceType<typeof D> | null }>();
  for (const p of used) {
    const e = byExchange.get(p.exchange) ?? { name: p.exchangeName, pairs: 0, volume: new D(0), percent: null };
    e.pairs++;
    if (p.volumeUsd !== null && /^-?[\d.]+(e[-+]?\d+)?$/i.test(p.volumeUsd)) e.volume = e.volume.plus(p.volumeUsd);
    if (p.volumePercent !== null && /^-?[\d.]+(e[-+]?\d+)?$/i.test(p.volumePercent)) e.percent = (e.percent ?? new D(0)).plus(p.volumePercent);
    byExchange.set(p.exchange, e);
  }
  const exchanges = [...byExchange.entries()]
    .map(([exchange, e]) => ({ exchange, name: e.name, pairs: e.pairs, volumeUsd: plain(e.volume)!, volumePercent: plain(e.percent), _v: e.volume }))
    .sort((a, b) => b._v.cmp(a._v) || a.exchange.localeCompare(b.exchange));
  const withVolume = exchanges.filter((e) => e._v.gt(0));
  const top = withVolume[0] ?? null;

  const stale = asOf.getTime() - crawl.finishedAt.getTime() > maxAgeMs;
  const incomplete = crawl.status === "INCOMPLETE" || (crawl.expectedCount !== null && crawl.fetchedCount < crawl.expectedCount);
  const dataStatus: VenueDataStatus = stale ? "STALE" : incomplete ? "INCOMPLETE" : used.length ? "AVAILABLE" : "MISSING";
  const flags: string[] = [];
  if (dataStatus !== "AVAILABLE" && dataStatus !== "INCOMPLETE") flags.push("VENUE_DATA_PENDING");
  if (incomplete) flags.push("VENUE_DATA_INCOMPLETE");
  if (top?.exchange === UPBIT) flags.push("UPBIT_TOP_VENUE");
  if (!incomplete && withVolume.length === 1) flags.push("SINGLE_VENUE");
  return {
    ...base,
    dataStatus,
    flags,
    exchanges: exchanges.map(({ _v, ...e }) => e),
    topExchange: top?.exchange ?? null,
    pairsUsed: used.length,
    pairsSkipped: crawl.pairs.length - used.length,
  };
}
