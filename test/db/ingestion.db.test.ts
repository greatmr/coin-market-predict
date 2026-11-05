import type { TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { slotOf } from "../../src/common/time.js";
import { IngestionService } from "../../src/ingestion/ingestion.service.js";
import type { PrismaService } from "../../src/prisma/prisma.service.js";
import type { CollectOptions, DiscoveryResult, MarketDataSource, RawObservation, SourceAsset } from "../../src/sources/types.js";
import { makeApp, resetDb, testConfig } from "./helpers.js";

let app: TestingModule;
let prisma: PrismaService;

beforeAll(async () => {
  ({ app, prisma } = await makeApp());
});
afterAll(async () => app.close());
beforeEach(async () => resetDb(prisma));

function fakeSource(id: string, listing: SourceAsset[], complete = true, observations: RawObservation[] = []): MarketDataSource {
  return {
    info: { id, name: id, accessMethod: "fixture", isLive: false, baseUrl: null, termsUrl: null, attribution: null },
    discover: async (): Promise<DiscoveryResult> => ({ assets: listing, complete, sourceTotal: complete ? listing.length : null, pagesFetched: 1, requestsUsed: 0, categoryMembers: {}, notes: [] }),
    collect: async (_o: CollectOptions) => ({ observations, complete, pagesFetched: 1, requestsUsed: 0, universeSize: listing.length, notes: [], quoteCurrency: "USD" }),
  };
}

const obs = (id: string, symbol: string, extra: Partial<RawObservation> = {}): RawObservation => ({
  providerAssetId: id, name: `${symbol} coin`, symbol, sourceUrl: "x", observedAt: new Date(), price: 1, marketCap: 50_000_000, fullyDilutedValuation: null, circulatingSupply: 50_000_000, volume24h: 1_000_000, rank: 500, dateAdded: new Date("2024-01-01T00:00:00Z"), tags: ["defi"], slug: symbol.toLowerCase(), ...extra,
});

describe("ingestion against PostgreSQL", () => {
  it("is idempotent per provider, asset, slot and quote currency (first write wins)", async () => {
    const ing = app.get(IngestionService);
    const slot = slotOf(new Date());
    await ing.discover(new Date());
    const first = await ing.collect(slot, null, new Date());
    const n1 = await prisma.marketSnapshot.count();
    const second = await ing.collect(slot, null, new Date(Date.now() + 60_000));
    expect(await prisma.marketSnapshot.count()).toBe(n1);
    expect(second.batchId).toBe(first.batchId);
    expect(second.notes.join(" ")).toMatch(/idempotent re-run/);
    const batch = await prisma.crawlBatch.findUniqueOrThrow({ where: { id: first.batchId } });
    expect(batch.crawledAt.getTime()).toBeLessThan(Date.now());
    expect((batch.fieldCounts as Record<string, number>).rank).toBe(1300);
  });

  it("enforces the uniqueness constraint at the database level", async () => {
    const ing = app.get(IngestionService);
    await ing.discover(new Date());
    await ing.collect(slotOf(new Date()), null, new Date());
    const s = await prisma.marketSnapshot.findFirstOrThrow();
    const { id: _id, ...copy } = s;
    await expect(prisma.marketSnapshot.create({ data: { ...copy, nullReasons: copy.nullReasons as never } })).rejects.toThrow(/Unique constraint/i);
  });

  it("stores rank, listing date and raw tags with each observation (gaps G1–G3)", async () => {
    const ing = app.get(IngestionService);
    await ing.discover(new Date());
    await ing.collect(slotOf(new Date()), null, new Date());
    const s = await prisma.marketSnapshot.findFirstOrThrow({ where: { providerAssetId: "990011" } });
    expect(s.rank).toBe(190);
    expect(s.tags).toEqual(["stablecoin", "usd-stablecoin"]);
    expect(s.dateAdded).toBeInstanceOf(Date);
    const unranked = await prisma.marketSnapshot.findFirstOrThrow({ where: { providerAssetId: "990021" } });
    expect(unranked.rank).toBeNull();
    expect((unranked.nullReasons as Record<string, string>).rank).toMatch(/not reported/);
  });

  it("keeps same-symbol assets distinct by CMC id and links providers only by chain + contract", async () => {
    const ing = app.get(IngestionService);
    await ing.discover(new Date());
    await ing.collect(slotOf(new Date()), null, new Date());
    expect(await prisma.cmcAsset.count({ where: { symbol: "TWIN" } })).toBe(2);
    const twins = await prisma.asset.findMany({ where: { symbol: "TWIN" } });
    expect(twins).toHaveLength(2);
    const other = new IngestionService(prisma, testConfig(), fakeSource("other", []));
    await prisma.provider.create({ data: { id: "other", name: "other", accessMethod: "fixture", isLive: false } });
    const { idMap } = await other.upsertAssets("other", [{ providerAssetId: "o-twin", name: "Twin impostor", symbol: "TWIN", sourceUrl: "x", platforms: [] }], new Date());
    // A ticker match never links identities: the impostor becomes a third, separate asset.
    expect(twins.map((t) => t.id)).not.toContain(idMap.get("o-twin"));
    expect(await prisma.asset.count({ where: { symbol: "TWIN" } })).toBe(3);
  });

  it("tracks a CMC symbol change without creating a new asset (p.10)", async () => {
    await prisma.provider.create({ data: { id: "fixture", name: "f", accessMethod: "fixture", isLive: false } });
    const listing = [{ providerAssetId: "424242", name: "Old Name", symbol: "OLD", sourceUrl: "x", platforms: [] }];
    const before = new IngestionService(prisma, testConfig(), fakeSource("fixture", listing, true, [obs("424242", "OLD")]));
    await before.collect(slotOf(new Date()), null, new Date());
    const after = new IngestionService(prisma, testConfig(), fakeSource("fixture", listing, true, [obs("424242", "NEW", { name: "OLD coin", slug: "old", tags: ["defi", "ai"] })]));
    await after.collect(new Date(slotOf(new Date()).getTime() + 3_600_000), null, new Date());
    expect(await prisma.cmcAsset.count({ where: { cmcId: 424242 } })).toBe(1);
    expect((await prisma.cmcAsset.findFirstOrThrow({ where: { cmcId: 424242 } })).symbol).toBe("NEW");
    const changes = await prisma.cmcAssetChange.findMany({ where: { cmcId: 424242 }, orderBy: { field: "asc" } });
    expect(changes.map((c) => [c.field, c.oldValue, c.newValue])).toEqual([["symbol", "OLD", "NEW"], ["tags", "defi", "ai,defi"]]);
  });

  it("marks a batch INCOMPLETE when ranks 1–1200 are not contiguous or the listing is partial (p.18)", async () => {
    await prisma.provider.create({ data: { id: "fixture", name: "f", accessMethod: "fixture", isLive: false } });
    const ing = new IngestionService(prisma, testConfig(), fakeSource("fixture", [], false, [obs("1", "AAA", { rank: 1 }), obs("2", "BBB", { rank: 1 })]));
    const r = await ing.collect(slotOf(new Date()), null, new Date());
    const b = await prisma.crawlBatch.findUniqueOrThrow({ where: { id: r.batchId } });
    expect(b.status).toBe("INCOMPLETE");
    expect(b.missingRanks).toHaveLength(1199);
    expect(b.duplicateRanks).toEqual([1]);
    expect(b.statusReasons).toEqual(expect.arrayContaining(["missing_ranks:1199", "duplicate_ranks:1"]));
  });

  it("marks assets delisted only after a complete discovery sweep", async () => {
    await prisma.provider.create({ data: { id: "fake", name: "fake", accessMethod: "fixture", isLive: false } });
    const listing: SourceAsset[] = [
      { providerAssetId: "a", name: "A", symbol: "A", sourceUrl: "x", platforms: [] },
      { providerAssetId: "b", name: "B", symbol: "B", sourceUrl: "x", platforms: [] },
    ];
    await new IngestionService(prisma, testConfig(), fakeSource("fake", listing)).discover(new Date());
    await new IngestionService(prisma, testConfig(), fakeSource("fake", [listing[0]!], false)).discover(new Date());
    expect(await prisma.assetIdentity.count({ where: { providerId: "fake", delistedAt: { not: null } } })).toBe(0);
    await new IngestionService(prisma, testConfig(), fakeSource("fake", [listing[0]!], true)).discover(new Date());
    expect(await prisma.assetIdentity.findFirstOrThrow({ where: { providerId: "fake", providerAssetId: "b" } })).toMatchObject({ delistedAt: expect.any(Date) });
  });

  it("records a failed crawl as a visible gap without replacing an earlier batch", async () => {
    const ing = app.get(IngestionService);
    const slot = slotOf(new Date());
    await ing.recordFailedBatch(slot, null, new Date(), new Error("listing timed out"));
    expect(await prisma.crawlBatch.findFirstOrThrow()).toMatchObject({ status: "FAILED", collected: 0 });
    await ing.discover(new Date());
    const ok = await ing.collect(slot, null, new Date());
    expect((await prisma.crawlBatch.findUniqueOrThrow({ where: { id: ok.batchId } })).status).toBe("COMPLETE");
    await ing.recordFailedBatch(slot, null, new Date(), new Error("later failure"));
    expect((await prisma.crawlBatch.findUniqueOrThrow({ where: { id: ok.batchId } })).status).toBe("COMPLETE");
  });
});
