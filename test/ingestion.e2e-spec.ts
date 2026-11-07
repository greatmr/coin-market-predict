import type { TestingModule } from '@nestjs/testing';
import { type DataSource, IsNull, Not } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { slotOf } from '../src/common/utils/time.js';
import { AssetIdentity } from '../src/modules/ingestion/entities/asset-identity.entity.js';
import { Asset } from '../src/modules/ingestion/entities/asset.entity.js';
import { CmcAssetChange } from '../src/modules/ingestion/entities/cmc-asset-change.entity.js';
import { CmcAsset } from '../src/modules/ingestion/entities/cmc-asset.entity.js';
import { CrawlBatch } from '../src/modules/ingestion/entities/crawl-batch.entity.js';
import { MarketSnapshot } from '../src/modules/ingestion/entities/market-snapshot.entity.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';
import { Provider } from '../src/modules/sources/entities/provider.entity.js';
import { ProviderService } from '../src/modules/sources/provider.service.js';
import type {
  CollectOptions,
  DiscoveryResult,
  MarketDataSource,
  RawObservation,
  SourceAsset,
} from '../src/modules/sources/source.types.js';

import { makeApp, resetDb, testConfig } from './utils/helpers.js';

let app: TestingModule;
let db: DataSource;

beforeAll(async () => {
  ({ app, db } = await makeApp());
});
afterAll(async () => app.close());
beforeEach(async () => resetDb(db));

const snapshots = () => db.getRepository(MarketSnapshot);
const batches = () => db.getRepository(CrawlBatch);
const ingestion = (source: MarketDataSource) =>
  new IngestionService(db, testConfig(), source, app.get(ProviderService));
const createProvider = (id: string) =>
  db.getRepository(Provider).insert({ id, name: id, accessMethod: 'fixture', isLive: false });

function fakeSource(
  id: string,
  listing: SourceAsset[],
  complete = true,
  observations: RawObservation[] = [],
): MarketDataSource {
  return {
    info: {
      id,
      name: id,
      accessMethod: 'fixture',
      isLive: false,
      baseUrl: null,
      termsUrl: null,
      attribution: null,
    },
    discover: async (): Promise<DiscoveryResult> => ({
      assets: listing,
      complete,
      sourceTotal: complete ? listing.length : null,
      pagesFetched: 1,
      requestsUsed: 0,
      categoryMembers: {},
      notes: [],
    }),
    collect: async (_o: CollectOptions) => ({
      observations,
      complete,
      pagesFetched: 1,
      requestsUsed: 0,
      universeSize: listing.length,
      notes: [],
      quoteCurrency: 'USD',
    }),
  };
}

const obs = (id: string, symbol: string, extra: Partial<RawObservation> = {}): RawObservation => ({
  providerAssetId: id,
  name: `${symbol} coin`,
  symbol,
  sourceUrl: 'x',
  observedAt: new Date(),
  price: 1,
  marketCap: 50_000_000,
  fullyDilutedValuation: null,
  circulatingSupply: 50_000_000,
  volume24h: 1_000_000,
  rank: 500,
  dateAdded: new Date('2024-01-01T00:00:00Z'),
  tags: ['defi'],
  slug: symbol.toLowerCase(),
  ...extra,
});

describe('ingestion against PostgreSQL', () => {
  it('is idempotent per provider, asset, slot and quote currency (first write wins)', async () => {
    const ing = app.get(IngestionService);
    const slot = slotOf(new Date());
    await ing.discover(new Date());
    const first = await ing.collect(slot, null, new Date());
    const n1 = await snapshots().count();
    const second = await ing.collect(slot, null, new Date(Date.now() + 60_000));
    expect(await snapshots().count()).toBe(n1);
    expect(second.batchId).toBe(first.batchId);
    expect(second.notes.join(' ')).toMatch(/idempotent re-run/);
    const batch = await batches().findOneByOrFail({ id: first.batchId });
    expect(batch.crawledAt.getTime()).toBeLessThan(Date.now());
    expect(batch.fieldCounts.rank).toBe(1300);
  });

  it('enforces the uniqueness constraint at the database level', async () => {
    const ing = app.get(IngestionService);
    await ing.discover(new Date());
    await ing.collect(slotOf(new Date()), null, new Date());
    const [s] = await snapshots().find({ take: 1 });
    const { id: _id, ...copy } = s!;
    await expect(snapshots().insert(copy as never)).rejects.toThrow(
      /unique constraint "ux_market_snapshot_observation"/,
    );
  });

  it('stores rank, listing date and raw tags with each observation (gaps G1–G3)', async () => {
    const ing = app.get(IngestionService);
    await ing.discover(new Date());
    await ing.collect(slotOf(new Date()), null, new Date());
    const s = await snapshots().findOneByOrFail({ providerAssetId: '990011' });
    expect(s.rank).toBe(190);
    expect(s.tags).toEqual(['stablecoin', 'usd-stablecoin']);
    expect(s.dateAdded).toBeInstanceOf(Date);
    const unranked = await snapshots().findOneByOrFail({ providerAssetId: '990021' });
    expect(unranked.rank).toBeNull();
    expect(unranked.nullReasons.rank).toMatch(/not reported/);
  });

  it('keeps same-symbol assets distinct by CMC id and links providers only by chain + contract', async () => {
    const ing = app.get(IngestionService);
    await ing.discover(new Date());
    await ing.collect(slotOf(new Date()), null, new Date());
    expect(await db.getRepository(CmcAsset).countBy({ symbol: 'TWIN' })).toBe(2);
    const twins = await db.getRepository(Asset).findBy({ symbol: 'TWIN' });
    expect(twins).toHaveLength(2);
    const other = ingestion(fakeSource('other', []));
    await createProvider('other');
    const { idMap } = await other.upsertAssets(
      'other',
      [
        {
          providerAssetId: 'o-twin',
          name: 'Twin impostor',
          symbol: 'TWIN',
          sourceUrl: 'x',
          platforms: [],
        },
      ],
      new Date(),
    );
    // A ticker match never links identities: the impostor becomes a third, separate asset.
    expect(twins.map((t) => t.id)).not.toContain(idMap.get('o-twin'));
    expect(await db.getRepository(Asset).countBy({ symbol: 'TWIN' })).toBe(3);
  });

  it('tracks a CMC symbol change without creating a new asset (p.10)', async () => {
    await createProvider('fixture');
    const listing = [
      { providerAssetId: '424242', name: 'Old Name', symbol: 'OLD', sourceUrl: 'x', platforms: [] },
    ];
    const before = ingestion(fakeSource('fixture', listing, true, [obs('424242', 'OLD')]));
    await before.collect(slotOf(new Date()), null, new Date());
    const after = ingestion(
      fakeSource('fixture', listing, true, [
        obs('424242', 'NEW', { name: 'OLD coin', slug: 'old', tags: ['defi', 'ai'] }),
      ]),
    );
    await after.collect(new Date(slotOf(new Date()).getTime() + 3_600_000), null, new Date());
    expect(await db.getRepository(CmcAsset).countBy({ cmcId: 424242 })).toBe(1);
    expect((await db.getRepository(CmcAsset).findOneByOrFail({ cmcId: 424242 })).symbol).toBe(
      'NEW',
    );
    const changes = await db
      .getRepository(CmcAssetChange)
      .find({ where: { cmcId: 424242 }, order: { field: 'ASC' } });
    expect(changes.map((c) => [c.field, c.oldValue, c.newValue])).toEqual([
      ['symbol', 'OLD', 'NEW'],
      ['tags', 'defi', 'ai,defi'],
    ]);
  });

  it('marks a batch INCOMPLETE when ranks 1–1200 are not contiguous or the listing is partial (p.18)', async () => {
    await createProvider('fixture');
    const ing = ingestion(
      fakeSource('fixture', [], false, [
        obs('1', 'AAA', { rank: 1 }),
        obs('2', 'BBB', { rank: 1 }),
      ]),
    );
    const r = await ing.collect(slotOf(new Date()), null, new Date());
    const b = await batches().findOneByOrFail({ id: r.batchId });
    expect(b.status).toBe('INCOMPLETE');
    expect(b.missingRanks).toHaveLength(1199);
    expect(b.duplicateRanks).toEqual([1]);
    expect(b.statusReasons).toEqual(
      expect.arrayContaining(['missing_ranks:1199', 'duplicate_ranks:1']),
    );
  });

  it("judges listing coverage against the slot's own source total, not an older discovery total", async () => {
    await createProvider('fake');
    const asset = (id: string): SourceAsset => ({
      providerAssetId: id,
      name: id,
      symbol: id,
      sourceUrl: 'x',
      platforms: [],
    });
    await ingestion(fakeSource('fake', [asset('1'), asset('2'), asset('3')])).discover(new Date());
    // One coin left the source's active listing after discovery; the sweep read the whole listing.
    const shrunk = ingestion(
      fakeSource('fake', [asset('1'), asset('2')], true, [obs('1', 'AAA'), obs('2', 'BBB')]),
    );
    const r = await shrunk.collect(slotOf(new Date()), null, new Date());
    expect(r.label).toBe('complete');
    expect(r.universeSize).toBe(2);
    expect(r.notes.join(' ')).toMatch(/source total 2 this slot \(last discovery: 3\)/);
    const b = await batches().findOneByOrFail({ id: r.batchId });
    expect(b.listedTotal).toBe(2);
    expect(b.statusReasons).not.toContain('source_listing_partial');
    // Fewer observations than the slot's own total stays partial.
    const short = ingestion(fakeSource('fake', [asset('1'), asset('2')], true, [obs('1', 'AAA')]));
    expect(
      (await short.collect(slotOf(new Date(Date.now() + 3_600_000)), null, new Date())).label,
    ).toBe('partial');
  });

  it('marks assets delisted only after a complete discovery sweep', async () => {
    await createProvider('fake');
    const listing: SourceAsset[] = [
      { providerAssetId: 'a', name: 'A', symbol: 'A', sourceUrl: 'x', platforms: [] },
      { providerAssetId: 'b', name: 'B', symbol: 'B', sourceUrl: 'x', platforms: [] },
    ];
    await ingestion(fakeSource('fake', listing)).discover(new Date());
    await ingestion(fakeSource('fake', [listing[0]!], false)).discover(new Date());
    expect(
      await db
        .getRepository(AssetIdentity)
        .countBy({ providerId: 'fake', delistedAt: Not(IsNull()) }),
    ).toBe(0);
    await ingestion(fakeSource('fake', [listing[0]!], true)).discover(new Date());
    expect(
      await db
        .getRepository(AssetIdentity)
        .findOneByOrFail({ providerId: 'fake', providerAssetId: 'b' }),
    ).toMatchObject({ delistedAt: expect.any(Date) });
  });

  it('records a failed crawl as a visible gap without replacing an earlier batch', async () => {
    const ing = app.get(IngestionService);
    const slot = slotOf(new Date());
    await ing.recordFailedBatch(slot, null, new Date(), new Error('listing timed out'));
    expect((await batches().find())[0]).toMatchObject({ status: 'FAILED', collected: 0 });
    await ing.discover(new Date());
    const ok = await ing.collect(slot, null, new Date());
    expect((await batches().findOneByOrFail({ id: ok.batchId })).status).toBe('COMPLETE');
    await ing.recordFailedBatch(slot, null, new Date(), new Error('later failure'));
    expect((await batches().findOneByOrFail({ id: ok.batchId })).status).toBe('COMPLETE');
  });
});
