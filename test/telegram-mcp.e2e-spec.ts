import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { slotOf } from '../src/common/utils/time.js';
import { AppStateService } from '../src/modules/app-state/app-state.service.js';
import { CrawlBatch } from '../src/modules/ingestion/entities/crawl-batch.entity.js';
import { McpService } from '../src/modules/mcp/mcp.service.js';
import { PipelineRun } from '../src/modules/pipeline/entities/pipeline-run.entity.js';
import { PipelineService } from '../src/modules/pipeline/pipeline.service.js';
import { ScanRun } from '../src/modules/scan/entities/scan-run.entity.js';
import { Provider } from '../src/modules/sources/entities/provider.entity.js';
import { TelegramDelivery } from '../src/modules/telegram/entities/telegram-delivery.entity.js';
import {
  MAX_DELIVERY_ATTEMPTS,
  TelegramService,
} from '../src/modules/telegram/telegram.service.js';

import { makeApp, resetDb } from './utils/helpers.js';

let ctx: Awaited<ReturnType<typeof makeApp>> | null = null;
afterEach(async () => {
  await ctx?.app.close();
  ctx = null;
});

/** A provider row and a pipeline run to attach deliveries to. */
async function seedRun(c: Awaited<ReturnType<typeof makeApp>>, run: Partial<PipelineRun> = {}) {
  await c
    .repo(Provider)
    .insert({ id: 'fixture', name: 'f', accessMethod: 'fixture', isLive: false });
  const runs = c.repo(PipelineRun);
  return runs.save(
    runs.create({
      kind: 'manual',
      slotTime: slotOf(new Date()),
      providerId: 'fixture',
      status: 'succeeded',
      startedAt: new Date(),
      isLiveData: false,
      ...run,
    }),
  );
}
const deliveries = () => ctx!.repo(TelegramDelivery);

// Fake token, assembled so the repository secret scanner does not flag it.
const BOT = ['123456789', 'AAAbbbCCCdddEEEfffGGGhhhIIIjjj'].join(':');

function scriptedFetch(
  script: Array<{ status: number; body: unknown } | Error>,
  rule?: (chatId: string) => { status: number; body: unknown } | undefined,
) {
  const calls: Array<{ url: string; body: { chat_id: string; text: string } }> = [];
  let i = 0;
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const forced = rule?.(String(calls.at(-1)!.body.chat_id));
    if (forced) return new Response(JSON.stringify(forced.body), { status: forced.status });
    const step = script[Math.min(i++, script.length - 1)]!;
    if (step instanceof Error) throw step;
    return new Response(JSON.stringify(step.body), { status: step.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

async function liveTelegram(script: Parameters<typeof scriptedFetch>[0]) {
  const sf = scriptedFetch(script);
  ctx = await makeApp(
    { TELEGRAM_MODE: 'live', TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: '@test_channel' },
    sf.f,
  );
  await resetDb(ctx.db);
  const tg = ctx.app.get(TelegramService);
  let now = Date.now();
  tg.clock = { now: () => new Date(now) };
  tg.sleep = async (ms) => void (now += ms);
  const advance = (ms: number) => (now += ms);
  const run = await seedRun(ctx);
  return { tg, calls: sf.calls, runId: run.id, advance };
}

describe('Telegram delivery', () => {
  it('suppresses duplicates and sends parts in order', async () => {
    const { tg, calls, runId } = await liveTelegram([
      { status: 200, body: { ok: true, result: { message_id: 1 } } },
    ]);
    expect((await tg.prepare(runId, ['part one', 'part two'])).prepared).toBe(2);
    expect((await tg.prepare(runId, ['part one', 'part two'])).duplicatesSuppressed).toBe(2);
    const r = await tg.deliverPending();
    expect(r.sent).toBe(2);
    expect(calls.map((c) => c.body.text)).toEqual(['part one', 'part two']);
    expect(calls[0]!.body.chat_id).toBe('@test_channel');
    expect((await tg.deliverPending()).sent).toBe(0);
  });

  it('honors 429 retry_after and retries independently of the pipeline', async () => {
    const { tg, calls, runId, advance } = await liveTelegram([
      {
        status: 429,
        body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 7 } },
      },
      { status: 200, body: { ok: true, result: { message_id: 9 } } },
    ]);
    await tg.prepare(runId, ['only part']);
    expect(await tg.deliverPending()).toMatchObject({ sent: 0, deferred: 1 });
    expect(await tg.deliverPending()).toMatchObject({ sent: 0 }); // not yet due
    advance(8_000);
    expect((await tg.deliverPending()).sent).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('stops on permanent errors and never stores the bot token in errors', async () => {
    const { tg, runId } = await liveTelegram([
      new Error(`connect ECONNREFUSED https://api.telegram.org/bot${BOT}/sendMessage`),
    ]);
    await tg.prepare(runId, ['x']);
    await tg.deliverPending();
    const [d] = await deliveries().find({ take: 1 });
    expect(d!.lastError).not.toContain('AAAbbb');
    expect(d!.status).toBe('failed');
  });

  it('does not retry 400 responses', async () => {
    const { tg, runId } = await liveTelegram([
      { status: 400, body: { ok: false, description: "Bad Request: can't parse entities" } },
    ]);
    await tg.prepare(runId, ['<b>broken']);
    expect((await tg.deliverPending()).failed).toBe(1);
    expect((await deliveries().find({ take: 1 }))[0]!.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
  });
});

describe('MCP server', () => {
  async function connect(scope: 'read' | 'write') {
    const server = ctx!.app.get(McpService).createServer(scope);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it('exposes read-only Tier 1 tools, validates inputs and offers no write tool', async () => {
    ctx = await makeApp();
    await resetDb(ctx.db);
    await ctx.app.get(PipelineService).runSlot();

    const reader = await connect('read');
    const readTools = (await reader.listTools()).tools.map((t) => t.name);
    expect(readTools).toEqual(
      expect.arrayContaining([
        'get_scan_summary',
        'get_scan_results',
        'get_asset_trace',
        'list_batches',
        'get_mapping_tasks',
        'get_coverage',
        'get_snapshots',
        'list_assets',
        'get_run_status',
        'get_forward_test_summary',
        'get_forward_events',
        'get_forward_event',
      ]),
    );
    const writer = await connect('write');
    expect((await writer.listTools()).tools.map((t) => t.name).sort()).toEqual(
      [...readTools].sort(),
    );
    expect(readTools).not.toContain('publish_signal_report');

    const cov = await reader.callTool({ name: 'get_coverage', arguments: {} });
    expect(JSON.stringify(cov.structuredContent)).toMatch(/"isLiveData":false/);
    const queue = await reader.callTool({
      name: 'get_scan_results',
      arguments: { sheet: 'queue', limit: 5 },
    });
    expect(JSON.stringify(queue.structuredContent)).toMatch(/"inQueue":true/);
    const trace = await reader.callTool({ name: 'get_asset_trace', arguments: { cmcId: 990001 } });
    expect(JSON.stringify(trace.structuredContent)).toMatch(
      /mean_3d = \(0\.1 \+ 0\.1 \+ 0\.1\) \/ 3 = 0\.1/,
    );
    const bad = await reader.callTool({ name: 'get_asset_trace', arguments: { cmcId: '990001' } });
    expect(bad.isError).toBe(true);

    // Forward test: the run's published queue became OPEN events (read-only views of them).
    const fwd = await reader.callTool({ name: 'get_forward_test_summary', arguments: {} });
    expect(JSON.stringify(fwd.structuredContent)).toMatch(/"rulesVersion":"star-forward-1"/);
    const events = await reader.callTool({
      name: 'get_forward_events',
      arguments: { view: 'active', limit: 3 },
    });
    const rows = (events.structuredContent as { data: { rows: Array<{ eventId: string }> } }).data
      .rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(events.structuredContent)).toMatch(/"status":"OPEN"/);
    const one = await reader.callTool({
      name: 'get_forward_event',
      arguments: { eventId: rows[0]!.eventId },
    });
    expect(JSON.stringify(one.structuredContent)).toMatch(/"scanSnapshot"/);
  });
});

describe('Telegram bot commands', () => {
  it('serves only the configured chat and answers /help, /report, /run, /status, /vmc', async () => {
    const { TelegramBotService } = await import('../src/modules/telegram/telegram-bot.service.js');
    const { ReportService } = await import('../src/modules/telegram/report.service.js');
    const { ReadModelService } = await import('../src/modules/read-model/read-model.service.js');
    const { TelegramAccessService } = await import('../src/modules/telegram/access.service.js');
    const { TelegramAdminService } = await import('../src/modules/telegram/admin.service.js');
    const sf = scriptedFetch([{ status: 200, body: { ok: true, result: { message_id: 1 } } }]);
    ctx = await makeApp(
      { TELEGRAM_MODE: 'live', TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: '186142556' },
      sf.f,
    );
    await resetDb(ctx.db);
    const tg = ctx.app.get(TelegramService);
    tg.sleep = async () => undefined;
    const bot = new TelegramBotService(
      ctx.cfg,
      sf.f,
      ctx.app.get(AppStateService),
      tg,
      ctx.app.get(ReportService),
      ctx.app.get(ReadModelService),
      ctx.app.get(PipelineService),
      ctx.app.get(TelegramAccessService),
      ctx.app.get(TelegramAdminService),
    );

    expect((await bot.handle('999', '/report', { label: '@guest', isPrivate: true }))[0]).toMatch(
      /This bot is private/,
    );
    // A stranger tapping a forwarded coin link still meets the access gate, not the coin.
    expect(
      (await bot.handle('777', '/start coin_990001', { label: '@stranger', isPrivate: true }))[0],
    ).toMatch(/This bot is private/);
    expect((await bot.handle('186142556', '/help'))[0]).toMatch(
      /\/report — latest hourly report[\s\S]*\/coin SIGN — everything about one coin/,
    );
    expect((await bot.handle('186142556', '/report'))[0]).toMatch(/No report yet/);

    const run = await bot.handle('186142556', '/run');
    expect(run[0]).toMatch(/VMC screen · /);
    expect(run[0]).toMatch(/Test data/);
    // Each queued coin is a two-line card with a tappable /coin_<id> command.
    expect(run[0]).toMatch(
      /<b>1\. [A-Z0-9]+<\/b> {2}[★☆]{3} {2}VMC <b>[\d.]+%<\/b> {2}\/coin_\d+\n└ 3d /,
    );
    expect(run[0]).not.toContain('<pre>');
    expect(run.join('\n')).not.toMatch(/\bbuy\b/i);
    expect((await bot.handle('186142556', '/status'))[0]).toMatch(
      /Status[\s\S]*Test data[\s\S]*Latest scan<\/b> · batch complete[\s\S]*🎯 Queue \d+[\s\S]*Recent runs[\s\S]*manual · (succeeded|partial)/,
    );
    expect((await bot.handle('186142556', '/vmc'))[0]).toMatch(/Usage/);
    expect((await bot.handle('186142556', '/vmc 990001'))[0]).toMatch(
      /YNY[\s\S]*3d +10\.0% {2}█+░* +2\.00× YES[\s\S]*\/coin_990001/,
    );
    expect((await bot.handle('186142556', '/vmc TWIN'))[0]).toMatch(
      /Several coins use the symbol TWIN/,
    );
    expect((await bot.handle('186142556', '/coin'))[0]).toMatch(/Usage: \/coin/);
    const coin = (await bot.handle('186142556', '/coin yny')).join('\n');
    expect(coin).toMatch(/YNY<\/b> · Yes No Yes Labs \(fixture\)/);
    expect(coin).toMatch(/CMC 990001/);
    expect(coin).toMatch(/Test data/);
    expect(coin).toMatch(/3d +10\.0% {2}█+░* +2\.00× YES/);
    expect(coin).toMatch(/<blockquote expandable><b>Daily rows used<\/b>/);
    expect(coin).toMatch(/LBank<\/b> · verified/);
    expect(coin).toMatch(/YNY\/USDT · tradable \(feed\)/);
    // A tapped /coin_<id> from the report opens the same detail.
    expect((await bot.handle('186142556', '/coin_990001')).join('\n')).toBe(coin);
    expect((await bot.handle('186142556', '/vmc_990001'))[0]).toMatch(/2\.00× YES/);
    // A tapped coin name is a t.me deep link: Telegram sends "/start coin_<id>".
    expect((await bot.handle('186142556', '/start coin_990001')).join('\n')).toBe(coin);
    expect((await bot.handle('186142556', '/start vmc_990001'))[0]).toMatch(/2\.00× YES/);
    expect((await bot.handle('186142556', '/start'))[0]).toMatch(/\/report — latest hourly report/);
    expect((await bot.handle('186142556', '/coin TWIN'))[0]).toMatch(
      /Several coins use the symbol TWIN\. Tap one:[\s\S]*\/coin_990005[\s\S]*\/coin_990006/,
    );
    expect((await bot.handle('186142556', '/coin NOPE'))[0]).toMatch(
      /No coin with the symbol NOPE/,
    );
    expect(sf.calls.every((c) => !c.url.includes('getUpdates'))).toBe(true);
  });
});

describe('Telegram access for other people', () => {
  const OWNER = '186142556';
  const GUEST = '777000111';

  async function botWith(
    script: Parameters<typeof scriptedFetch>[0],
    rule?: Parameters<typeof scriptedFetch>[1],
  ) {
    const { TelegramBotService } = await import('../src/modules/telegram/telegram-bot.service.js');
    const { TelegramAccessService } = await import('../src/modules/telegram/access.service.js');
    const { TelegramAdminService } = await import('../src/modules/telegram/admin.service.js');
    const { ReportService } = await import('../src/modules/telegram/report.service.js');
    const { ReadModelService } = await import('../src/modules/read-model/read-model.service.js');
    const sf = scriptedFetch(script, rule);
    ctx = await makeApp(
      { TELEGRAM_MODE: 'live', TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: OWNER },
      sf.f,
    );
    await resetDb(ctx.db);
    const tg = ctx.app.get(TelegramService);
    tg.sleep = async () => undefined;
    const bot = new TelegramBotService(
      ctx.cfg,
      sf.f,
      ctx.app.get(AppStateService),
      tg,
      ctx.app.get(ReportService),
      ctx.app.get(ReadModelService),
      ctx.app.get(PipelineService),
      ctx.app.get(TelegramAccessService),
      ctx.app.get(TelegramAdminService),
    );
    return { bot, tg, calls: sf.calls, access: ctx.app.get(TelegramAccessService) };
  }
  const ok = { status: 200, body: { ok: true, result: { message_id: 1 } } };

  it('queues a newcomer, notifies the owner once, and only the owner can approve', async () => {
    const { bot, calls, access } = await botWith([ok]);
    const reply = await bot.handle(GUEST, '/report', { label: '@guest', isPrivate: true });
    expect(reply[0]).toMatch(/request was sent to the owner/);
    const toOwner = calls.filter((c) => c.body.chat_id === OWNER);
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0]!.body.text).toContain(`/approve ${GUEST}`);

    // A second message does not notify the owner again and gets no data.
    expect((await bot.handle(GUEST, '/report', { label: '@guest', isPrivate: true }))[0]).toMatch(
      /waiting for the owner/,
    );
    expect(calls.filter((c) => c.body.chat_id === OWNER)).toHaveLength(1);

    // The guest cannot approve themselves or use owner commands.
    expect((await bot.handle(GUEST, `/approve ${GUEST}`))[0]).toMatch(/waiting for the owner/);
    expect(await access.role(GUEST)).toBe('pending');

    expect((await bot.handle(OWNER, `/approve ${GUEST}`))[0]).toMatch(/Approved/);
    expect(await access.role(GUEST)).toBe('member');
    expect(calls.some((c) => c.body.chat_id === GUEST && /Access granted/.test(c.body.text))).toBe(
      true,
    );

    // Members get read-only commands but not /run or access management.
    expect((await bot.handle(GUEST, '/run'))[0]).toMatch(/Only the owner/);
    expect((await bot.handle(GUEST, '/users'))[0]).not.toMatch(/Members/);
    expect((await bot.handle(GUEST, '/help'))[0]).not.toMatch(/\/run — run the pipeline/);
  });

  it('ignores denied chats, groups, and bad ids', async () => {
    const { bot, calls, access } = await botWith([ok]);
    expect(await bot.handle('-100123456', '/report', { label: 'group', isPrivate: false })).toEqual(
      [],
    );
    await bot.handle(GUEST, 'hi', { label: '@guest', isPrivate: true });
    await bot.handle(OWNER, `/deny ${GUEST}`);
    const before = calls.length;
    expect(await bot.handle(GUEST, '/report', { label: '@guest', isPrivate: true })).toEqual([]);
    expect(calls).toHaveLength(before);
    expect(await access.role(GUEST)).toBe('denied');
    expect((await bot.handle(OWNER, '/approve abc'))[0]).toMatch(/Usage/);
    expect((await bot.handle(OWNER, `/approve ${OWNER}`))[0]).toMatch(/owner/);
  });

  it('sends reports to the owner and members, and one blocked member does not hold back the rest', async () => {
    const { bot, tg, calls, access } = await botWith([ok], (chat) =>
      chat === '555000111'
        ? {
            status: 403,
            body: { ok: false, description: 'Forbidden: bot was blocked by the user' },
          }
        : undefined,
    );
    await access.approve('555000111'); // will be rejected by Telegram (blocked)
    await access.approve('555000222');
    const run = await seedRun(ctx!);
    expect((await tg.prepare(run.id, ['part one', 'part two'])).prepared).toBe(6);
    // Re-preparing the same report is still idempotent per recipient.
    expect((await tg.prepare(run.id, ['part one', 'part two'])).duplicatesSuppressed).toBe(6);

    await tg.deliverPending();
    const sentTo = (id: string) =>
      calls.filter((c) => c.body.chat_id === id).map((c) => c.body.text);
    expect(sentTo('555000111')).toEqual(['part one']); // rejected once; its second part is never attempted
    expect(sentTo('555000222')).toEqual(['part one', 'part two']);
    expect(sentTo(OWNER)).toEqual(['part one', 'part two']);
    void bot;
  });

  it('removes a member so later reports no longer go to them', async () => {
    const { bot, tg, calls, access } = await botWith([ok]);
    await access.approve(GUEST);
    expect((await bot.handle(OWNER, `/remove ${GUEST}`))[0]).toMatch(/Removed/);
    const run = await seedRun(ctx!);
    await tg.prepare(run.id, ['only']);
    await tg.deliverPending();
    expect(calls.some((c) => c.body.chat_id === GUEST && c.body.text === 'only')).toBe(false);
  });
});

describe('Telegram outage recovery and manual sending', () => {
  const OWNER = '186142556';
  const MEMBER = '555000222';
  const okStep = { status: 200, body: { ok: true, result: { message_id: 1 } } };

  async function setup(script: Parameters<typeof scriptedFetch>[0]) {
    const { TelegramAccessService } = await import('../src/modules/telegram/access.service.js');
    const { TelegramAdminService } = await import('../src/modules/telegram/admin.service.js');
    const sf = scriptedFetch(script);
    ctx = await makeApp(
      { TELEGRAM_MODE: 'live', TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: OWNER },
      sf.f,
    );
    await resetDb(ctx.db);
    const tg = ctx.app.get(TelegramService);
    let now = Date.now();
    tg.clock = { now: () => new Date(now) };
    tg.sleep = async (ms) => void (now += ms);
    const advance = (ms: number) => (now += ms);
    await ctx.app.get(TelegramAccessService).approve(MEMBER);
    const slotTime = slotOf(new Date());
    const run = await seedRun(ctx, { kind: 'hourly', slotTime, status: 'partial' });
    // A scanned (empty) batch behind the run, so a fresh copy of its report can be built.
    const batches = ctx.repo(CrawlBatch);
    const batch = await batches.save(
      batches.create({
        providerId: 'fixture',
        slotTime,
        pipelineRunId: run.id,
        isLive: false,
        startedAt: new Date(),
        finishedAt: new Date(),
        crawledAt: new Date(),
        status: 'COMPLETE',
        collected: 0,
        fieldCounts: {},
      }),
    );
    await ctx.repo(PipelineRun).update({ id: run.id }, { metrics: { batchId: batch.id } as never });
    await ctx.repo(ScanRun).insert({
      batchId: batch.id,
      providerId: 'fixture',
      isLive: false,
      rulesetVersion: 'vmc-tier1-1',
      configVersion: 'test',
      overridesVersion: 'none',
      startedAt: new Date(),
      finishedAt: new Date(),
      status: 'succeeded',
      asOf: new Date(),
      queueStatus: 'EMPTY',
      counts: { assets: 0, eligible: 0, needsReview: 0, excluded: 0, queue: 0 } as never,
    });
    return {
      tg,
      admin: ctx.app.get(TelegramAdminService),
      calls: sf.calls,
      script,
      runId: run.id,
      advance,
    };
  }
  const rowFor = (runId: string, chatId: string) =>
    deliveries().findOneByOrFail({ runId, chatId, mode: 'live' });

  it('keeps retrying through a network outage past 6 attempts, then delivers once it is back', async () => {
    const script: Parameters<typeof scriptedFetch>[0] = [new Error('fetch failed')];
    const { tg, runId, advance, calls } = await setup(script);
    await tg.prepare(runId, ['report']);
    for (let i = 0; i < 20; i++) {
      await tg.deliverPending();
      advance(16 * 60_000); // longer than the backoff cap, so each cycle retries
    }
    const stuck = await rowFor(runId, OWNER);
    expect(stuck.status).toBe('failed');
    expect(stuck.attempts).toBeGreaterThan(MAX_DELIVERY_ATTEMPTS); // the old rule gave up here
    expect(stuck.nextAttemptAt).not.toBeNull(); // still scheduled
    script.splice(0, script.length, okStep); // network is back
    await tg.deliverPending();
    expect((await rowFor(runId, OWNER)).status).toBe('sent');
    expect(calls.at(-1)!.body.text).toBe('report');
  });

  it('gives up on a network outage only after 24 hours', async () => {
    const { tg, runId, advance } = await setup([new Error('fetch failed')]);
    await tg.prepare(runId, ['report']);
    await tg.deliverPending();
    advance(25 * 3_600_000);
    await deliveries().update({ runId }, { nextAttemptAt: new Date(0) });
    await tg.deliverPending();
    const r = await rowFor(runId, OWNER);
    expect(r.status).toBe('failed');
    expect(r.nextAttemptAt).toBeNull(); // given up; only a manual retry revives it
  });

  it('lists unsent reports per person and lets the owner retry or send a fresh copy', async () => {
    const { tg, admin, runId, calls } = await setup([okStep]);
    await tg.prepare(runId, ['part one']);
    // The owner's copy arrived; the member's was given up on during an outage.
    await deliveries().update(
      { runId, chatId: OWNER },
      { status: 'sent', attempts: 1, sentAt: new Date() },
    );
    await deliveries().update(
      { runId, chatId: MEMBER },
      { status: 'failed', attempts: 7, lastError: 'TypeError: fetch failed', nextAttemptAt: null },
    );

    const miss = await admin.missing(6);
    expect(miss).toHaveLength(1);
    expect(miss[0]).toMatchObject({
      chatId: MEMBER,
      state: 'gave_up',
      lastError: 'TypeError: fetch failed',
      partsSent: 0,
      partCount: 1,
    });

    const r = await admin.retry({});
    expect(r.requeued).toBe(1);
    expect(
      calls.filter((c) => c.body.chat_id === MEMBER && c.body.text === 'part one'),
    ).toHaveLength(1);
    expect(await admin.missing(6)).toHaveLength(0);

    // A fresh manual copy goes only to the chosen person, even though the report was already delivered.
    const before = calls.length;
    const sent = await admin.sendReport({ runId, chatIds: [MEMBER] });
    expect(sent.queued).toBeGreaterThan(0);
    const after = calls.slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((c) => c.body.chat_id === MEMBER)).toBe(true);
    // Unknown chats are never targets.
    const n = calls.length;
    expect((await admin.sendReport({ runId, chatIds: ['999999999'] })).queued).toBe(0);
    expect(calls).toHaveLength(n);
  });

  it('does not call a report missed for someone approved after it was created', async () => {
    const { admin, runId } = await setup([okStep]);
    await ctx!
      .repo(PipelineRun)
      .update({ id: runId }, { finishedAt: new Date(Date.now() - 3_600_000) });
    expect((await admin.missing(6)).map((m) => m.chatId)).toEqual([OWNER]);
  });

  it('flags everyone as not queued when a finished run has no deliveries, and sends on request', async () => {
    const { admin, runId, calls } = await setup([okStep]);
    // The member was approved "now", i.e. before this run is considered finished.
    await ctx!
      .repo(PipelineRun)
      .update({ id: runId }, { finishedAt: new Date(Date.now() + 60_000) });
    expect((await admin.missing(6)).map((m) => [m.chatId, m.state]).sort()).toEqual([
      [OWNER, 'not_queued'],
      [MEMBER, 'not_queued'],
    ]);
    // retry() has nothing to requeue for "not queued"; sendReport creates the copies.
    expect((await admin.retry({})).requeued).toBe(0);
    const r = await admin.sendReport({ runId });
    expect(r.queued).toBeGreaterThan(0);
    expect(new Set(calls.map((c) => c.body.chat_id))).toEqual(new Set([OWNER, MEMBER]));
    expect(await admin.missing(6)).toEqual([]);
  });
});
