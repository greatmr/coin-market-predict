import { Module } from "@nestjs/common";
import { slotOf } from "../common/time.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { CoinGeckoSource, COINGECKO_PROVIDER } from "./coingecko/coingecko.adapter.js";
import { CoinMarketCapSource, CMC_PROVIDER } from "./coinmarketcap/coinmarketcap.adapter.js";
import { FixtureSource } from "./fixture/fixture.adapter.js";
import { PoliteHttpClient } from "./http/polite-client.js";
import { PrismaSourceHealthStore } from "./http/prisma-source-health.js";
import { MARKET_DATA_SOURCE, type MarketDataSource } from "./types.js";
import { CmcWebClient } from "./coinmarketcap-web/client.js";
import { CoinMarketCapWebSource } from "./coinmarketcap-web/coinmarketcap-web.adapter.js";
import { CmcWebModule } from "./coinmarketcap-web/web.module.js";

export { PrismaSourceHealthStore } from "./http/prisma-source-health.js";

export const FIXTURE_ANCHOR_KEY = "fixture.anchorSlot";

/** The fixture market is anchored once (first use) so stored synthetic history stays consistent. */
export async function fixtureAnchor(prisma: PrismaService): Promise<Date> {
  const row = await prisma.appState.findUnique({ where: { key: FIXTURE_ANCHOR_KEY } });
  if (row) return new Date(row.value as string);
  const anchor = slotOf(new Date());
  await prisma.appState.upsert({ where: { key: FIXTURE_ANCHOR_KEY }, create: { key: FIXTURE_ANCHOR_KEY, value: anchor.toISOString() }, update: {} });
  const saved = await prisma.appState.findUniqueOrThrow({ where: { key: FIXTURE_ANCHOR_KEY } });
  return new Date(saved.value as string);
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
      return new FixtureSource(() => fixtureAnchor(prisma));
  }
}

@Module({
  imports: [CmcWebModule],
  providers: [{ provide: MARKET_DATA_SOURCE, inject: [APP_CONFIG, PrismaService, CmcWebClient], useFactory: createSource }],
  exports: [MARKET_DATA_SOURCE],
})
export class SourcesModule {}
