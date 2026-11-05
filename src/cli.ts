import { existsSync, statSync } from "node:fs";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { loadConfigOrExit, RedactingLogger } from "./bootstrap.js";
import { slotOf } from "./common/time.js";
import { describeConfig } from "./config/config.js";
import { redact } from "./config/redact.js";
import { IngestionService } from "./ingestion/ingestion.service.js";
import { PipelineService } from "./pipeline/pipeline.service.js";
import { PrismaService } from "./prisma/prisma.service.js";
import { ReadModelService } from "./read-model/read-model.service.js";
import { parseDocumentPart } from "./telegram/attachment.js";
import { formatTier1Report } from "./telegram/format.js";
import { ReportService } from "./telegram/report.service.js";
import { TelegramService } from "./telegram/telegram.service.js";
import { parseCmcHistoryCsv } from "./tier1/csv-import.js";
import { DailyService } from "./tier1/daily.service.js";
import { isCmcIdProvider } from "./tier1/providers.js";
import { VenuesService } from "./tier1/venues.service.js";

const HELP = `Coins Predicts CLI — Two-Tier VMC strategy (docs/strategy-two-tier-vmc.md)

  config:check                 Validate configuration (secrets shown only as set/not set)
  run-once [--slot ISO] [--force] [--kind manual]
                               Run the hourly pipeline for the current (or given) slot:
                               collect → LBank pairs → daily rows → Tier 1 scan → venues → export → Telegram
  discover                     Run listing discovery now
  tier1:scan [--batch ID] [--no-export]
                               Reprocess a saved crawl batch (default: latest) without crawling,
                               then export it (PDF p.18 dry run over saved data)
  tier1:export [--batch ID]    Re-export a scanned batch (CSV per sheet + XLSX + manifest)
  tier1:trace --id CMC_ID [--batch ID] [--json]
                               Full calculation trace for one asset (30 daily rows, windows, rules)
  tier1:batches                Recent crawl batches with scan and export status
  lbank:status                 The stored LBank Spot markets list: fetched when, next automatic refresh
  lbank:refresh                Fetch the LBank Spot markets list now (normally every
                               LBANK_PAIRS_REFRESH_DAYS), then recompute and re-export the latest batch
  daily:import-csv --id CMC_ID --file history.csv
                               Import a CSV downloaded from the coin's CMC "Historical Data" page
                               as completed daily rows (manual source, revisions kept)
  telegram:preview [--batch ID] [--fake]
                               Print the Telegram summary (latest batch, or a fake-data layout)
  telegram:test [--sample]     Verify bot token + chat and send one test message
  telegram:deliver             Send pending live Telegram deliveries
  source:reset [--provider ID] Clear a suspended/open circuit breaker after you resolved the cause
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
    return;
  }
  if (cmd === "telegram:preview" && process.argv.includes("--fake")) {
    process.stdout.write(`${fakePreview(cfg.DISPLAY_TIMEZONE).join("\n\n----- next message -----\n\n")}\n`);
    return;
  }

  const ctx = await NestFactory.createApplicationContext(AppModule.forRoot(cfg, { http: false }), { logger: new RedactingLogger() });
  const out = (v: unknown) => process.stdout.write(`${typeof v === "string" ? v : JSON.stringify(v, null, 2)}\n`);
  try {
    switch (cmd) {
      case "run-once": {
        const slot = arg("--slot") ? new Date(arg("--slot")!) : undefined;
        const r = await ctx.get(PipelineService).runSlot(slot, { force: process.argv.includes("--force"), kind: arg("--kind") ?? "hourly" });
        out(r);
        if (r.status === "failed") process.exitCode = 1;
        break;
      }
      case "discover": {
        const r = await ctx.get(IngestionService).discover(new Date());
        out({ status: r.status, assetsSeen: r.assetsSeen, newAssets: r.newAssets, complete: r.coverageComplete, sourceTotal: r.sourceTotal });
        break;
      }
      case "tier1:scan": {
        const r = await ctx.get(PipelineService).reprocess(arg("--batch"), { export: !process.argv.includes("--no-export") });
        out(r.skipped ? r : { batchId: r.batchId, queueStatus: r.scan?.queueStatus, counts: r.scan?.counts, warnings: r.scan?.warnings, export: r.export });
        if (r.skipped || r.export?.status === "failed") process.exitCode = 1;
        break;
      }
      case "tier1:export": {
        const batchId = arg("--batch") ?? (await ctx.get(ReadModelService).latestScanBatchId());
        if (!batchId) throw new Error("no scanned batch yet; run `npm run cli -- run-once` first");
        const r = await ctx.get(PipelineService).exportBatch(batchId);
        out(r);
        if ("skipped" in r || r.status === "failed") process.exitCode = 1;
        break;
      }
      case "tier1:trace": {
        const id = Number(arg("--id"));
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error("usage: tier1:trace --id <CMC id> [--batch <batch id>] [--json]");
        const t = await ctx.get(ReadModelService).assetTrace(id, arg("--batch"));
        if (!t) throw new Error(`no Tier 1 record for CMC id ${id}`);
        out(process.argv.includes("--json") ? t : renderTrace(t));
        break;
      }
      case "lbank:status": {
        out(await ctx.get(VenuesService).lbankListStatus(cfg.DATA_SOURCE) ?? { list: null, note: "no complete LBank Spot markets list yet; it is fetched by the next run or `lbank:refresh`" });
        break;
      }
      case "lbank:refresh": {
        const r = await ctx.get(PipelineService).refreshLbankPairs();
        out("skipped" in r ? r : { lbank: r.lbank, batchId: r.batchId, queueStatus: r.scan?.queueStatus ?? null, counts: r.scan?.counts ?? null, export: r.export?.status ?? null });
        if ("skipped" in r || !r.lbank.usable) process.exitCode = 1;
        break;
      }
      case "tier1:batches": {
        const rows = await ctx.get(ReadModelService).batches(24);
        out(rows.map((b) => {
          const s = b.scan as { status?: string; queueStatus?: string; counts?: Record<string, number>; exportStatus?: string } | null;
          return `${String(b.slotTime)}  ${String(b.status).padEnd(10)} collected ${String(b.collected).padStart(5)}  scan ${s?.status ?? "-"} ${s?.queueStatus ?? ""} queue ${s?.counts?.queue ?? "-"} eligible ${s?.counts?.eligible ?? "-"} review ${s?.counts?.needsReview ?? "-"} export ${s?.exportStatus ?? "-"}  ${String(b.id)}`;
        }).join("\n"));
        break;
      }
      case "daily:import-csv": {
        const file = arg("--file");
        const id = Number(arg("--id"));
        if (!file || !Number.isSafeInteger(id) || id < 1) throw new Error("usage: daily:import-csv --id <CMC id> --file <downloaded.csv>");
        if (!isCmcIdProvider(cfg.DATA_SOURCE)) throw new Error(`DATA_SOURCE=${cfg.DATA_SOURCE} does not use CMC ids`);
        const { readFileSync } = await import("node:fs");
        const { basename } = await import("node:path");
        const text = readFileSync(file, "utf8");
        const parsed = parseCmcHistoryCsv(text, id, new Date());
        const { sha256 } = await import("./common/decimal.js");
        const counts = await ctx.get(DailyService).upsertRows(cfg.DATA_SOURCE, parsed.rows, { source: "manual_csv_import", params: { file: basename(file), cmcId: String(id) }, responseSha256: sha256(text), retrievedAt: new Date(), batchId: null });
        out({ cmcId: id, provider: cfg.DATA_SOURCE, rows: parsed.rows.length, range: { first: parsed.rows[0]?.dateUtc ?? null, last: parsed.rows.at(-1)?.dateUtc ?? null }, skippedIncompleteDay: parsed.skippedIncomplete, skippedUnparseable: parsed.skippedUnparseable, ...counts, note: "Rows apply from the next scan; run `tier1:scan` to reprocess the latest batch now." });
        break;
      }
      case "telegram:preview": {
        const batchId = arg("--batch") ?? (await ctx.get(ReadModelService).latestScanBatchId());
        if (!batchId) throw new Error("no scanned batch yet; run `npm run cli -- run-once` first, or use --fake");
        const parts = (await ctx.get(ReportService).build(batchId)).map((p) => {
          const d = parseDocumentPart(p);
          return d ? `[attachment] ${d.filename} (${existsSync(d.path) ? `${Math.round(statSync(d.path).size / 1024)} KB` : "file missing"})\n${d.caption}` : p;
        });
        out(parts.join("\n\n----- next message -----\n\n"));
        break;
      }
      case "telegram:test": {
        const tg = ctx.get(TelegramService);
        const v = await tg.verify();
        out(v);
        if (!v.ok) {
          process.exitCode = 1;
          break;
        }
        const msgs = process.argv.includes("--sample") ? fakePreview(cfg.DISPLAY_TIMEZONE) : ["<b>Coins Predicts</b> — test message. Telegram delivery is configured."];
        for (const m of msgs) {
          const r = await tg.sendTest(m);
          out(r.ok ? { sent: true } : { sent: false, error: r.error });
          if (!r.ok) process.exitCode = 1;
        }
        break;
      }
      case "telegram:deliver":
        out(await ctx.get(TelegramService).deliverPending());
        break;
      case "source:reset": {
        const prisma = ctx.get(PrismaService);
        const provider = arg("--provider") ?? cfg.DATA_SOURCE;
        if (!["fixture", "coinmarketcap", "coinmarketcap_web", "coingecko"].includes(provider)) throw new Error("unknown source provider");
        await prisma.sourceHealth.updateMany({ where: { providerId: provider }, data: { state: "closed", consecutiveFailures: 0, consecutiveDenials: 0, suspendedReason: null, openedAt: null, retryAfterUntil: null } });
        out(`circuit reset for ${provider}`);
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

/** Human-readable calculation trace (PDF p.20 #2). */
function renderTrace(t: Record<string, unknown>): string {
  const r = t.record as Record<string, unknown>;
  const cur = t.current as { label: string; formula: string; status: string };
  const daily = t.daily as { asOfDate: string; latestCompletedDate: string; used: Array<{ dateUtc: string; volumeUsd: string | null; marketCapUsd: string | null; vmc: string | null; closeUsd: string | null; valid: boolean | null; revision: number | null; invalidReasons: string[] }> };
  const windows = t.windows as Array<{ days: number; role: string; formula: string; comparison: string | null }>;
  const elig = t.eligibility as { status: string; reasons: string[]; assetClass: string; classSource: string };
  const lb = t.lbank as { status: string; reason: string | null; pairs: Array<{ marketPair: string; mapping: string; trading: string }> };
  const batch = t.batch as { id: string; slotTime: string; crawledAt: string; status: string; isLive: boolean };
  const lines = [
    `${r.symbol} · ${r.name} · CMC id ${r.cmcId}${batch.isLive ? "" : "   [SYNTHETIC fixture data]"}`,
    `batch ${batch.id} · slot ${batch.slotTime} · crawled ${batch.crawledAt} · ${batch.status}`,
    `rank ${r.rank ?? "n/a"} · cap ${r.capUsd ?? "n/a"} USD · volume 24h ${r.volume24hUsd ?? "n/a"} USD · price ${r.priceUsd ?? "n/a"} USD · age ${r.ageDays ?? "n/a"} days`,
    "",
    `Current observation (${cur.status}): ${cur.label}`,
    `  ${cur.formula}`,
    "",
    `Completed UTC daily rows used (as-of ${daily.asOfDate}; newest = ${daily.latestCompletedDate}):`,
    "  date        volume_usd            market_cap_usd          vmc                      close        rev",
    ...daily.used.map((d) => `  ${d.dateUtc}  ${(d.volumeUsd ?? "—").padEnd(20)}  ${(d.marketCapUsd ?? "—").padEnd(22)}  ${(d.vmc ?? (d.valid === false ? `invalid: ${d.invalidReasons.join(",")}` : "missing")).slice(0, 24).padEnd(24)} ${(d.closeUsd ?? "—").slice(0, 12).padEnd(12)} ${d.revision ?? "-"}`),
    "",
    "Windows:",
    ...windows.flatMap((w) => [`  ${w.days}d (${w.role})`, `    ${w.formula}`, ...(w.comparison ? [`    ${w.comparison}`] : [])]),
    "",
    `Stars ${r.stars} · eligibility ${elig.status}${elig.reasons.length ? ` (${elig.reasons.join(", ")})` : ""} · class ${elig.assetClass} [${elig.classSource}]`,
    `LBank ${lb.status}${lb.reason ? ` (${lb.reason})` : ""}: ${lb.pairs.map((p) => `${p.marketPair} ${p.mapping}/${p.trading}`).join("; ") || "no pairs"}`,
    `queue ${r.inQueue ? `#${r.queueOrder}` : "no"} · flags ${[...(r.flags as string[]), ...(r.venueFlags as string[])].join(", ") || "none"}`,
    `ruleset ${r.rulesetVersion} · config ${r.configVersion} · inputs ${r.inputsHash} · computed ${r.computedAt}`,
  ];
  return lines.join("\n");
}

function fakePreview(tz: string): string[] {
  const now = new Date();
  return formatTier1Report({
    generatedAt: now,
    slotTime: slotOf(now),
    crawledAt: now,
    timezone: tz,
    providerName: "Fake preview data (NOT real)",
    isLive: false,
    attribution: null,
    batchStatus: "COMPLETE",
    batchReasons: [],
    queueStatus: "PUBLISHED",
    counts: { assets: 8041, eligible: 212, needsReview: 341, excluded: 7488, queue: 2 },
    needsReviewWithYes: 14,
    lbankUnverifiedWithYes: 11,
    rows: [
      { order: 1, cmcId: 990001, symbol: "FAKE1", stars: 2, pass: { d3: "YES", d7: "NO", d30: "YES" }, multiple: { d3: 2, d7: 1.333, d30: 4 }, currentVmc: 0.2, capUsd: 1e8, lbankPairs: ["FAKE1/USDT"] },
      { order: 2, cmcId: 990002, symbol: "FAKE2", stars: 1, pass: { d3: "NO", d7: "N/A", d30: "YES" }, multiple: { d3: 1.2, d7: null, d30: 1.9 }, currentVmc: 0.031, capUsd: 4e7, lbankPairs: ["FAKE2/USDT", "FAKE2/BTC"] },
    ],
    warnings: [],
  });
}

main().catch((err) => {
  process.stderr.write(`${redact(err instanceof Error ? err.message : String(err))}\n`);
  process.exit(1);
});
