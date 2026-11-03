import type { TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { slotOf } from "../../src/common/time.js";
import { IngestionService } from "../../src/ingestion/ingestion.service.js";
import type { PrismaService } from "../../src/prisma/prisma.service.js";
import type { CollectOptions, DiscoveryResult, MarketDataSource, SourceAsset } from "../../src/sources/types.js";
import { makeApp, resetDb, testConfig } from "./helpers.js";

let app: TestingModule;
let prisma: PrismaService;

beforeAll(async () => {
  ({ app, prisma } = await makeApp());
});
afterAll(async () => app.close());
beforeEach(async () => resetDb(prisma));

function fakeSource(id: string, listing: SourceAsset[], complete = true): MarketDataSource {
  return {
    info: { id, name: id, accessMethod: "fixture", isLive: false, baseUrl: null, termsUrl: null, attribution: null },
    discover: async (): Promise<DiscoveryResult> => ({ assets: listing, complete, sourceTotal: complete ? listing.length : null, pagesFetched: 1, requestsUsed: 0, categoryMembers: {}, notes: [] }),
    collect: async (_o: CollectOptions) => ({ observations: [], complete, pagesFetched: 1, requestsUsed: 0, universeSize: listing.length, notes: [], quoteCurrency: "USD" }),
  };
}

describe("ingestion against PostgreSQL", () => {
  it("is idempotent per provider, asset, slot and quote currency", async () => {
    const ing = app.get(IngestionService);
    const slot = slotOf(new Date());
    await ing.discover(new Date());
    const first = await ing.collect(slot, null, new Date());
    const n1 = await prisma.marketSnapshot.count();
    const second = await ing.collect(slot, null, new Date());
    expect(await prisma.marketSnapshot.count()).toBe(n1);
    expect(first.collected).toBe(second.collected);
    expect(second.notes.join(" ")).toMatch(/idempotent re-run/);
  });

  it("enforces the uniqueness constraint at the database level", async () => {
    const ing = app.get(IngestionService);
    await ing.discover(new Date());
    const slot = slotOf(new Date());
    await ing.collect(slot, null, new Date());
    const s = await prisma.marketSnapshot.findFirstOrThrow();
    const { id: _id, ...copy } = s;
    await expect(prisma.marketSnapshot.create({ data: { ...copy, nullReasons: copy.nullReasons as never } })).rejects.toThrow(/Unique constraint/i);
  });

  it("keeps same-symbol assets distinct and links providers only by chain + contract", async () => {
    const ing = app.get(IngestionService);
    await ing.discover(new Date());
    const frogs = await prisma.asset.findMany({ where: { symbol: "FROG" } });
    expect(frogs).toHaveLength(2);

    const other = new IngestionService(prisma, testConfig(), fakeSource("other", []));
    await prisma.provider.create({ data: { id: "other", name: "other", accessMethod: "fixture", isLive: false } });
    const { idMap } = await other.upsertAssets(
      "other",
      [
        { providerAssetId: "o-usdt", name: "Tether elsewhere", symbol: "USDT", sourceUrl: "x", platforms: [{ chain: "Ethereum", contractAddress: "0xDAC17F958D2EE523A2206206994597C13D831EC7" }] },
        { providerAssetId: "o-frog", name: "Frog impostor", symbol: "FROG", sourceUrl: "x", platforms: [] },
      ],
      new Date(),
    );
    const tether = await prisma.assetIdentity.findFirstOrThrow({ where: { providerId: "fixture", providerAssetId: "fx-tether" } });
    expect(idMap.get("o-usdt")).toBe(tether.assetId);
    expect(frogs.map((f) => f.id)).not.toContain(idMap.get("o-frog"));
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

  it("refuses synthetic backfill for live sources", async () => {
    const live = fakeSource("live", []);
    (live.info as { isLive: boolean }).isLive = true;
    await prisma.provider.create({ data: { id: "live", name: "live", accessMethod: "official_api", isLive: true } });
    await expect(new IngestionService(prisma, testConfig(), live).collect(slotOf(new Date()), null, new Date(), { fixtureBackfill: true })).rejects.toThrow(/only permitted for the synthetic fixture/);
  });
});
