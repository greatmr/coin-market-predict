import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC emits decorator metadata (NestJS DI, TypeORM entities) and follows tsconfig's
// useDefineForClassFields=false, so unset entity columns are never own properties.
const plugins = [swc.vite({ module: { type: "es6" } })];

export default defineConfig({
  test: {
    projects: [
      // Unit tests sit next to the code (`src/**/*.spec.ts`): pure logic, no database, no network.
      { plugins, test: { name: "unit", include: ["src/**/*.spec.ts"], environment: "node" } },
      {
        plugins,
        test: {
          // Integration tests against a real PostgreSQL (`coins_test`), migrated by the global setup.
          name: "e2e",
          include: ["test/**/*.e2e-spec.ts"],
          environment: "node",
          globalSetup: ["test/utils/e2e-global-setup.ts"],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      // Opt-in checks against the real providers (RUN_LIVE_CMC_WEB=1 / RUN_LIVE_SOURCE=1).
      { plugins, test: { name: "live", include: ["test/live/**/*.live-spec.ts"], environment: "node", testTimeout: 300_000 } },
    ],
  },
});
