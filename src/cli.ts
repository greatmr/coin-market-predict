import { NestFactory } from "@nestjs/core";
import { AGENT_RUNNER, type AgentRunner } from "./agents/runner.js";
import { AppModule } from "./app.module.js";
import { loadConfigOrExit, RedactingLogger } from "./bootstrap.js";
import { addHours, slotOf } from "./common/time.js";
import { describeConfig } from "./config/config.js";
import { redact } from "./config/redact.js";
import { BacktestService } from "./evaluation/backtest.service.js";
import { IngestionService } from "./ingestion/ingestion.service.js";
import { PipelineService } from "./pipeline/pipeline.service.js";
import { PrismaService } from "./prisma/prisma.service.js";
import { ReadModelService } from "./read-model/read-model.service.js";
import { formatReport } from "./telegram/format.js";
import { ReportService } from "./telegram/report.service.js";
import { TelegramService } from "./telegram/telegram.service.js";
import { VmcService } from "./vmc/vmc.service.js";

const HELP = `Coins Predicts CLI

  config:check                 Validate configuration (secrets shown only as set/not set)
  run-once [--slot ISO] [--force] [--kind manual]
                               Run the hourly pipeline for the current (or given) slot.
                               --kind manual creates a separate run row (e.g. to compare agents)
  discover                     Run universe discovery now
  seed-fixtures [--hours N]    Insert N hours of SYNTHETIC fixture history (fixture source only)
  telegram:preview [--fake]    Print the Telegram report for the latest run (or a fake-data preview)
  telegram:test                Verify bot token + chat and send one test message
  telegram:deliver             Send pending live Telegram deliveries
  backtest [--final-test] [--min-history H]
                               Walk-forward backtest on stored history
  source:reset                 Clear a suspended/open circuit breaker after you resolved the cause
  agent:check                  Show agent runner availability (no model call)

Volume / Market Cap baseline (docs/volume-mcap.md; needs VMC_ASSET_IDS):
  vmc:probe                    Verify CMC key plan + endpoint access (~3 credits live)
  vmc:sync-assets              Resolve configured CMC ids via /v1/cryptocurrency/map (0 credits)
  vmc:daily [--full]           Backfill/refresh completed daily history
  vmc:baseline                 Recalculate six-month baselines from stored daily rows
  vmc:weekly                   vmc:daily then vmc:baseline (scheduled weekly)
  vmc:hourly-backfill [--force] One-time backfill of the last 72 hourly quotes
  vmc:hourly                   Collect current quotes for this hour
  vmc:run-all                  sync-assets, weekly, hourly-backfill, hourly
  vmc:compare [--format table|json] [--out file]   Print/write the comparison
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "help" || cmd === "--help") {
    process.stdout.write(HELP);
    return;
  }
  const cfg = loadConfigOrExit({ ...process.env, SCHEDULER_ENABLED: "false" });
  if (cmd === "config:check") {
    process.stdout.write(`${JSON.stringify(describeConfig(cfg), null, 2)}\n`);
    if (process.env.ANTHROPIC_API_KEY) process.stdout.write("note: ANTHROPIC_API_KEY is set in this shell but is NOT passed to agents (subscription token only).\n");
    return;
  }
  if (cmd === "telegram:preview" && process.argv.includes("--fake")) {
    process.stdout.write(`${fakePreview(cfg.DISPLAY_TIMEZONE).join("\n\n----- next message -----\n\n")}\n`);
    return;
  }

  const ctx = await NestFactory.createApplicationContext(AppModule.forRoot(cfg, { http: false }), { logger: new RedactingLogger() });
  try {
    switch (cmd) {
      case "run-once": {
        const slot = arg("--slot") ? new Date(arg("--slot")!) : undefined;
        const r = await ctx.get(PipelineService).runSlot(slot, { force: process.argv.includes("--force"), kind: arg("--kind") ?? "hourly" });
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        if (r.status === "failed") process.exitCode = 1;
        break;
      }
      case "discover": {
        const r = await ctx.get(IngestionService).discover(new Date());
        process.stdout.write(`${JSON.stringify({ status: r.status, assetsSeen: r.assetsSeen, newAssets: r.newAssets, complete: r.coverageComplete, sourceTotal: r.sourceTotal }, null, 2)}\n`);
        break;
      }
      case "seed-fixtures": {
        if (cfg.DATA_SOURCE !== "fixture") throw new Error("seed-fixtures only works with DATA_SOURCE=fixture (never invents live data)");
        const hours = Number(arg("--hours") ?? "72");
        const ing = ctx.get(IngestionService);
        await ing.discover(new Date());
        const current = slotOf(new Date());
        let n = 0;
        for (let h = hours; h >= 1; h--) {
          const r = await ing.collect(addHours(current, -h), null, new Date(), { fixtureBackfill: true });
          n += r.collected;
        }
        process.stdout.write(`seeded ${hours} hours of SYNTHETIC fixture history (${n} snapshots, flagged fixture_backfill)\n`);
        break;
      }
      case "telegram:preview": {
        const runId = await ctx.get(ReadModelService).latestRunId();
        if (!runId) throw new Error("no completed run yet; run `npm run cli -- run-once` first, or use --fake");
        const parts = await ctx.get(ReportService).build(runId, "preview", null);
        process.stdout.write(`${parts.join("\n\n----- next message -----\n\n")}\n`);
        break;
      }
      case "vmc:probe":
      case "vmc:sync-assets":
      case "vmc:daily":
      case "vmc:baseline":
      case "vmc:weekly":
      case "vmc:hourly-backfill":
      case "vmc:hourly":
      case "vmc:run-all": {
        const vmc = ctx.get(VmcService);
        if (vmc.assetIds.length === 0 && cmd !== "vmc:probe") throw new Error("VMC_ASSET_IDS is empty: configure explicit CoinMarketCap ids (e.g. VMC_ASSET_IDS=1,1027,2)");
        const steps: Array<() => Promise<unknown>> =
          cmd === "vmc:probe" ? [() => vmc.probe()]
          : cmd === "vmc:sync-assets" ? [() => vmc.syncAssets()]
          : cmd === "vmc:daily" ? [() => vmc.dailyHistory({ full: process.argv.includes("--full") })]
          : cmd === "vmc:baseline" ? [() => vmc.baseline()]
          : cmd === "vmc:weekly" ? [() => vmc.weekly()]
          : cmd === "vmc:hourly-backfill" ? [() => vmc.hourlyBackfill({ force: process.argv.includes("--force") })]
          : cmd === "vmc:hourly" ? [() => vmc.hourly()]
          : [() => vmc.syncAssets(), () => vmc.weekly(), () => vmc.hourlyBackfill(), () => vmc.hourly()];
        const results = [];
        for (const s of steps) results.push(await s());
        process.stdout.write(`${JSON.stringify(results.flat(), null, 2)}\n`);
        if (results.flat().some((r) => (r as { status?: string }).status === "failed")) process.exitCode = 1;
        break;
      }
      case "vmc:compare": {
        const fmt = (arg("--format") as "table" | "json" | undefined) ?? cfg.VMC_OUTPUT_FORMAT;
        process.stdout.write(`${await ctx.get(VmcService).writeComparison(fmt, arg("--out") ?? cfg.VMC_OUTPUT_FILE)}\n`);
        break;
      }
      case "telegram:test": {
        const tg = ctx.get(TelegramService);
        const v = await tg.verify();
        process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
        if (!v.ok) {
          process.exitCode = 1;
          break;
        }
        const msgs = process.argv.includes("--sample") ? fakePreview(cfg.DISPLAY_TIMEZONE) : ["<b>Coins Predicts</b> — test message. Telegram delivery is configured."];
        for (const m of msgs) {
          const r = await tg.sendTest(m);
          process.stdout.write(`${JSON.stringify(r.ok ? { sent: true } : { sent: false, error: r.error })}\n`);
          if (!r.ok) process.exitCode = 1;
        }
        break;
      }
      case "telegram:deliver": {
        process.stdout.write(`${JSON.stringify(await ctx.get(TelegramService).deliverPending())}\n`);
        break;
      }
      case "backtest": {
        const min = arg("--min-history");
        const r = await ctx.get(BacktestService).run({ includeFinalTest: process.argv.includes("--final-test"), minHistoryHours: min ? Number(min) : undefined });
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        break;
      }
      case "source:reset": {
        const prisma = ctx.get(PrismaService);
        await prisma.sourceHealth.updateMany({
          where: { providerId: cfg.DATA_SOURCE },
          data: { state: "closed", consecutiveFailures: 0, consecutiveDenials: 0, suspendedReason: null, openedAt: null, retryAfterUntil: null },
        });
        process.stdout.write(`circuit reset for ${cfg.DATA_SOURCE}\n`);
        break;
      }
      case "agent:check": {
        const r = ctx.get<AgentRunner>(AGENT_RUNNER);
        process.stdout.write(`${JSON.stringify({ provider: r.provider, configured: cfg.AGENT_PROVIDER, ...r.availability() }, null, 2)}\n`);
        break;
      }
      default:
        process.stdout.write(HELP);
        process.exitCode = 2;
    }
  } finally {
    await ctx.close();
  }
}

function fakePreview(tz: string): string[] {
  const now = new Date();
  return formatReport({
    generatedAt: now,
    slotTime: slotOf(now),
    timezone: tz,
    providerName: "Fake preview data (NOT real)",
    isLive: false,
    attribution: null,
    coverage: { label: "partial", collected: 2000, universeSize: 8049, coveragePct: 24.8, stale: 3 },
    oldestObservedAt: now.toISOString(),
    agentStatus: "preview",
    summary: "LAYOUT PREVIEW with invented numbers — not a real report.",
    screened: 2000,
    eligible: 812,
    rows: [
      { symbol: "SPRK", name: "Early Spark (fake)", status: "candidate", signalType: "advance", price: 0.8312, marketCap: 748e6, volume24h: 12.1e6, volumeWindow: "rolling_24h", score: 62.4, horizonHours: 24, entry: "", invalidation: "", exit: "", risk: ["thin_history", "no_liquidity_data"], sourceUrl: "fixture://coins/fx-early-spark", observedAt: now.toISOString(), scenario: { entryPrice: 0.8395, stopPrice: 0.7807, targetPrice: 0.9654, trailPct: 0.05, trailActivatePct: 0.08, maxHoldHours: 24, expiresAt: new Date(now.getTime() + 6 * 3_600_000).toISOString() } },
      { symbol: "SRG", name: "Surge Protocol (fake)", status: "watch", signalType: "move_underway", price: 3.21, marketCap: 963e6, volume24h: 45e6, volumeWindow: "rolling_24h", score: 55, horizonHours: 24, entry: "", invalidation: "", exit: "", risk: ["extreme_1h_move"], sourceUrl: "fixture://coins/fx-surge-protocol", observedAt: now.toISOString(), scenario: { entryPrice: 3.274, stopPrice: 3.045, targetPrice: 3.765, trailPct: 0.05, trailActivatePct: 0.08, maxHoldHours: 24, expiresAt: new Date(now.getTime() + 6 * 3_600_000).toISOString() } },
    ],
  });
}

main().catch((err) => {
  process.stderr.write(`${redact(err instanceof Error ? err.message : String(err))}\n`);
  process.exit(1);
});
