import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { formatInZone, sleep } from "../common/time.js";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { redact } from "../config/redact.js";
import { PipelineService } from "../pipeline/pipeline.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ReadModelService } from "../read-model/read-model.service.js";
import { VmcService } from "../vmc/vmc.service.js";
import { TelegramAccessService, isChatId } from "./access.service.js";
import { TelegramAdminService } from "./admin.service.js";
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
  { command: "users", description: "Owner: list members and pending requests" },
];

/**
 * Answers bot commands with long polling (getUpdates). Runs only inside the web server
 * process so CLI commands never compete for updates. The owner (TELEGRAM_CHAT_ID) manages access:
 * newcomers are held as "pending" until the owner sends /approve <id>; members get the hourly
 * report and read-only commands. Message contents are never logged.
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
    private readonly access: TelegramAccessService,
    private readonly admin: TelegramAdminService,
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
        for (const u of (r.body.result as Array<{ update_id: number; message?: { chat: { id: number; type?: string }; from?: { username?: string; first_name?: string }; text?: string } }>) ?? []) {
          offset = u.update_id + 1;
          await this.prisma.appState.upsert({ where: { key: OFFSET_KEY }, create: { key: OFFSET_KEY, value: offset }, update: { value: offset } });
          if (u.message?.text) {
            const who = u.message.from?.username ? `@${u.message.from.username}` : (u.message.from?.first_name ?? "unknown");
            await this.handle(String(u.message.chat.id), u.message.text, { label: who, isPrivate: u.message.chat.type === "private" }).catch((e) => this.log.warn(`command failed: ${redact(e)}`));
          }
        }
      } catch (err) {
        if (!this.running) return;
        failures++;
        this.log.warn(`polling error (${failures}): ${redact(err)}`);
        await sleep(Math.min(60_000, 2_000 * 2 ** Math.min(failures, 5)));
      }
    }
  }

  /** Exposed for tests. Returns the messages that were sent to the sender. */
  async handle(chatId: string, text: string, from: { label?: string; isPrivate?: boolean } = {}): Promise<string[]> {
    const role = await this.access.role(chatId);
    if (role === "denied") return []; // stay silent: a denied chat gets no further signal
    if (role === "unknown" || role === "pending") return this.gate(chatId, role, from);

    const owner = role === "owner";
    const [first = "", arg = ""] = text.trim().split(/\s+/);
    const cmd = first.toLowerCase().replace(/@.*$/, "");
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
        if (!owner) {
          parts = ["Only the owner can run the pipeline. You receive the hourly report automatically; /report shows the latest."];
          break;
        }
        await this.telegram.reply(chatId, "⏳ Running the pipeline… this can take a minute.");
        const r = await this.pipeline.runSlot(undefined, { kind: "manual" });
        parts = r.status === "failed" ? [`❌ Run failed: ${escapeHtml(r.reason ?? "unknown")}`] : await this.report();
        break;
      }
      case "/users":
      case "/approve":
      case "/deny":
      case "/remove":
        parts = owner ? await this.manage(cmd, arg) : [this.help(false)];
        break;
      default:
        parts = [this.help(owner)];
    }
    for (const p of parts) await this.telegram.reply(chatId, p);
    return parts;
  }

  /** Newcomers: queue one access request and tell the owner; repeated messages do not re-notify. */
  private async gate(chatId: string, role: "unknown" | "pending", from: { label?: string; isPrivate?: boolean }): Promise<string[]> {
    if (role === "pending") {
      const msg = "Your access request is waiting for the owner's approval.";
      await this.telegram.reply(chatId, msg);
      return [msg];
    }
    if (from.isPrivate === false) return []; // groups/channels cannot request access
    const label = from.label || "unknown";
    if (!(await this.access.request(chatId, label))) return [];
    const msg = "This bot is private. Your access request was sent to the owner; you will get a message when it is approved.";
    await this.telegram.reply(chatId, msg);
    await this.telegram.reply(this.access.owner, `🔔 <b>Access request</b>\n${escapeHtml(label)} · id <code>${escapeHtml(chatId)}</code>\n/approve ${escapeHtml(chatId)}   /deny ${escapeHtml(chatId)}`);
    return [msg];
  }

  private async manage(cmd: string, arg: string): Promise<string[]> {
    if (cmd === "/users") {
      const s = await this.access.list();
      const fmt = (o: Record<string, { label: string }>) => Object.entries(o).map(([id, e]) => `• ${escapeHtml(e.label)} · <code>${escapeHtml(id)}</code>`);
      return [
        ["<b>👥 Access</b>", `Owner: <code>${escapeHtml(this.access.owner)}</code>`, "", "<b>Members</b>", ...(Object.keys(s.approved).length ? fmt(s.approved) : ["none"]), "", "<b>Pending</b>", ...(Object.keys(s.pending).length ? fmt(s.pending) : ["none"])].join("\n"),
      ];
    }
    if (!isChatId(arg)) return [`Usage: ${cmd} &lt;chat id&gt; — the numeric id is shown in the access request or /users.`];
    if (arg === this.access.owner) return ["That is the owner."];
    if (cmd === "/approve") {
      const { entry, notified } = await this.admin.approve(arg);
      return [`✅ Approved ${escapeHtml(entry.label)} (<code>${escapeHtml(arg)}</code>).${notified ? "" : " ⚠️ They could not be notified; they must open the bot and press Start."}`];
    }
    if (cmd === "/deny") {
      await this.admin.deny(arg);
      return [`🚫 Denied <code>${escapeHtml(arg)}</code>; further messages from it are ignored.`];
    }
    const had = await this.admin.remove(arg);
    return [had ? `🗑 Removed <code>${escapeHtml(arg)}</code>; they no longer receive reports.` : `<code>${escapeHtml(arg)}</code> was not a member.`];
  }

  private help(owner: boolean): string {
    return [
      "<b>📊 Coins Predicts bot</b>",
      "/report — latest hourly report",
      "/status — pipeline and data status",
      "/vmc — volume / market cap vs 6-month baseline",
      ...(owner ? ["/run — run the pipeline now", "", "<b>Owner</b>", "/users — members and pending requests", "/approve &lt;id&gt; · /deny &lt;id&gt; · /remove &lt;id&gt;"] : []),
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
