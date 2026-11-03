import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { redact } from "../config/redact.js";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { BENCHMARK_IDS } from "../sources/benchmarks.js";
import type { MarketDataSource, ProviderInfo, SourceAsset } from "../sources/types.js";
import { MARKET_DATA_SOURCE } from "../sources/types.js";
import { classifyAsset, stricterClass } from "./classify.js";
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
  notes: string[];
}

const CHUNK = 1000;

function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
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
    // Assets seen during collection but not yet discovered get canonical identities too.
    const { created, idMap } = await this.upsertAssets(
      providerId,
      result.observations.map((o) => ({ providerAssetId: o.providerAssetId, name: o.name, symbol: o.symbol, sourceUrl: o.sourceUrl, platforms: [], categories: o.categories })),
      now,
    );

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
    if (inserted < rows.length) notes.push(`${rows.length - inserted} snapshots already stored for this slot (idempotent re-run)`);
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
      notes,
    };
  }
}
