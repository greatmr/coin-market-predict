import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { formatInZone, sleep } from "../common/time.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { redact } from "../config/redact.js";
import { PipelineService } from "../pipeline/pipeline.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ReadModelService } from "../read-model/read-model.service.js";
import { VmcService } from "../vmc/vmc.service.js";
import { escapeHtml, pack } from "./format.js";
import { ReportService } from "./report.service.js";
import { TELEGRAM_FETCH, TelegramService } from "./telegram.service.js";

const OFFSET_KEY = "telegram.updateOffset";

export const COMMANDS = [
  { command: "report", description: "Latest hourly report" },
  { command: "status", description: "Pipeline and data status" },
  { command: "vmc", description: "Volume / market cap vs 6-month baseline" },
  { command: "run", description: "Run the pipeline now" },
  { command: "help", description: "Show commands" },
];

/**
 * Answers bot commands with long polling (getUpdates). Runs only inside the web server
 * process so CLI commands never compete for updates. Only the configured TELEGRAM_CHAT_ID is
 * served; everyone else gets a short refusal. Message contents are never logged.
 */
@Injectable()
export class TelegramBotService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger("TelegramBot");
  private abort = new AbortController();
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(TELEGRAM_FETCH) private readonly fetchImpl: typeof fetch,
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly reports: ReportService,
    private readonly read: ReadModelService,
    private readonly pipeline: PipelineService,
    private readonly vmc: VmcService,
  ) {}

  onApplicationBootstrap() {
    if (!this.cfg.TELEGRAM_BOT_TOKEN || !this.cfg.TELEGRAM_CHAT_ID || !this.cfg.TELEGRAM_COMMANDS_ENABLED) return;
    this.running = true;
    void this.api("setMyCommands", { commands: COMMANDS }).catch(() => undefined);
    void this.loop();
    this.log.log("listening for bot commands (/report, /status, /vmc, /run, /help)");
  }

  onApplicationShutdown() {
    this.running = false;
    this.abort.abort();
  }

  private async api(method: string, body: unknown, timeoutMs = 20_000) {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.cfg.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: unknown } };
  }

  private async loop() {
    let offset = Number((await this.prisma.appState.findUnique({ where: { key: OFFSET_KEY } }))?.value ?? 0);
    let failures = 0;
    while (this.running) {
      try {
        const r = await this.api("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, 40_000);
        if (r.status === 409) {
          this.log.warn(`getUpdates conflict: ${r.body.description ?? ""} (another poller or a webhook is active)`);
          await sleep(30_000);
          continue;
        }
        if (!r.body.ok) throw new Error(`getUpdates HTTP ${r.status}: ${r.body.description ?? ""}`);
        failures = 0;
        for (const u of (r.body.result as Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }>) ?? []) {
          offset = u.update_id + 1;
          await this.prisma.appState.upsert({ where: { key: OFFSET_KEY }, create: { key: OFFSET_KEY, value: offset }, update: { value: offset } });
          if (u.message?.text) await this.handle(String(u.message.chat.id), u.message.text).catch((e) => this.log.warn(`command failed: ${redact(e)}`));
        }
      } catch (err) {
        if (!this.running) return;
        failures++;
        this.log.warn(`polling error (${failures}): ${redact(err)}`);
        await sleep(Math.min(60_000, 2_000 * 2 ** Math.min(failures, 5)));
      }
    }
  }

  /** Exposed for tests. Returns the messages that were sent. */
  async handle(chatId: string, text: string): Promise<string[]> {
    if (chatId !== String(this.cfg.TELEGRAM_CHAT_ID)) {
      await this.telegram.reply(chatId, "This bot is private.");
      return ["This bot is private."];
    }
    const cmd = text.trim().split(/\s+/)[0]!.toLowerCase().replace(/@.*$/, "");
    let parts: string[];
    switch (cmd) {
      case "/report":
        parts = await this.report();
        break;
      case "/status":
        parts = [await this.status()];
        break;
      case "/vmc":
        parts = await this.vmcCards();
        break;
      case "/run": {
        await this.telegram.reply(chatId, "⏳ Running the pipeline… this can take a minute.");
        const r = await this.pipeline.runSlot(undefined, { kind: "manual" });
        parts = r.status === "failed" ? [`❌ Run failed: ${escapeHtml(r.reason ?? "unknown")}`] : await this.report();
        break;
      }
      default:
        parts = [this.help()];
    }
    for (const p of parts) await this.telegram.reply(chatId, p);
    return parts;
  }

  private help(): string {
    return [
      "<b>📊 Coins Predicts bot</b>",
      "/report — latest hourly report",
      "/status — pipeline and data status",
      "/vmc — volume / market cap vs 6-month baseline",
      "/run — run the pipeline now",
      "",
      `Automatic hourly reports: ${this.cfg.TELEGRAM_MODE === "live" && this.cfg.SCHEDULER_ENABLED ? "ON" : "OFF (set TELEGRAM_MODE=live and SCHEDULER_ENABLED=true)"}`,
    ].join("\n");
  }

  private async report(): Promise<string[]> {
    const runId = await this.read.latestRunId();
    if (!runId) return ["No report yet. Send /run to create one."];
    return this.reports.build(runId, "latest", null);
  }

  private async status(): Promise<string> {
    const [runs, cov] = await Promise.all([this.read.runs(3), this.read.coverage()]);
    const tz = this.cfg.DISPLAY_TIMEZONE;
    const lines = [
      "<b>⚙️ Status</b>",
      `Data: ${cov.isLiveData ? "live" : "🧪 TEST DATA (synthetic)"} · ${escapeHtml(String((cov.provider as { name?: string } | null)?.name ?? this.cfg.DATA_SOURCE))}`,
      `Agents: ${this.cfg.AGENT_PROVIDER} · Telegram: ${this.cfg.TELEGRAM_MODE} · Scheduler: ${this.cfg.SCHEDULER_ENABLED ? "on" : "off"}`,
      "",
      "<b>Recent runs</b>",
      ...runs.map((r) => `${r.status === "succeeded" || r.status === "partial" ? "✅" : r.status === "failed" ? "❌" : "•"} ${formatInZone(new Date(String(r.slotTime)), tz).slice(5, 16)} · ${escapeHtml(String(r.kind))} · ${escapeHtml(String(r.status))}`),
    ];
    return lines.join("\n");
  }

  private async vmcCards(): Promise<string[]> {
    if (this.vmc.assetIds.length === 0) return ["Volume / market cap tracking is not configured (VMC_ASSET_IDS is empty)."];
    const c = await this.vmc.comparison();
    const blocks = [`<b>📐 Volume / Market Cap</b>${c.isFixture ? "\n🧪 <b>TEST DATA</b> — synthetic" : ""}\nCurrent = 24h volume ÷ market cap now\nBaseline = 6-month average of daily ratios`];
    for (const r of c.rows) {
      blocks.push(
        [
          `<b>${escapeHtml(r.symbol)}</b> · ${escapeHtml(r.name)} (CMC ${r.cmcId})`,
          `Current ${r.currentRatio ? Number(r.currentRatio).toFixed(4) : "n/a"} · Baseline ${r.baselineMean ? Number(r.baselineMean).toFixed(4) : "n/a"}`,
          `Ratio to baseline: ${escapeHtml(r.ratioToBaseline)}`,
          `Baseline: ${escapeHtml(r.baselineCoverage)}`,
          `Last 72h: ${escapeHtml(r.recentWindow)}`,
          `Status: ${escapeHtml(r.dataStatus.join(", "))}`,
        ].join("\n"),
      );
    }
    blocks.push("<i>Descriptive only — no signals or thresholds.</i>");
    return pack(blocks);
  }
}
