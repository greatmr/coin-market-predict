import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, In, IsNull } from 'typeorm';

import { insertRows } from '../../common/entities/insert.js';
import { redact } from '../../common/security/redact.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { BENCHMARK_IDS } from '../sources/benchmarks.js';
import { isCmcIdProvider } from '../sources/cmc-id-providers.js';
import { ProviderService } from '../sources/provider.service.js';
import {
  MARKET_DATA_SOURCE,
  type MarketDataSource,
  type ProviderInfo,
  type RawObservation,
  type SourceAsset,
} from '../sources/source.types.js';
import { type BatchStatus, RULES } from '../strategy/index.js';

import { classifyAsset, stricterClass } from './classify.js';
import { type CoverageReport, rankContinuity, trackerEvidence } from './coverage.js';
import { AssetContract } from './entities/asset-contract.entity.js';
import { AssetIdentity } from './entities/asset-identity.entity.js';
import { Asset } from './entities/asset.entity.js';
import { CmcAssetChange } from './entities/cmc-asset-change.entity.js';
import { CmcAsset } from './entities/cmc-asset.entity.js';
import { CrawlBatch } from './entities/crawl-batch.entity.js';
import { DiscoveryRun } from './entities/discovery-run.entity.js';
import { MarketSnapshot } from './entities/market-snapshot.entity.js';
import {
  type SnapshotDraft,
  normalizeContract,
  sanitizeText,
  validateObservation,
} from './validate.js';

export type { CoverageReport } from './coverage.js';

const CHUNK = 1000;

function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** `crawl_batch` columns a re-recorded slot overwrites (identity columns and `started_at` stay). */
const BATCH_UPDATE_COLUMNS = [
  'pipeline_run_id',
  'is_live',
  'finished_at',
  'source_updated_min',
  'source_updated_max',
  'status',
  'status_reasons',
  'listed_total',
  'collected',
  'field_counts',
  'missing_ranks',
  'duplicate_ranks',
  'notes',
];

/**
 * Discovery (identities, contracts, delisting on complete sweeps), hourly collection of one crawl
 * batch, validation, coverage and CMC asset metadata. Writes are idempotent per (provider, asset,
 * slot, quote currency): a replayed slot never duplicates or overwrites an observation.
 */
@Injectable()
export class IngestionService {
  private readonly log = new Logger(IngestionService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(MARKET_DATA_SOURCE) readonly source: MarketDataSource,
    private readonly providers: ProviderService,
  ) {}

  async ensureProvider(info: ProviderInfo = this.source.info) {
    await this.providers.upsert(info);
  }

  private lastDiscovery(providerId: string) {
    return this.db.getRepository(DiscoveryRun).findOne({
      where: { providerId, status: In(['succeeded', 'partial']) },
      order: { startedAt: 'DESC' },
    });
  }

  /** Whether a discovery sweep is due given the configured interval. */
  async discoveryDue(now: Date): Promise<boolean> {
    const last = await this.lastDiscovery(this.source.info.id);
    return (
      !last ||
      now.getTime() - last.startedAt.getTime() >= this.cfg.DISCOVERY_INTERVAL_HOURS * 3_600_000
    );
  }

  async discover(now: Date): Promise<DiscoveryRun> {
    const providerId = this.source.info.id;
    await this.ensureProvider();
    const runs = this.db.getRepository(DiscoveryRun);
    const run = await runs.save(runs.create({ providerId, startedAt: now, status: 'running' }));
    try {
      const result = await this.source.discover();
      const catOf = new Map<string, string[]>();
      for (const [cat, ids] of Object.entries(result.categoryMembers))
        for (const id of ids) catOf.set(id, [...(catOf.get(id) ?? []), cat]);
      const assets = result.assets.map((a) => ({
        ...a,
        categories: [...(a.categories ?? []), ...(catOf.get(a.providerAssetId) ?? [])],
      }));
      const { created } = await this.upsertAssets(providerId, assets, now);

      let delisted = 0;
      if (result.complete) {
        // Only a complete sweep may conclude that an asset is no longer listed.
        const seen = new Set(assets.map((a) => a.providerAssetId));
        const identities = this.db.getRepository(AssetIdentity);
        const active = await identities.find({
          where: { providerId, delistedAt: IsNull() },
          select: { id: true, providerAssetId: true, assetId: true },
        });
        const gone = active.filter((i) => !seen.has(i.providerAssetId));
        for (const c of chunks(gone)) {
          await identities.update({ id: In(c.map((g) => g.id)) }, { delistedAt: now });
          await this.db
            .getRepository(Asset)
            .update({ id: In(c.map((g) => g.assetId)), delistedAt: IsNull() }, { delistedAt: now });
        }
        delisted = gone.length;
      }
      await runs.update(
        { id: run.id },
        {
          finishedAt: new Date(),
          status: result.complete ? 'succeeded' : 'partial',
          pagesFetched: result.pagesFetched,
          assetsSeen: assets.length,
          newAssets: created,
          delistedAssets: delisted,
          sourceTotal: result.sourceTotal,
          coverageComplete: result.complete,
          requestsUsed: result.requestsUsed,
          notes: result.notes,
        },
      );
      return await runs.findOneByOrFail({ id: run.id });
    } catch (err) {
      await runs.update(
        { id: run.id },
        { finishedAt: new Date(), status: 'failed', error: redact(err) },
      );
      throw err;
    }
  }

  /**
   * Resolve provider identities to canonical assets. A new provider id is linked to an existing
   * asset only through an exact chain + contract match — never through the symbol.
   */
  async upsertAssets(
    providerId: string,
    assets: SourceAsset[],
    now: Date,
  ): Promise<{ created: number; idMap: Map<string, string> }> {
    const idMap = new Map<string, string>();
    const bench = BENCHMARK_IDS[providerId];
    let created = 0;
    for (const batch of chunks(assets)) {
      const existing = await this.db.getRepository(AssetIdentity).find({
        where: { providerId, providerAssetId: In(batch.map((a) => a.providerAssetId)) },
        relations: { asset: true },
        select: {
          id: true,
          providerAssetId: true,
          assetId: true,
          asset: { id: true, assetClass: true },
        },
      });
      const known = new Map(existing.map((e) => [e.providerAssetId, e]));
      const fresh = batch.filter((a) => !known.has(a.providerAssetId));

      // Contract matches across providers.
      const contracts = fresh.flatMap((a) =>
        a.platforms.map((p) => ({
          ...normalizeContract(p.chain, p.contractAddress),
          pid: a.providerAssetId,
        })),
      );
      const contractHits = contracts.length
        ? await this.db.getRepository(AssetContract).find({
            where: contracts.map((c) => ({ chain: c.chain, contractAddress: c.contractAddress })),
            select: { id: true, chain: true, contractAddress: true, assetId: true },
          })
        : [];
      const hitMap = new Map(
        contractHits.map((h) => [`${h.chain}|${h.contractAddress}`, h.assetId]),
      );

      const newAssets: Array<Partial<Asset>> = [];
      const newIdentities: Array<Partial<AssetIdentity>> = [];
      const newContracts: Array<Partial<AssetContract>> = [];
      const seenContract = new Set<string>();

      for (const a of fresh) {
        const match = a.platforms
          .map((p) => normalizeContract(p.chain, p.contractAddress))
          .map((c) => hitMap.get(`${c.chain}|${c.contractAddress}`))
          .find(Boolean);
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
            isBenchmark:
              !!bench && (bench.btc === a.providerAssetId || bench.eth === a.providerAssetId),
            firstSeenAt: now,
            lastSeenAt: now,
          });
          created++;
        }
        newIdentities.push({
          id: randomUUID(),
          assetId,
          providerId,
          providerAssetId: a.providerAssetId,
          sourceUrl: a.sourceUrl,
          firstSeenAt: now,
          lastSeenAt: now,
        });
        for (const p of a.platforms) {
          const c = normalizeContract(p.chain, p.contractAddress);
          const key = `${c.chain}|${c.contractAddress}`;
          if (hitMap.has(key) || seenContract.has(key)) continue;
          seenContract.add(key);
          newContracts.push({ assetId, ...c, providerId, decimals: p.decimals ?? null });
        }
        idMap.set(a.providerAssetId, assetId);
      }

      await this.db.transaction(async (m) => {
        await insertRows(m, Asset, newAssets, { ignoreConflicts: true });
        await insertRows(m, AssetIdentity, newIdentities, { ignoreConflicts: true });
        await insertRows(m, AssetContract, newContracts, { ignoreConflicts: true });
        if (known.size)
          await m
            .getRepository(AssetIdentity)
            .update(
              { providerId, providerAssetId: In([...known.keys()]) },
              { lastSeenAt: now, delistedAt: null },
            );
      });

      // Re-classify known assets only when the new evidence is stricter.
      for (const a of batch) {
        const k = known.get(a.providerAssetId);
        if (!k) continue;
        idMap.set(a.providerAssetId, k.assetId);
        const cls = classifyAsset({ name: a.name, symbol: a.symbol, categories: a.categories });
        if (stricterClass(k.asset!.assetClass, cls.assetClass)) {
          await this.db.getRepository(Asset).update(
            { id: k.assetId },
            {
              assetClass: cls.assetClass,
              classSource: cls.classSource,
              underlyingAsset: cls.underlyingAsset,
            },
          );
        }
      }
      const ids = batch.map((a) => idMap.get(a.providerAssetId)!).filter(Boolean);
      if (ids.length)
        await this.db
          .getRepository(Asset)
          .update({ id: In(ids) }, { lastSeenAt: now, delistedAt: null });
    }
    return { created, idMap };
  }

  private async persistDrafts(
    drafts: SnapshotDraft[],
    idMap: Map<string, string>,
    runId: string | null,
  ): Promise<number> {
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
      rank: d.rank,
      dateAdded: d.dateAdded,
      tags: d.tags,
      qualityFlags: d.qualityFlags,
      completeness: d.completeness,
      freshnessSeconds: d.freshnessSeconds,
      isStale: d.isStale,
      nullReasons: d.nullReasons,
      pipelineRunId: runId,
    }));
    // First write wins: a replayed batch never duplicates or overwrites an observation.
    return insertRows(this.db.manager, MarketSnapshot, rows as never, { ignoreConflicts: true });
  }

  /**
   * CMC asset identity keyed by CMC id (PDF p.10). Symbol, name, slug, tags, listing date and
   * contract changes are logged without creating a new asset.
   */
  async syncCmcAssets(
    observations: RawObservation[],
    batchId: string,
    now: Date,
  ): Promise<{ created: number; changed: number }> {
    const providerId = this.source.info.id;
    if (!isCmcIdProvider(providerId)) return { created: 0, changed: 0 };
    const cmcAssets = this.db.getRepository(CmcAsset);
    const rows = observations
      .filter((o) => /^\d{1,10}$/.test(o.providerAssetId))
      .map((o) => ({
        cmcId: Number(o.providerAssetId),
        symbol: sanitizeText(o.symbol, 32).toUpperCase(),
        name: sanitizeText(o.name, 120),
        slug: o.slug ? sanitizeText(o.slug, 120) : null,
        tags: [...new Set((o.tags ?? []).map((t) => sanitizeText(t, 64)).filter(Boolean))],
        dateAdded: o.dateAdded ?? null,
        platformChain: o.platform?.chain ?? null,
        platformAddress: o.platform?.address ?? null,
      }));
    let created = 0;
    let changed = 0;
    for (const batch of chunks(rows, 2000)) {
      const existing = new Map(
        (await cmcAssets.findBy({ providerId, cmcId: In(batch.map((r) => r.cmcId)) })).map((e) => [
          e.cmcId,
          e,
        ]),
      );
      const fresh = batch.filter((r) => !existing.has(r.cmcId));
      if (fresh.length)
        created += await insertRows(
          this.db.manager,
          CmcAsset,
          fresh.map((r) => ({
            providerId,
            ...r,
            firstSeenAt: now,
            lastSeenAt: now,
            lastBatchId: batchId,
          })),
          { ignoreConflicts: true },
        );
      const changes: Array<
        Pick<
          CmcAssetChange,
          'providerId' | 'cmcId' | 'field' | 'oldValue' | 'newValue' | 'batchId' | 'observedAt'
        >
      > = [];
      for (const r of batch) {
        const e = existing.get(r.cmcId);
        if (!e) continue;
        const diff: Array<[string, string | null, string | null]> = [];
        if (e.symbol !== r.symbol) diff.push(['symbol', e.symbol, r.symbol]);
        if (e.name !== r.name) diff.push(['name', e.name, r.name]);
        if ((e.slug ?? null) !== r.slug) diff.push(['slug', e.slug, r.slug]);
        const oldTags = [...e.tags].sort().join(','),
          newTags = [...r.tags].sort().join(',');
        if (oldTags !== newTags) diff.push(['tags', oldTags, newTags]);
        const oldDate = e.dateAdded?.toISOString() ?? null,
          newDate = r.dateAdded?.toISOString() ?? null;
        if (oldDate !== newDate) diff.push(['dateAdded', oldDate, newDate]);
        const oldPlat = e.platformAddress ? `${e.platformChain}:${e.platformAddress}` : null,
          newPlat = r.platformAddress ? `${r.platformChain}:${r.platformAddress}` : null;
        if (oldPlat !== newPlat) diff.push(['platform', oldPlat, newPlat]);
        if (!diff.length) continue;
        changed++;
        changes.push(
          ...diff.map(([field, oldValue, newValue]) => ({
            providerId,
            cmcId: r.cmcId,
            field,
            oldValue,
            newValue,
            batchId,
            observedAt: now,
          })),
        );
        await cmcAssets.update(
          { providerId, cmcId: r.cmcId },
          {
            symbol: r.symbol,
            name: r.name,
            slug: r.slug,
            tags: r.tags,
            dateAdded: r.dateAdded,
            platformChain: r.platformChain,
            platformAddress: r.platformAddress,
          },
        );
      }
      if (changes.length) await insertRows(this.db.manager, CmcAssetChange, changes);
      await cmcAssets.update(
        { providerId, cmcId: In(batch.map((r) => r.cmcId)) },
        { lastSeenAt: now, lastBatchId: batchId },
      );
    }
    return { created, changed };
  }

  /**
   * Crawl-batch record computed from the snapshots actually stored for the slot (PDF p.16), so a
   * replay describes the same data. COMPLETE needs the whole listing and contiguous ranks 1–1200.
   */
  async recordBatch(
    slot: Date,
    runId: string | null,
    startedAt: Date,
    coverage: Pick<CoverageReport, 'label' | 'universeSize' | 'notes'>,
  ): Promise<{ id: string; status: BatchStatus }> {
    const providerId = this.source.info.id;
    const [stats] = (await this.db.query(
      `SELECT count(*)::int AS collected, min(collected_at) AS crawled_at, min(observed_at) AS obs_min, max(observed_at) AS obs_max,
              count(price)::int AS price, count(market_cap)::int AS cap, count(volume_rolling_24h)::int AS vol, count(observed_at)::int AS observed,
              count(rank)::int AS rank, count(date_added)::int AS date_added, count(*) FILTER (WHERE cardinality(tags) > 0)::int AS tags
         FROM market_snapshot WHERE provider_id = $1 AND slot_time = $2`,
      [providerId, slot],
    )) as Array<{
      collected: number;
      crawled_at: Date | null;
      obs_min: Date | null;
      obs_max: Date | null;
      price: number;
      cap: number;
      vol: number;
      observed: number;
      rank: number;
      date_added: number;
      tags: number;
    }>;
    const collected = stats?.collected ?? 0;
    const reasons: string[] = [];
    let missing: number[] = [];
    let duplicates: number[] = [];
    if (coverage.label !== 'complete') reasons.push(`source_listing_${coverage.label}`);
    if (isCmcIdProvider(providerId)) {
      const ranks = (await this.db.query(
        `SELECT rank, count(*)::int AS n FROM market_snapshot WHERE provider_id = $1 AND slot_time = $2 AND rank BETWEEN 1 AND $3 GROUP BY rank`,
        [providerId, slot, RULES.rankMax],
      )) as Array<{ rank: number; n: number }>;
      ({ missing, duplicates } = rankContinuity(ranks));
      if (missing.length) reasons.push(`missing_ranks:${missing.length}`);
      if (duplicates.length) reasons.push(`duplicate_ranks:${duplicates.length}`);
    } else reasons.push('source_ids_are_not_cmc_ids');
    const status: BatchStatus =
      collected === 0 ? 'FAILED' : reasons.length ? 'INCOMPLETE' : 'COMPLETE';
    if (collected === 0) reasons.push('no_observations_stored');
    const data = {
      pipelineRunId: runId,
      isLive: this.source.info.isLive,
      finishedAt: new Date(),
      sourceUpdatedMin: stats?.obs_min ?? null,
      sourceUpdatedMax: stats?.obs_max ?? null,
      status,
      statusReasons: reasons,
      listedTotal: coverage.universeSize,
      collected,
      fieldCounts: {
        price: stats?.price ?? 0,
        marketCap: stats?.cap ?? 0,
        volume24h: stats?.vol ?? 0,
        observedAt: stats?.observed ?? 0,
        rank: stats?.rank ?? 0,
        dateAdded: stats?.date_added ?? 0,
        tags: stats?.tags ?? 0,
      },
      missingRanks: missing,
      duplicateRanks: duplicates,
      notes: coverage.notes.slice(0, 20),
    };
    // The earliest stored crawl time of the slot: stable across replays because snapshots are
    // first-write-wins, and it replaces the attempt time of an earlier FAILED record.
    const crawledAt = stats?.crawled_at ?? startedAt;
    const id = await this.upsertBatch(
      { providerId, slotTime: slot, startedAt, crawledAt, ...data },
      stats?.crawled_at ? [...BATCH_UPDATE_COLUMNS, 'crawled_at'] : BATCH_UPDATE_COLUMNS,
    );
    return { id, status };
  }

  /** Insert the slot's batch or overwrite the given columns of the existing one; returns its id. */
  private async upsertBatch(values: Partial<CrawlBatch>, overwrite: string[]): Promise<string> {
    const r = await this.db
      .createQueryBuilder()
      .insert()
      .into(CrawlBatch)
      .values(values as never)
      .orUpdate(overwrite, ['provider_id', 'slot_time'])
      .updateEntity(false)
      .returning('id')
      .execute();
    return (r.raw as Array<{ id: string }>)[0]!.id;
  }

  /** A failed crawl is a visible gap (PDF p.18); an earlier stored batch for the slot is kept. */
  async recordFailedBatch(
    slot: Date,
    runId: string | null,
    startedAt: Date,
    err: unknown,
  ): Promise<void> {
    const providerId = this.source.info.id;
    // The batch references its provider; a failure can come before anything else was written.
    await this.ensureProvider();
    const existing = await this.db
      .getRepository(CrawlBatch)
      .findOneBy({ providerId, slotTime: slot });
    if (existing && existing.status !== 'FAILED') return;
    const data = {
      pipelineRunId: runId,
      isLive: this.source.info.isLive,
      finishedAt: new Date(),
      status: 'FAILED' as const,
      statusReasons: ['collection_failed'],
      collected: 0,
      fieldCounts: {},
      errors: { message: redact(err).slice(0, 1000) },
    };
    await this.upsertBatch(
      { providerId, slotTime: slot, startedAt, crawledAt: startedAt, ...data },
      [
        'pipeline_run_id',
        'is_live',
        'finished_at',
        'status',
        'status_reasons',
        'collected',
        'field_counts',
        'errors',
      ],
    );
  }

  /** Collect, validate, and persist one hourly slot (one crawl batch). Idempotent per (provider, asset, slot, quote). */
  async collect(slot: Date, runId: string | null, now: Date): Promise<CoverageReport> {
    const providerId = this.source.info.id;
    await this.ensureProvider();
    const result = await this.source.collect({
      slot,
      maxPages: this.cfg.SOURCE_MAX_MARKET_PAGES_PER_RUN,
    });
    const drafts: SnapshotDraft[] = result.observations.map((o) =>
      validateObservation(o, {
        slotTime: slot,
        collectedAt: now,
        staleAfterMinutes: this.cfg.MAX_QUOTE_AGE_MINUTES,
      }),
    );
    // Assets seen during collection but not yet discovered get canonical identities too. Price
    // evidence of wrapped/staked/pegged exposure can only make a classification stricter.
    const evidence = trackerEvidence(providerId, result.observations);
    const { created, idMap } = await this.upsertAssets(
      providerId,
      result.observations.map((o) => ({
        providerAssetId: o.providerAssetId,
        name: o.name,
        symbol: o.symbol,
        sourceUrl: o.sourceUrl,
        platforms: [],
        categories: [...(o.categories ?? []), ...(evidence.get(o.providerAssetId) ?? [])],
      })),
      now,
    );
    const inserted = await this.persistDrafts(drafts, idMap, runId);

    const lastDiscovery = await this.lastDiscovery(providerId);
    // The total reported by this sweep describes the same listing as its observations. The last
    // discovery can be up to DISCOVERY_INTERVAL_HOURS old and the source's active universe drifts
    // by a few coins per hour, so it is only a fallback for sources that report no total.
    const universeSize = result.universeSize ?? lastDiscovery?.sourceTotal ?? null;
    const missingFields: Record<string, number> = {};
    for (const d of drafts)
      for (const k of Object.keys(d.nullReasons)) missingFields[k] = (missingFields[k] ?? 0) + 1;
    const collected = drafts.length;
    const coveragePct = universeSize ? Math.min(100, (collected / universeSize) * 100) : null;
    // "complete" requires the whole listing to have been read AND an observation for every
    // listed asset; anything less is "partial" (or "unknown" when the universe size is unknown).
    const label: CoverageReport['label'] =
      result.complete &&
      (lastDiscovery?.coverageComplete ?? false) &&
      universeSize !== null &&
      collected >= universeSize
        ? 'complete'
        : universeSize
          ? 'partial'
          : 'unknown';
    const notes = [...result.notes];
    if (
      result.universeSize != null &&
      lastDiscovery?.sourceTotal != null &&
      result.universeSize !== lastDiscovery.sourceTotal
    )
      notes.push(
        `source total ${result.universeSize} this slot (last discovery: ${lastDiscovery.sourceTotal})`,
      );
    if (inserted < drafts.length)
      notes.push(
        `${drafts.length - inserted} snapshots already stored for this slot (idempotent re-run)`,
      );
    const batch = await this.recordBatch(slot, runId, now, { label, universeSize, notes });
    await this.syncCmcAssets(result.observations, batch.id, now);
    this.log.log(
      `collected ${collected} observations for ${slot.toISOString()} (${label}${coveragePct !== null ? `, ${coveragePct.toFixed(1)}%` : ''}; batch ${batch.status})`,
    );
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
      batchId: batch.id,
      batchStatus: batch.status,
    };
  }
}
