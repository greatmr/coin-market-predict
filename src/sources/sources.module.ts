import { Module } from "@nestjs/common";
import { isoDate } from "../common/dates.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { CoinGeckoSource, COINGECKO_PROVIDER } from "./coingecko/coingecko.adapter.js";
import { CoinMarketCapSource, CMC_PROVIDER } from "./coinmarketcap/coinmarketcap.adapter.js";
import { FixtureCmcMarket } from "./fixture/fixture-cmc.js";
import { FixtureSource, FixtureTier1Source } from "./fixture/fixture.adapter.js";
import { PoliteHttpClient } from "./http/polite-client.js";
import { PrismaSourceHealthStore } from "./http/prisma-source-health.js";
import { MARKET_DATA_SOURCE, type MarketDataSource, TIER1_SOURCE, type Tier1Source } from "./types.js";
import { CmcWebClient } from "./coinmarketcap-web/client.js";
import { CmcWebTier1Source, CoinMarketCapWebSource } from "./coinmarketcap-web/coinmarketcap-web.adapter.js";
import { CmcWebModule } from "./coinmarketcap-web/web.module.js";

export { PrismaSourceHealthStore } from "./http/prisma-source-health.js";

export const FIXTURE_ANCHOR_KEY = "fixture.tier1AnchorDate";

/** The synthetic market is anchored once (first use) so its designed cases and history stay consistent. */
export async function fixtureAnchorDate(prisma: PrismaService, now: () => Date = () => new Date()): Promise<string> {
  const row = await prisma.appState.findUnique({ where: { key: FIXTURE_ANCHOR_KEY } });
  if (row) return String(row.value);
  await prisma.appState.upsert({ where: { key: FIXTURE_ANCHOR_KEY }, create: { key: FIXTURE_ANCHOR_KEY, value: isoDate(now()) }, update: {} });
  return String((await prisma.appState.findUniqueOrThrow({ where: { key: FIXTURE_ANCHOR_KEY } })).value);
}

function fixtureMarket(prisma: PrismaService) {
  let cached: { date: string; market: FixtureCmcMarket } | null = null;
  return async () => {
    const date = await fixtureAnchorDate(prisma);
    if (cached?.date !== date) cached = { date, market: new FixtureCmcMarket(date) };
    return cached.market;
  };
}

export function createSource(cfg: AppConfig, prisma: PrismaService, web?: CmcWebClient): MarketDataSource {
  const ensureProvider = async (info: typeof CMC_PROVIDER) =>
    prisma.provider.upsert({ where: { id: info.id }, create: { ...info }, update: {} });
  const client = (info: typeof CMC_PROVIDER, headers: Record<string, string>) => {
    const store = new PrismaSourceHealthStore(prisma);
    return new PoliteHttpClient({
      providerId: info.id,
      requestsPerMinute: cfg.SOURCE_REQUESTS_PER_MINUTE,
      monthlyBudget: cfg.SOURCE_MONTHLY_REQUEST_BUDGET,
      headers,
      store: {
        load: (id) => store.load(id),
        save: async (id, s) => {
          await ensureProvider(info);
          await store.save(id, s);
        },
      },
    });
  };
  switch (cfg.DATA_SOURCE) {
    case "coinmarketcap_web":
      if (!web) throw new Error("CMC website client is not available");
      return new CoinMarketCapWebSource(web, cfg.SOURCE_MAX_MARKET_PAGES_PER_RUN, cfg.CMC_WEB_LISTING_PAGE_SIZE);
    case "coinmarketcap":
      return new CoinMarketCapSource(client(CMC_PROVIDER, { "X-CMC_PRO_API_KEY": cfg.CMC_API_KEY! }));
    case "coingecko":
      return new CoinGeckoSource(client(COINGECKO_PROVIDER, { "x-cg-demo-api-key": cfg.COINGECKO_API_KEY! }));
    default:
      return new FixtureSource(fixtureMarket(prisma));
  }
}

/**
 * Tier 1 inputs beyond the listing. Only the CMC website collector (and the synthetic fixture)
 * can supply daily rows, LBank pairs and CMC Markets venue rows; other sources get null and the
 * dependent outputs are N/A / PENDING with a reason.
 */
export function createTier1Source(cfg: AppConfig, prisma: PrismaService, web?: CmcWebClient): Tier1Source | null {
  if (cfg.DATA_SOURCE === "coinmarketcap_web") return web ? new CmcWebTier1Source(web) : null;
  if (cfg.DATA_SOURCE === "fixture") return new FixtureTier1Source(fixtureMarket(prisma));
  return null;
}

@Module({
  imports: [CmcWebModule],
  providers: [
    { provide: MARKET_DATA_SOURCE, inject: [APP_CONFIG, PrismaService, CmcWebClient], useFactory: createSource },
    { provide: TIER1_SOURCE, inject: [APP_CONFIG, PrismaService, CmcWebClient], useFactory: createTier1Source },
  ],
  exports: [MARKET_DATA_SOURCE, TIER1_SOURCE],
})
export class SourcesModule {}
