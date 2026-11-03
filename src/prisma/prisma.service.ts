import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { PrismaClient } from "../generated/prisma/client.js";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: cfg.DATABASE_URL }) });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

/** Decimal/number helpers for persistence boundaries. */
export function toNum(v: { toNumber(): number } | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === "number" ? v : v.toNumber();
}
