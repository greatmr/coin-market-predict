import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { loadConfig, type AppConfig } from "../../src/config/config.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";
import { TELEGRAM_FETCH } from "../../src/telegram/telegram.service.js";

/** Test database URL. Refuses anything whose database name does not contain "test". */
export function testDbUrl(): string {
  try {
    process.loadEnvFile?.(".env");
  } catch {
    // optional
  }
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const base = process.env.DATABASE_URL ?? "postgresql://coins:coins_dev_password@127.0.0.1:5433/coins?schema=public";
    const u = new URL(base);
    u.pathname = "/coins_test";
    url = u.toString();
  }
  const name = new URL(url).pathname.slice(1);
  if (!/test/i.test(name)) throw new Error(`Refusing to run DB tests against non-test database "${name}"`);
  return url;
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: testDbUrl(),
    SCHEDULER_ENABLED: "false",
    TELEGRAM_MODE: "dry_run",
    DATA_SOURCE: "fixture",
    TIER1_EXPORT_DIR: "var/test-exports",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export async function makeApp(overrides: Record<string, string> = {}, fetchImpl?: typeof fetch) {
  const cfg = testConfig(overrides);
  const builder = Test.createTestingModule({ imports: [AppModule.forRoot(cfg, { http: false })] });
  if (fetchImpl) builder.overrideProvider(TELEGRAM_FETCH).useValue(fetchImpl);
  const mod = await builder.compile();
  mod.useLogger(false);
  await mod.init();
  return { app: mod, cfg, prisma: mod.get(PrismaService) };
}

export async function resetDb(prisma: PrismaService) {
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length) await prisma.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}
