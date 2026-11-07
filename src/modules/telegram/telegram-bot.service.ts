import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { redact } from '../../common/security/redact.js';
import { formatInZone, sleep } from '../../common/utils/time.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { AppStateService } from '../app-state/app-state.service.js';
import { PipelineService } from '../pipeline/pipeline.service.js';
import { ReadModelService } from '../read-model/read-model.service.js';

import { TelegramAccessService, isChatId } from './access.service.js';
import { TelegramAdminService } from './admin.service.js';
import {
  type CoinDetailInput,
  coinLink,
  escapeHtml,
  formatCoinDetail,
  formatVmcBrief,
} from './format.js';
import { ReportService } from './report.service.js';
import { TELEGRAM_FETCH, TelegramService } from './telegram.service.js';

const OFFSET_KEY = 'telegram.updateOffset';

export const COMMANDS = [
  { command: 'report', description: 'Latest hourly report' },
  { command: 'status', description: 'Pipeline and data status' },
  { command: 'vmc', description: 'Tier 1 VMC trace for one coin: /vmc <CMC id or symbol>' },
  {
    command: 'coin',
    description: 'Full details for one coin (as in the dashboard): /coin <CMC id or symbol>',
  },
  { command: 'run', description: 'Run the pipeline now' },
  { command: 'help', description: 'Show commands' },
  { command: 'users', description: 'Owner: list members and pending requests' },
];

/**
 * Answers bot commands with long polling (getUpdates). Runs only inside the web server
 * process so CLI commands never compete for updates. The owner (TELEGRAM_CHAT_ID) manages access:
 * newcomers are held as "pending" until the owner sends /approve <id>; members get the hourly
 * report and read-only commands. Message contents are never logged.
 */
@Injectable()
export class TelegramBotService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('TelegramBot');
  private abort = new AbortController();
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(TELEGRAM_FETCH) private readonly fetchImpl: typeof fetch,
    private readonly state: AppStateService,
    private readonly telegram: TelegramService,
    private readonly reports: ReportService,
    private readonly read: ReadModelService,
    private readonly pipeline: PipelineService,
    private readonly access: TelegramAccessService,
    private readonly admin: TelegramAdminService,
  ) {}

  onApplicationBootstrap() {
    if (
      !this.cfg.TELEGRAM_BOT_TOKEN ||
      !this.cfg.TELEGRAM_CHAT_ID ||
      !this.cfg.TELEGRAM_COMMANDS_ENABLED
    )
      return;
    this.running = true;
    void this.api('setMyCommands', { commands: COMMANDS }).catch(() => undefined);
    void this.telegram.loadBotUsername();
    void this.loop();
    this.log.log('listening for bot commands (/report, /status, /vmc, /coin, /run, /help)');
  }

  onApplicationShutdown() {
    this.running = false;
    this.abort.abort();
  }

  private async api(method: string, body: unknown, timeoutMs = 20_000) {
    const res = await this.fetchImpl(
      `https://api.telegram.org/bot${this.cfg.TELEGRAM_BOT_TOKEN}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]),
      },
    );
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
        result?: unknown;
      },
    };
  }

  private async loop() {
    let offset = Number((await this.state.get(OFFSET_KEY)) ?? 0);
    let failures = 0;
    while (this.running) {
      try {
        const r = await this.api(
          'getUpdates',
          { offset, timeout: 25, allowed_updates: ['message'] },
          40_000,
        );
        if (r.status === 409) {
          this.log.warn(
            `getUpdates conflict: ${r.body.description ?? ''} (another poller or a webhook is active)`,
          );
          await sleep(30_000);
          continue;
        }
        if (!r.body.ok) throw new Error(`getUpdates HTTP ${r.status}: ${r.body.description ?? ''}`);
        if (failures > 0) this.log.log(`polling recovered after ${failures} failed attempt(s)`);
        failures = 0;
        for (const u of (r.body.result as Array<{
          update_id: number;
          message?: {
            chat: { id: number; type?: string };
            from?: { username?: string; first_name?: string };
            text?: string;
          };
        }>) ?? []) {
          offset = u.update_id + 1;
          await this.state.set(OFFSET_KEY, offset);
          if (u.message?.text) {
            const who = u.message.from?.username
              ? `@${u.message.from.username}`
              : (u.message.from?.first_name ?? 'unknown');
            await this.handle(String(u.message.chat.id), u.message.text, {
              label: who,
              isPrivate: u.message.chat.type === 'private',
            }).catch((e) => this.log.warn(`command failed: ${redact(e)}`));
          }
        }
      } catch (err) {
        if (!this.running) return;
        failures++;
        // Network drops are normal; the loop retries with backoff (4 s … 60 s) and logs the recovery.
        this.log.warn(
          `polling error (${failures}, retrying in ${Math.min(60, 2 * 2 ** Math.min(failures, 5))} s): ${redact(err)}`,
        );
        await sleep(Math.min(60_000, 2_000 * 2 ** Math.min(failures, 5)));
      }
    }
  }

  /** Exposed for tests. Returns the messages that were sent to the sender. */
  async handle(
    chatId: string,
    text: string,
    from: { label?: string; isPrivate?: boolean } = {},
  ): Promise<string[]> {
    const role = await this.access.role(chatId);
    if (role === 'denied') return []; // stay silent: a denied chat gets no further signal
    if (role === 'unknown' || role === 'pending') return this.gate(chatId, role, from);

    const owner = role === 'owner';
    const [first = '', typedArg = ''] = text.trim().split(/\s+/);
    // Reports link coins two ways: a tapped name sends "/start coin_35600" (a t.me deep link),
    // and the fallback command is "/coin_35600". Both mean /coin 35600 (same for /vmc).
    const head = first.toLowerCase().replace(/@.*$/, '');
    const linked =
      /^(\/(?:coin|vmc))_(\d{1,10})$/.exec(head) ??
      (head === '/start' ? /^(coin|vmc)_(\d{1,10})$/.exec(typedArg.toLowerCase()) : null);
    const cmd = linked ? `/${linked[1]!.replace(/^\//, '')}` : head;
    const arg = linked ? linked[2]! : typedArg;
    let parts: string[];
    switch (cmd) {
      case '/report':
        parts = await this.report();
        break;
      case '/status':
        parts = [await this.status()];
        break;
      case '/vmc':
        parts = [await this.vmcTrace(arg)];
        break;
      case '/coin':
        parts = await this.coinDetail(arg);
        break;
      case '/run': {
        if (!owner) {
          parts = [
            'Only the owner can run the pipeline. You receive the hourly report automatically; /report shows the latest.',
          ];
          break;
        }
        await this.telegram.reply(chatId, '⏳ Running the pipeline… this can take a minute.');
        const r = await this.pipeline.runSlot(undefined, { kind: 'manual' });
        parts =
          r.status === 'failed'
            ? [`❌ Run failed: ${escapeHtml(r.reason ?? 'unknown')}`]
            : await this.report();
        break;
      }
      case '/users':
      case '/approve':
      case '/deny':
      case '/remove':
        parts = owner ? await this.manage(cmd, arg) : [this.help(false)];
        break;
      default:
        parts = [this.help(owner)];
    }
    for (const p of parts) await this.telegram.reply(chatId, p);
    return parts;
  }

  /** Newcomers: queue one access request and tell the owner; repeated messages do not re-notify. */
  private async gate(
    chatId: string,
    role: 'unknown' | 'pending',
    from: { label?: string; isPrivate?: boolean },
  ): Promise<string[]> {
    if (role === 'pending') {
      const msg = "Your access request is waiting for the owner's approval.";
      await this.telegram.reply(chatId, msg);
      return [msg];
    }
    if (from.isPrivate === false) return []; // groups/channels cannot request access
    const label = from.label || 'unknown';
    if (!(await this.access.request(chatId, label))) return [];
    const msg =
      'This bot is private. Your access request was sent to the owner; you will get a message when it is approved.';
    await this.telegram.reply(chatId, msg);
    await this.telegram.reply(
      this.access.owner,
      `🔔 <b>Access request</b>\n${escapeHtml(label)} · id <code>${escapeHtml(chatId)}</code>\n/approve ${escapeHtml(chatId)}   /deny ${escapeHtml(chatId)}`,
    );
    return [msg];
  }

  private async manage(cmd: string, arg: string): Promise<string[]> {
    if (cmd === '/users') {
      const s = await this.access.list();
      const fmt = (o: Record<string, { label: string }>) =>
        Object.entries(o).map(
          ([id, e]) => `• ${escapeHtml(e.label)} · <code>${escapeHtml(id)}</code>`,
        );
      return [
        [
          '<b>👥 Access</b>',
          `Owner: <code>${escapeHtml(this.access.owner)}</code>`,
          '',
          '<b>Members</b>',
          ...(Object.keys(s.approved).length ? fmt(s.approved) : ['none']),
          '',
          '<b>Pending</b>',
          ...(Object.keys(s.pending).length ? fmt(s.pending) : ['none']),
        ].join('\n'),
      ];
    }
    if (!isChatId(arg))
      return [
        `Usage: ${cmd} &lt;chat id&gt; — the numeric id is shown in the access request or /users.`,
      ];
    if (arg === this.access.owner) return ['That is the owner.'];
    if (cmd === '/approve') {
      const { entry, notified } = await this.admin.approve(arg);
      return [
        `✅ Approved ${escapeHtml(entry.label)} (<code>${escapeHtml(arg)}</code>).${notified ? '' : ' ⚠️ They could not be notified; they must open the bot and press Start.'}`,
      ];
    }
    if (cmd === '/deny') {
      await this.admin.deny(arg);
      return [`🚫 Denied <code>${escapeHtml(arg)}</code>; further messages from it are ignored.`];
    }
    const had = await this.admin.remove(arg);
    return [
      had
        ? `🗑 Removed <code>${escapeHtml(arg)}</code>; they no longer receive reports.`
        : `<code>${escapeHtml(arg)}</code> was not a member.`,
    ];
  }

  private help(owner: boolean): string {
    const auto = this.cfg.TELEGRAM_MODE === 'live' && this.cfg.SCHEDULER_ENABLED;
    return [
      '📊 <b>Coins Predicts</b>',
      '<i>Hourly volume ÷ market cap screen of every CoinMarketCap coin. Research only.</i>',
      '',
      '/report — latest hourly report',
      '/status — pipeline and data health',
      '/coin SIGN — everything about one coin (symbol or CMC id)',
      '/vmc SIGN — just its VMC windows',
      ...(owner
        ? [
            '',
            '<b>Owner</b>',
            '/run — run the pipeline now',
            '/users — members and pending requests',
            '/approve id · /deny id · /remove id',
          ]
        : []),
      '',
      auto
        ? '🔔 You get the report automatically every hour.'
        : '🔕 Automatic reports are off (needs TELEGRAM_MODE=live and SCHEDULER_ENABLED=true).',
    ].join('\n');
  }

  private async report(): Promise<string[]> {
    const batchId = await this.read.latestScanBatchId();
    if (!batchId) return ['No report yet. Send /run to create one.'];
    return this.reports.build(batchId);
  }

  private async status(): Promise<string> {
    const [runs, cov, o] = await Promise.all([
      this.read.runs(4),
      this.read.coverage(),
      this.read.overview() as Promise<{
        latestBatch?: { status?: string } | null;
        scan?: { queueStatus?: string; counts?: Record<string, number> } | null;
        crawlAgeMinutes?: number | null;
        schedule?: { enabled?: boolean; nextRunAt?: string | null } | null;
      }>,
    ]);
    const tz = this.cfg.DISPLAY_TIMEZONE;
    const local = (iso: unknown) => formatInZone(new Date(String(iso)), tz);
    const RUN_ICON: Record<string, string> = {
      succeeded: '✅',
      partial: '⚠️',
      failed: '❌',
      running: '⏳',
    };
    const provider = String(
      (cov.provider as { name?: string } | null)?.name ?? this.cfg.DATA_SOURCE,
    );
    const lines = [
      '⚙️ <b>Status</b>',
      `${cov.isLiveData ? '🟢 Live data' : '🧪 Test data (synthetic)'} · ${escapeHtml(provider)}`,
      `<i>Telegram ${escapeHtml(this.cfg.TELEGRAM_MODE)} · scheduler ${this.cfg.SCHEDULER_ENABLED ? 'on' : 'off'}</i>`,
      '',
    ];
    if (o.scan) {
      const c = o.scan.counts ?? {};
      const batch = String(o.latestBatch?.status ?? 'unknown').toLowerCase();
      const queue = String(o.scan.queueStatus ?? '');
      lines.push(
        `<b>Latest scan</b> · batch ${escapeHtml(batch)}, ${o.crawlAgeMinutes ?? '?'} min old`,
        `🎯 Queue ${c.queue ?? 0}${queue.startsWith('WITHHELD') ? ' (withheld)' : ''} · ✅ eligible ${c.eligible ?? 0} · 🔎 needs review ${c.needsReview ?? 0}`,
      );
    } else lines.push('<b>Latest scan</b> · none yet. Send /run to create one.');
    if (o.schedule?.enabled && o.schedule.nextRunAt)
      lines.push(`⏭ Next run ${escapeHtml(local(o.schedule.nextRunAt).slice(11))}`);
    if (runs.length)
      lines.push(
        '',
        '<b>Recent runs</b>',
        ...runs.map(
          (r) =>
            `${RUN_ICON[String(r.status)] ?? '▫️'} ${escapeHtml(local(r.slotTime).slice(5, 16))} · ${escapeHtml(String(r.kind))} · ${escapeHtml(String(r.status))}`,
        ),
      );
    return lines.join('\n');
  }

  /** A CMC id, or a symbol that maps to exactly one coin of the latest scan; else a reply text. */
  private async resolveCoin(
    arg: string,
    command: string,
  ): Promise<{ cmcId: number } | { message: string }> {
    const q = arg.trim();
    if (!q) return { message: `Usage: /${command} &lt;CMC id or symbol&gt;, e.g. /${command} 52` };
    if (/^\d{1,10}$/.test(q)) return { cmcId: Number(q) };
    const batchId = await this.read.latestScanBatchId();
    if (!batchId) return { message: 'No scan yet. Send /run to create one.' };
    const exact = await this.read.findBySymbol(batchId, q, 10);
    if (exact.length > 1)
      return {
        message: `Several coins use the symbol ${escapeHtml(q)}. Tap one:\n${exact
          .map((r) =>
            this.telegram.botUsername
              ? `• ${coinLink(`${escapeHtml(r.symbol)} · ${escapeHtml(r.name)}`, r.cmcId, this.telegram.botUsername, command as 'coin' | 'vmc')}`
              : `• ${escapeHtml(r.name)} /${command}_${r.cmcId}`,
          )
          .join('\n')}`,
      };
    if (!exact.length)
      return {
        message: `No coin with the symbol ${escapeHtml(q)} in the latest scan. Try the CMC id.`,
      };
    return { cmcId: exact[0]!.cmcId };
  }

  /** The dashboard drawer for one coin of the latest scan, as phone-width messages. */
  private async coinDetail(arg: string): Promise<string[]> {
    const found = await this.resolveCoin(arg, 'coin');
    if ('message' in found) return [found.message];
    const t = await this.read.assetTrace(found.cmcId);
    if (!t) return [`No Tier 1 record for CMC id ${found.cmcId} in the latest scan.`];
    return formatCoinDetail(t as unknown as CoinDetailInput);
  }

  /** Tier 1 windows for one coin of the latest scan: by CMC id, or by symbol when it is unique. */
  private async vmcTrace(arg: string): Promise<string> {
    const found = await this.resolveCoin(arg, 'vmc');
    if ('message' in found) return found.message;
    const t = await this.read.assetTrace(found.cmcId);
    if (!t) return `No Tier 1 record for CMC id ${found.cmcId} in the latest scan.`;
    return formatVmcBrief(t as unknown as CoinDetailInput, this.telegram.botUsername);
  }
}
