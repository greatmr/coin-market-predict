import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC emits decorator metadata, which NestJS dependency injection needs in tests.
const plugins = [swc.vite({ module: { type: "es6" } })];

export default defineConfig({
  test: {
    projects: [
      { plugins, test: { name: "unit", include: ["test/unit/**/*.test.ts"], environment: "node" } },
      {
        plugins,
        test: {
          name: "db",
          include: ["test/db/**/*.test.ts"],
          environment: "node",
          globalSetup: ["test/db/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      { plugins, test: { name: "live", include: ["test/live/**/*.test.ts"], environment: "node", testTimeout: 300_000 } },
    ],
  },
});
