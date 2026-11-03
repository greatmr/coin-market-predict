import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { redact } from "../config/redact.js";
import type { Prisma } from "../generated/prisma/client.js";
import { STATISTICAL_WARMUP_SNAPSHOTS } from "../features/registry.js";
import { PrismaService, toNum } from "../prisma/prisma.service.js";
import { wantsHistory } from "../screening/universe.js";
import { BENCHMARK_IDS, REFERENCE_IDS } from "../sources/benchmarks.js";
import { CMC_WEB_PROVIDER } from "../sources/coinmarketcap-web/client.js";
import type { MarketDataSource, ProviderInfo, RawObservation, SourceAsset } from "../sources/types.js";
import { MARKET_DATA_SOURCE } from "../sources/types.js";
import { classifyAsset, stricterClass, trackedExposure } from "./classify.js";
import { addHours, HOUR_MS } from "../common/time.js";
import { alignToHourlySlots, MAX_CONSECUTIVE_HISTORY_FAILURES, slotOffsetMs, stopsBackfill } from "./history.js";
import { normalizeContract, sanitizeText, validateObservation, type SnapshotDraft } from "./validate.js";

export interface CoverageReport {
  providerId: string;
  isLive: boolean;
  /** Listing size reported by the latest discovery (null = unknown). */
  universeSize: number | null;
  universeComplete: boolean;
  collected: number;
  sourceListingComplete: boolean;
  coveragePct: number | null;
  /** "complete" only when the whole listing was collected; otherwise "partial" or "unknown". */
  label: "complete" | "partial" | "unknown";
  stale: number;
  missingFields: Record<string, number>;
  newAssetsDuringCollection: number;
  /** Listing pages read for this slot (0 when a just-fetched discovery listing was reused). */
  pagesFetched: number;
  requestsUsed: number;
  notes: string[];
}

/** Hours of genuine history fetched per coin: the deepest feature look-back (vol24_zscore_72h). */
export const HISTORY_BACKFILL_HOURS = STATISTICAL_WARMUP_SNAPSHOTS - 1;

export interface HistoryBackfillReport {
  /** `running` only in progress updates written while the stage is still fetching. */
  status: "not_supported" | "disabled" | "not_needed" | "running" | "completed" | "partial";
  /** Coins that would be eligible now if they had history, plus fresh BTC/ETH benchmarks. */
  candidates: number;
  /** Candidates missing one of the previous (SNAPSHOT_WINDOW − 1) hourly snapshots. */
  needed: number;
  attempted: number;
  /** Coins that received at least one genuine historical sample in this run. */
  backfilled: number;
  /** Samples stored; hours that already had an observation are never overwritten. */
  inserted: number;
  failed: number;
  /** Candidates still missing the required previous hours after this run. */
  remaining: number;
  stoppedBy: "time_budget" | "max_assets" | "request_budget_reserve" | "source_unavailable" | null;
  hours: number;
  notes: string[];
}

const CHUNK = 1000;

function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Price-based classification evidence for one slot's observations (see `trackedExposure`). */
export function trackerEvidence(providerId: string, observations: RawObservation[]): Map<string, string[]> {
  const ids = REFERENCE_IDS[providerId] ?? {};
  const refIds = new Set(Object.values(ids));
  const byId = new Map(observations.map((o) => [o.providerAssetId, o]));
  const refs = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, (id && byId.get(id)?.price) ?? null]));
  const out = new Map<string, string[]>();
  for (const o of observations) {
    if (refIds.has(o.providerAssetId)) continue;
    const c = trackedExposure({ name: o.name, symbol: o.symbol, price: o.price, changePct24h: o.changePct24h, changePct7d: o.changePct7d }, refs);
    if (c) out.set(o.providerAssetId, [c]);
  }
  return out;
}

@Injectable()
export class IngestionService {
  private readonly log = new Logger(IngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(MARKET_DATA_SOURCE) readonly source: MarketDataSource,
  ) {}

  async ensureProvider(info: ProviderInfo = this.source.info) {
    await this.prisma.provider.upsert({
      where: { id: info.id },
      create: { ...info },
      update: { name: info.name, accessMethod: info.accessMethod, isLive: info.isLive, baseUrl: info.baseUrl, termsUrl: info.termsUrl, attribution: info.attribution },
    });
  }

  /** Whether a discovery sweep is due given the configured interval. */
  async discoveryDue(now: Date): Promise<boolean> {
    const last = await this.prisma.discoveryRun.findFirst({
      where: { providerId: this.source.info.id, status: { in: ["succeeded", "partial"] } },
      orderBy: { startedAt: "desc" },
    });
    return !last || now.getTime() - last.startedAt.getTime() >= this.cfg.DISCOVERY_INTERVAL_HOURS * 3_600_000;
  }

  async discover(now: Date) {
    const providerId = this.source.info.id;
    await this.ensureProvider();
    const run = await this.prisma.discoveryRun.create({ data: { providerId, startedAt: now, status: "running" } });
    try {
      const result = await this.source.discover();
      const catOf = new Map<string, string[]>();
      for (const [cat, ids] of Object.entries(result.categoryMembers)) for (const id of ids) catOf.set(id, [...(catOf.get(id) ?? []), cat]);
      const assets = result.assets.map((a) => ({ ...a, categories: [...(a.categories ?? []), ...(catOf.get(a.providerAssetId) ?? [])] }));
      const { created } = await this.upsertAssets(providerId, assets, now);

      let delisted = 0;
      if (result.complete) {
        // Only a complete sweep may conclude that an asset is no longer listed.
        const seen = new Set(assets.map((a) => a.providerAssetId));
        const active = await this.prisma.assetIdentity.findMany({ where: { providerId, delistedAt: null }, select: { id: true, providerAssetId: true, assetId: true } });
        const gone = active.filter((i) => !seen.has(i.providerAssetId));
        for (const c of chunks(gone)) {
          await this.prisma.assetIdentity.updateMany({ where: { id: { in: c.map((g) => g.id) } }, data: { delistedAt: now } });
          await this.prisma.asset.updateMany({ where: { id: { in: c.map((g) => g.assetId) }, delistedAt: null }, data: { delistedAt: now } });
        }
        delisted = gone.length;
      }
      return await this.prisma.discoveryRun.update({
        where: { id: run.id },
        data: {
          finishedAt: new Date(),
          status: result.complete ? "succeeded" : "partial",
          pagesFetched: result.pagesFetched,
          assetsSeen: assets.length,
          newAssets: created,
          delistedAssets: delisted,
          sourceTotal: result.sourceTotal,
          coverageComplete: result.complete,
          requestsUsed: result.requestsUsed,
          notes: result.notes,
        },
      });
    } catch (err) {
      await this.prisma.discoveryRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), status: "failed", error: redact(err) } });
      throw err;
    }
  }

  /**
   * Resolve provider identities to canonical assets. A new provider id is linked to an existing
   * asset only through an exact chain + contract match — never through the symbol.
   */
  async upsertAssets(providerId: string, assets: SourceAsset[], now: Date): Promise<{ created: number; idMap: Map<string, string> }> {
    const idMap = new Map<string, string>();
    const bench = BENCHMARK_IDS[providerId];
    let created = 0;
    for (const batch of chunks(assets)) {
      const existing = await this.prisma.assetIdentity.findMany({
        where: { providerId, providerAssetId: { in: batch.map((a) => a.providerAssetId) } },
        select: { providerAssetId: true, assetId: true, asset: { select: { assetClass: true } } },
      });
      const known = new Map(existing.map((e) => [e.providerAssetId, e]));
      const fresh = batch.filter((a) => !known.has(a.providerAssetId));

      // Contract matches across providers.
      const contracts = fresh.flatMap((a) => a.platforms.map((p) => ({ ...normalizeContract(p.chain, p.contractAddress), pid: a.providerAssetId })));
      const contractHits = contracts.length
        ? await this.prisma.assetContract.findMany({
            where: { OR: contracts.map((c) => ({ chain: c.chain, contractAddress: c.contractAddress })) },
            select: { chain: true, contractAddress: true, assetId: true },
          })
        : [];
      const hitMap = new Map(contractHits.map((h) => [`${h.chain}|${h.contractAddress}`, h.assetId]));

      const newAssets: Prisma.AssetCreateManyInput[] = [];
      const newIdentities: Array<{ id: string; assetId: string; providerId: string; providerAssetId: string; sourceUrl: string; firstSeenAt: Date; lastSeenAt: Date }> = [];
      const newContracts: Array<{ assetId: string; chain: string; contractAddress: string; providerId: string; decimals: number | null }> = [];
      const seenContract = new Set<string>();

      for (const a of fresh) {
        const match = a.platforms.map((p) => normalizeContract(p.chain, p.contractAddress)).map((c) => hitMap.get(`${c.chain}|${c.contractAddress}`)).find(Boolean);
        const assetId = match ?? randomUUID();
        if (!match) {
          const cls = classifyAsset({ name: a.name, symbol: a.symbol, categories: a.categories });
          newAssets.push({
            id: assetId,
            name: sanitizeText(a.name, 120),
            symbol: sanitizeText(a.symbol, 32).toUpperCase(),
            assetClass: cls.assetClass,
            classSource: cls.classSource,
            underlyingAsset: cls.underlyingAsset,
            isBenchmark: !!bench && (bench.btc === a.providerAssetId || bench.eth === a.providerAssetId),
            firstSeenAt: now,
            lastSeenAt: now,
          });
          created++;
        }
        newIdentities.push({ id: randomUUID(), assetId, providerId, providerAssetId: a.providerAssetId, sourceUrl: a.sourceUrl, firstSeenAt: now, lastSeenAt: now });
        for (const p of a.platforms) {
          const c = normalizeContract(p.chain, p.contractAddress);
          const key = `${c.chain}|${c.contractAddress}`;
          if (hitMap.has(key) || seenContract.has(key)) continue;
          seenContract.add(key);
          newContracts.push({ assetId, ...c, providerId, decimals: p.decimals ?? null });
        }
        idMap.set(a.providerAssetId, assetId);
      }

      await this.prisma.$transaction([
        this.prisma.asset.createMany({ data: newAssets, skipDuplicates: true }),
        this.prisma.assetIdentity.createMany({ data: newIdentities, skipDuplicates: true }),
        this.prisma.assetContract.createMany({ data: newContracts, skipDuplicates: true }),
        this.prisma.assetIdentity.updateMany({
          where: { providerId, providerAssetId: { in: [...known.keys()] } },
          data: { lastSeenAt: now, delistedAt: null },
        }),
      ]);

      // Re-classify known assets only when the new evidence is stricter.
      for (const a of batch) {
        const k = known.get(a.providerAssetId);
        if (!k) continue;
        idMap.set(a.providerAssetId, k.assetId);
        const cls = classifyAsset({ name: a.name, symbol: a.symbol, categories: a.categories });
        if (stricterClass(k.asset.assetClass, cls.assetClass)) {
          await this.prisma.asset.update({ where: { id: k.assetId }, data: { assetClass: cls.assetClass, classSource: cls.classSource, underlyingAsset: cls.underlyingAsset } });
        }
      }
      const ids = batch.map((a) => idMap.get(a.providerAssetId)!).filter(Boolean);
      await this.prisma.asset.updateMany({ where: { id: { in: ids } }, data: { lastSeenAt: now, delistedAt: null } });
    }
    return { created, idMap };
  }

  private async persistDrafts(drafts: SnapshotDraft[], idMap: Map<string, string>, runId: string | null): Promise<number> {
    const providerId = this.source.info.id;
    const rows = drafts.map((d) => ({
      assetId: idMap.get(d.providerAssetId)!,
      providerId,
      providerAssetId: d.providerAssetId,
      slotTime: d.slotTime,
      collectedAt: d.collectedAt,
      observedAt: d.observedAt,
      sourceUrl: d.sourceUrl,
      quoteCurrency: d.quoteCurrency,
      price: d.price,
      marketCap: d.marketCap,
      marketCapProvenance: d.marketCapProvenance,
      fullyDilutedValuation: d.fullyDilutedValuation,
      circulatingSupply: d.circulatingSupply,
      supplyProvenance: d.supplyProvenance,
      volumeRolling24h: d.volumeRolling24h,
      volumeHourly: d.volumeHourly,
      volumeHourlySource: d.volumeHourlySource,
      providerChangePct1h: d.providerChangePct1h,
      providerChangePct24h: d.providerChangePct24h,
      providerChangePct7d: d.providerChangePct7d,
      bidAskSpreadPct: d.bidAskSpreadPct,
      depthPlus2PctUsd: d.depthPlus2PctUsd,
      depthMinus2PctUsd: d.depthMinus2PctUsd,
      liquiditySource: d.liquiditySource,
      qualityFlags: d.qualityFlags,
      completeness: d.completeness,
      freshnessSeconds: d.freshnessSeconds,
      isStale: d.isStale,
      nullReasons: d.nullReasons,
      pipelineRunId: runId,
    }));
    let inserted = 0;
    for (const c of chunks(rows)) inserted += (await this.prisma.marketSnapshot.createMany({ data: c, skipDuplicates: true })).count;

    return inserted;
  }

  /**
   * Fetch genuine hourly history (one chart request per coin) for every coin that would be
   * eligible now but lacks the previous (SNAPSHOT_WINDOW − 1) consecutive hourly snapshots:
   * the first run, newly qualifying coins, and gaps after downtime. Benchmarks come first, then
   * monitored VMC ids, then the most liquid coins. Bounded per run by coin count, wall-clock time
   * and a reserve of the monthly request budget that hourly listings still need; whatever is left
   * continues next run while every coin also accumulates its own hourly snapshots.
   * Existing observations are never overwritten and missing hours are never filled.
   */
  async backfillHistory(
    slot: Date,
    runId: string,
    collectedAt: Date,
    opts: { listingRequestsPerRun?: number; onProgress?: (r: HistoryBackfillReport) => Promise<void> } = {},
  ): Promise<HistoryBackfillReport> {
    const providerId = this.source.info.id;
    const report: HistoryBackfillReport = { status: "not_needed", candidates: 0, needed: 0, attempted: 0, backfilled: 0, inserted: 0, failed: 0, remaining: 0, stoppedBy: null, hours: HISTORY_BACKFILL_HOURS, notes: [] };
    if (!this.source.history) return { ...report, status: "not_supported" };
    const limit = this.cfg.SOURCE_HISTORY_BOOTSTRAP_MAX_ASSETS;
    if (!limit) return { ...report, status: "disabled", notes: ["history backfill disabled (SOURCE_HISTORY_BOOTSTRAP_MAX_ASSETS=0); coins warm up from hourly collection"] };

    const floors = { minMarketCapUsd: this.cfg.MIN_MARKET_CAP_USD, minVolume24hUsd: this.cfg.MIN_VOLUME_24H_USD };
    const current = await this.prisma.marketSnapshot.findMany({
      where: { providerId, slotTime: slot },
      select: { assetId: true, providerAssetId: true, sourceUrl: true, observedAt: true, price: true, marketCap: true, volumeRolling24h: true, isStale: true, asset: { select: { name: true, symbol: true, assetClass: true, isBenchmark: true } } },
    });
    const candidates = current.filter((s) => wantsHistory(s.asset, { price: toNum(s.price), marketCap: toNum(s.marketCap), volumeRolling24h: toNum(s.volumeRolling24h), isStale: s.isStale }, floors));
    report.candidates = candidates.length;

    const prior = this.cfg.SNAPSHOT_WINDOW - 1;
    const missing = async (ids: string[]) => {
      const have = new Map<string, number>();
      for (const c of chunks(ids, 5000)) {
        const rows = await this.prisma.marketSnapshot.groupBy({
          by: ["assetId"],
          where: { providerId, assetId: { in: c }, slotTime: { gte: addHours(slot, -prior), lt: slot }, isStale: false, price: { gt: 0 } },
          _count: { _all: true },
        });
        for (const r of rows) have.set(r.assetId, r._count._all);
      }
      return new Set(ids.filter((id) => (have.get(id) ?? 0) < prior));
    };
    const needs = await missing(candidates.map((c) => c.assetId));
    const vmc = new Set(this.cfg.VMC_ASSET_IDS.map(String));
    const tier = (s: (typeof candidates)[number]) => (s.asset.isBenchmark ? 0 : vmc.has(s.providerAssetId) ? 1 : 2);
    const todo = candidates
      .filter((c) => needs.has(c.assetId))
      .sort((a, b) => tier(a) - tier(b) || (toNum(b.volumeRolling24h) ?? 0) - (toNum(a.volumeRolling24h) ?? 0) || a.providerAssetId.localeCompare(b.providerAssetId));
    report.needed = todo.length;
    if (!todo.length) return report;

    const perRun = Math.max(1, opts.listingRequestsPerRun ?? 1) + 1;
    const monthly = providerId === CMC_WEB_PROVIDER.id ? this.cfg.CMC_WEB_MONTHLY_REQUEST_BUDGET : this.cfg.SOURCE_MONTHLY_REQUEST_BUDGET;
    const spendable = async () => {
      const h = await this.prisma.sourceHealth.findUnique({ where: { providerId } });
      const now = new Date();
      const period = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
      const used = h?.budgetPeriodStart?.getTime() === period ? h.budgetUsed : 0;
      const hoursLeft = Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime()) / HOUR_MS);
      return monthly - used - hoursLeft * perRun;
    };
    const deadline = Date.now() + this.cfg.SOURCE_HISTORY_BOOTSTRAP_MAX_MINUTES * 60_000;
    let allowance = await spendable();
    let consecutiveFailures = 0;

    for (const s of todo) {
      if (report.attempted >= limit) { report.stoppedBy = "max_assets"; break; }
      if (Date.now() >= deadline) { report.stoppedBy = "time_budget"; break; }
      if (report.attempted > 0 && report.attempted % 25 === 0) allowance = await spendable();
      if (allowance <= 0) { report.stoppedBy = "request_budget_reserve"; break; }
      report.attempted++;
      allowance--;
      try {
        const asset: SourceAsset = { providerAssetId: s.providerAssetId, name: s.asset.name, symbol: s.asset.symbol, sourceUrl: s.sourceUrl, platforms: [] };
        const samples = await this.source.history(asset, addHours(slot, -HISTORY_BACKFILL_HOURS), new Date(slot.getTime() - 1));
        const drafts = alignToHourlySlots(samples, slot, HISTORY_BACKFILL_HOURS, slotOffsetMs(slot, s.observedAt)).flatMap(({ slotTime, raw }) => {
          // Freshness is judged at that hour's end; the row still records the actual retrieval time.
          const d = validateObservation(raw, { slotTime, collectedAt: new Date(slotTime.getTime() + HOUR_MS - 1), staleAfterMinutes: this.cfg.STALE_AFTER_MINUTES });
          if (d.price === null || d.marketCap === null || d.volumeRolling24h === null) return [];
          d.collectedAt = collectedAt;
          d.freshnessSeconds = Math.round((collectedAt.getTime() - raw.observedAt!.getTime()) / 1000);
          d.qualityFlags.push("historical_backfill");
          return [d];
        });
        const n = await this.persistDrafts(drafts, new Map([[s.providerAssetId, s.assetId]]), runId);
        report.inserted += n;
        if (n) report.backfilled++;
        consecutiveFailures = 0;
      } catch (err) {
        if (stopsBackfill(err)) {
          report.stoppedBy = "source_unavailable";
          report.notes.push(`history backfill stopped at ${s.asset.symbol}: ${redact(err).slice(0, 180)}`);
          break; // The source is refusing or failing: the collected current snapshots stay valid.
        }
        report.failed++;
        if (report.failed <= 5) report.notes.push(`no usable history for ${s.asset.symbol}: ${redact(err).slice(0, 140)}`);
        if (++consecutiveFailures >= MAX_CONSECUTIVE_HISTORY_FAILURES) {
          report.stoppedBy = "source_unavailable";
          report.notes.push(`history backfill paused after ${consecutiveFailures} consecutive failed coins`);
          break;
        }
      }
      if (opts.onProgress && report.attempted % 10 === 0) await opts.onProgress({ ...report, status: "running", remaining: report.needed - report.attempted }).catch(() => undefined);
    }
    if (report.failed > 5) report.notes.push(`${report.failed - 5} more coins returned no usable history`);
    report.remaining = (await missing(todo.map((t) => t.assetId))).size;
    report.status = report.remaining === 0 ? "completed" : "partial";
    const summary =
      `history backfill: ${report.backfilled}/${report.needed} coins received genuine hourly samples (${report.inserted} rows, up to ${HISTORY_BACKFILL_HOURS}h each)` +
      (report.remaining ? `; ${report.remaining} still need history and continue next run or warm up from hourly collection` : "");
    report.notes.push(summary);
    if (report.stoppedBy) report.notes.push(`backfill stopped early: ${report.stoppedBy.replace(/_/g, " ")}`);
    this.log.log(summary);
    return report;
  }

  /** Collect, validate, and persist one hourly slot. Idempotent per (provider, asset, slot, quote). */
  async collect(slot: Date, runId: string | null, now: Date, opts: { fixtureBackfill?: boolean } = {}): Promise<CoverageReport> {
    const providerId = this.source.info.id;
    await this.ensureProvider();
    if (opts.fixtureBackfill && this.source.info.isLive) throw new Error("backfill is only permitted for the synthetic fixture source");
    const result = await this.source.collect({ slot, maxPages: this.cfg.SOURCE_MAX_MARKET_PAGES_PER_RUN });
    // Synthetic history is "collected" at the slot it represents and flagged as backfill.
    const collectedAt = opts.fixtureBackfill ? new Date(slot.getTime() + 5 * 60_000) : now;

    const drafts: SnapshotDraft[] = result.observations.map((o) => {
      const d = validateObservation(o, { slotTime: slot, collectedAt, staleAfterMinutes: this.cfg.STALE_AFTER_MINUTES });
      if (opts.fixtureBackfill) d.qualityFlags.push("fixture_backfill");
      return d;
    });
    // Assets seen during collection but not yet discovered get canonical identities too. Price
    // evidence of wrapped/staked/pegged exposure can only make a classification stricter.
    const evidence = trackerEvidence(providerId, result.observations);
    const { created, idMap } = await this.upsertAssets(
      providerId,
      result.observations.map((o) => ({ providerAssetId: o.providerAssetId, name: o.name, symbol: o.symbol, sourceUrl: o.sourceUrl, platforms: [], categories: [...(o.categories ?? []), ...(evidence.get(o.providerAssetId) ?? [])] })),
      now,
    );

    const inserted = await this.persistDrafts(drafts, idMap, runId);

    const lastDiscovery = await this.prisma.discoveryRun.findFirst({
      where: { providerId, status: { in: ["succeeded", "partial"] } },
      orderBy: { startedAt: "desc" },
    });
    const universeSize = lastDiscovery?.sourceTotal ?? result.universeSize ?? null;
    const missingFields: Record<string, number> = {};
    for (const d of drafts) for (const k of Object.keys(d.nullReasons)) missingFields[k] = (missingFields[k] ?? 0) + 1;
    const collected = drafts.length;
    const coveragePct = universeSize ? Math.min(100, (collected / universeSize) * 100) : null;
    // "complete" requires the whole listing to have been read AND an observation for every
    // listed asset; anything less is "partial" (or "unknown" when the universe size is unknown).
    const label: CoverageReport["label"] =
      result.complete && (lastDiscovery?.coverageComplete ?? false) && universeSize !== null && collected >= universeSize
        ? "complete"
        : universeSize
          ? "partial"
          : "unknown";
    const notes = [...result.notes];
    if (inserted < drafts.length) notes.push(`${drafts.length - inserted} snapshots already stored for this slot (idempotent re-run)`);
    this.log.log(`collected ${collected} observations for ${slot.toISOString()} (${label}${coveragePct !== null ? `, ${coveragePct.toFixed(1)}%` : ""})`);
    return {
      providerId,
      isLive: this.source.info.isLive,
      universeSize,
      universeComplete: lastDiscovery?.coverageComplete ?? false,
      collected,
      sourceListingComplete: result.complete,
      coveragePct,
      label,
      stale: drafts.filter((d) => d.isStale).length,
      missingFields,
      newAssetsDuringCollection: created,
      pagesFetched: result.pagesFetched,
      requestsUsed: result.requestsUsed,
      notes,
    };
  }
}
