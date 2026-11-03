import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/config.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { PoliteHttpClient } from "../http/polite-client.js";
import { PrismaSourceHealthStore } from "../http/prisma-source-health.js";
import { CMC_WEB_PROVIDER, CmcWebClient, webResponseStatus } from "./client.js";

export function createWebClient(cfg: AppConfig, prisma: PrismaService): CmcWebClient {
  const store = new PrismaSourceHealthStore(prisma);
  return new CmcWebClient(new PoliteHttpClient({
    providerId: CMC_WEB_PROVIDER.id,
    requestsPerMinute: cfg.CMC_WEB_REQUESTS_PER_MINUTE,
    monthlyBudget: cfg.CMC_WEB_MONTHLY_REQUEST_BUDGET,
    maxAttempts: cfg.CMC_WEB_MAX_RETRIES + 1,
    headers: { accept: "application/json, text/html;q=0.9, */*;q=0.8", origin: "https://coinmarketcap.com", referer: "https://coinmarketcap.com/", platform: "web" },
    responseStatus: webResponseStatus,
    store: {
      load: (id) => store.load(id),
      save: async (id, health) => {
        await prisma.provider.upsert({ where: { id }, create: { ...CMC_WEB_PROVIDER }, update: {} });
        await store.save(id, health);
      },
    },
  }), cfg.CMC_WEB_CACHE_SECONDS * 1000);
}

@Module({ providers: [{ provide: CmcWebClient, inject: [APP_CONFIG, PrismaService], useFactory: createWebClient }], exports: [CmcWebClient] })
export class CmcWebModule {}
