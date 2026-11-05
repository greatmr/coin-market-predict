import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { slotOf } from "../../src/common/time.js";
import { McpService } from "../../src/mcp/mcp.service.js";
import { PipelineService } from "../../src/pipeline/pipeline.service.js";
import { MAX_DELIVERY_ATTEMPTS, TelegramService } from "../../src/telegram/telegram.service.js";
import { makeApp, resetDb } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof makeApp>> | null = null;
afterEach(async () => {
  await ctx?.app.close();
  ctx = null;
});

// Fake token, assembled so the repository secret scanner does not flag it.
const BOT = ["123456789", "AAAbbbCCCdddEEEfffGGGhhhIIIjjj"].join(":");

function scriptedFetch(script: Array<{ status: number; body: unknown } | Error>, rule?: (chatId: string) => { status: number; body: unknown } | undefined) {
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
  ctx = await makeApp({ TELEGRAM_MODE: "live", TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: "@test_channel" }, sf.f);
  await resetDb(ctx.prisma);
  const tg = ctx.app.get(TelegramService);
  let now = Date.now();
  tg.clock = { now: () => new Date(now) };
  tg.sleep = async (ms) => void (now += ms);
  const advance = (ms: number) => (now += ms);
  await ctx.prisma.provider.create({ data: { id: "fixture", name: "f", accessMethod: "fixture", isLive: false } });
  const run = await ctx.prisma.pipelineRun.create({ data: { kind: "manual", slotTime: slotOf(new Date()), providerId: "fixture", status: "succeeded", startedAt: new Date(), isLiveData: false } });
  return { tg, calls: sf.calls, runId: run.id, advance };
}

describe("Telegram delivery", () => {
  it("suppresses duplicates and sends parts in order", async () => {
    const { tg, calls, runId } = await liveTelegram([{ status: 200, body: { ok: true, result: { message_id: 1 } } }]);
    expect((await tg.prepare(runId, ["part one", "part two"])).prepared).toBe(2);
    expect((await tg.prepare(runId, ["part one", "part two"])).duplicatesSuppressed).toBe(2);
    const r = await tg.deliverPending();
    expect(r.sent).toBe(2);
    expect(calls.map((c) => c.body.text)).toEqual(["part one", "part two"]);
    expect(calls[0]!.body.chat_id).toBe("@test_channel");
    expect((await tg.deliverPending()).sent).toBe(0);
  });

  it("honors 429 retry_after and retries independently of the pipeline", async () => {
    const { tg, calls, runId, advance } = await liveTelegram([
      { status: 429, body: { ok: false, description: "Too Many Requests", parameters: { retry_after: 7 } } },
      { status: 200, body: { ok: true, result: { message_id: 9 } } },
    ]);
    await tg.prepare(runId, ["only part"]);
    expect(await tg.deliverPending()).toMatchObject({ sent: 0, deferred: 1 });
    expect(await tg.deliverPending()).toMatchObject({ sent: 0 }); // not yet due
    advance(8_000);
    expect((await tg.deliverPending()).sent).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("stops on permanent errors and never stores the bot token in errors", async () => {
    const { tg, runId } = await liveTelegram([new Error(`connect ECONNREFUSED https://api.telegram.org/bot${BOT}/sendMessage`)]);
    await tg.prepare(runId, ["x"]);
    await tg.deliverPending();
    const d = await ctx!.prisma.telegramDelivery.findFirstOrThrow();
    expect(d.lastError).not.toContain("AAAbbb");
    expect(d.status).toBe("failed");
  });

  it("does not retry 400 responses", async () => {
    const { tg, runId } = await liveTelegram([{ status: 400, body: { ok: false, description: "Bad Request: can't parse entities" } }]);
    await tg.prepare(runId, ["<b>broken"]);
    expect((await tg.deliverPending()).failed).toBe(1);
    expect((await ctx!.prisma.telegramDelivery.findFirstOrThrow()).attempts).toBe(MAX_DELIVERY_ATTEMPTS);
  });
});

describe("MCP server", () => {
  async function connect(scope: "read" | "write") {
    const server = ctx!.app.get(McpService).createServer(scope);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it("exposes read-only Tier 1 tools, validates inputs and offers no write tool", async () => {
    ctx = await makeApp();
    await resetDb(ctx.prisma);
    await ctx.app.get(PipelineService).runSlot();

    const reader = await connect("read");
    const readTools = (await reader.listTools()).tools.map((t) => t.name);
    expect(readTools).toEqual(expect.arrayContaining(["get_scan_summary", "get_scan_results", "get_asset_trace", "list_batches", "get_mapping_tasks", "get_coverage", "get_snapshots", "list_assets", "get_run_status"]));
    const writer = await connect("write");
    expect((await writer.listTools()).tools.map((t) => t.name).sort()).toEqual([...readTools].sort());
    expect(readTools).not.toContain("publish_signal_report");

    const cov = await reader.callTool({ name: "get_coverage", arguments: {} });
    expect(JSON.stringify(cov.structuredContent)).toMatch(/"isLiveData":false/);
    const queue = await reader.callTool({ name: "get_scan_results", arguments: { sheet: "queue", limit: 5 } });
    expect(JSON.stringify(queue.structuredContent)).toMatch(/"inQueue":true/);
    const trace = await reader.callTool({ name: "get_asset_trace", arguments: { cmcId: 990001 } });
    expect(JSON.stringify(trace.structuredContent)).toMatch(/mean_3d = \(0\.1 \+ 0\.1 \+ 0\.1\) \/ 3 = 0\.1/);
    const bad = await reader.callTool({ name: "get_asset_trace", arguments: { cmcId: "990001" } });
    expect(bad.isError).toBe(true);
  });
});

describe("Telegram bot commands", () => {
  it("serves only the configured chat and answers /help, /report, /run, /status, /vmc", async () => {
    const { TelegramBotService } = await import("../../src/telegram/telegram-bot.service.js");
    const { ReportService } = await import("../../src/telegram/report.service.js");
    const { ReadModelService } = await import("../../src/read-model/read-model.service.js");
    const { TelegramAccessService } = await import("../../src/telegram/access.service.js");
    const { TelegramAdminService } = await import("../../src/telegram/admin.service.js");
    const sf = scriptedFetch([{ status: 200, body: { ok: true, result: { message_id: 1 } } }]);
    ctx = await makeApp({ TELEGRAM_MODE: "live", TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: "186142556" }, sf.f);
    await resetDb(ctx.prisma);
    const tg = ctx.app.get(TelegramService);
    tg.sleep = async () => undefined;
    const bot = new TelegramBotService(ctx.cfg, sf.f, ctx.prisma, tg, ctx.app.get(ReportService), ctx.app.get(ReadModelService), ctx.app.get(PipelineService), ctx.app.get(TelegramAccessService), ctx.app.get(TelegramAdminService));

    expect((await bot.handle("999", "/report", { label: "@guest", isPrivate: true }))[0]).toMatch(/This bot is private/);
    expect((await bot.handle("186142556", "/help"))[0]).toMatch(/\/report — latest hourly report/);
    expect((await bot.handle("186142556", "/report"))[0]).toMatch(/No report yet/);

    const run = await bot.handle("186142556", "/run");
    expect(run[0]).toMatch(/Tier 1 VMC screen/);
    expect(run[0]).toMatch(/TEST DATA/);
    const table = /<pre>([\s\S]*?)<\/pre>/.exec(run.join("\n"));
    expect(table).not.toBeNull();
    expect(table![1]!.split("\n")[0]).toMatch(/^#\s+Coin\s+YES\s+3d\s+7d\s+30d\s+VMC$/);
    for (const line of table![1]!.split("\n")) expect(line.length).toBeLessThanOrEqual(44);
    expect(run.join("\n")).not.toMatch(/\bbuy\b/i);
    expect((await bot.handle("186142556", "/status"))[0]).toMatch(/Recent runs[\s\S]*|Tier 1: batch COMPLETE/);
    expect((await bot.handle("186142556", "/vmc"))[0]).toMatch(/Usage/);
    expect((await bot.handle("186142556", "/vmc 990001"))[0]).toMatch(/YNY[\s\S]*3d mean[\s\S]*2\.00x YES/);
    expect((await bot.handle("186142556", "/vmc TWIN"))[0]).toMatch(/Several coins use the symbol TWIN/);
    expect((await bot.handle("186142556", "/coin"))[0]).toMatch(/Usage: \/coin/);
    const coin = (await bot.handle("186142556", "/coin yny")).join("\n");
    expect(coin).toMatch(/YNY<\/b> · Yes No Yes Labs \(fixture\) · CMC 990001/);
    expect(coin).toMatch(/TEST DATA/);
    expect(coin).toMatch(/3d {2}\s*10\.000%\s+2\.00x {2}YES/);
    expect(coin).toMatch(/Completed UTC days used/);
    expect(coin).toMatch(/LBank Spot pairs<\/b> · VERIFIED/);
    expect(coin).toMatch(/YNY\/USDT · mapping OK · tradable \(feed\)/);
    expect((await bot.handle("186142556", "/coin TWIN"))[0]).toMatch(/Several coins use the symbol TWIN:[\s\S]*\/coin 990005[\s\S]*\/coin 990006/);
    expect((await bot.handle("186142556", "/coin NOPE"))[0]).toMatch(/No coin with the symbol NOPE/);
    expect(sf.calls.every((c) => !c.url.includes("getUpdates"))).toBe(true);
  });
});

describe("Telegram access for other people", () => {
  const OWNER = "186142556";
  const GUEST = "777000111";

  async function botWith(script: Parameters<typeof scriptedFetch>[0], rule?: Parameters<typeof scriptedFetch>[1]) {
    const { TelegramBotService } = await import("../../src/telegram/telegram-bot.service.js");
    const { TelegramAccessService } = await import("../../src/telegram/access.service.js");
    const { TelegramAdminService } = await import("../../src/telegram/admin.service.js");
    const { ReportService } = await import("../../src/telegram/report.service.js");
    const { ReadModelService } = await import("../../src/read-model/read-model.service.js");
    const sf = scriptedFetch(script, rule);
    ctx = await makeApp({ TELEGRAM_MODE: "live", TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: OWNER }, sf.f);
    await resetDb(ctx.prisma);
    const tg = ctx.app.get(TelegramService);
    tg.sleep = async () => undefined;
    const bot = new TelegramBotService(ctx.cfg, sf.f, ctx.prisma, tg, ctx.app.get(ReportService), ctx.app.get(ReadModelService), ctx.app.get(PipelineService), ctx.app.get(TelegramAccessService), ctx.app.get(TelegramAdminService));
    return { bot, tg, calls: sf.calls, access: ctx.app.get(TelegramAccessService) };
  }
  const ok = { status: 200, body: { ok: true, result: { message_id: 1 } } };

  it("queues a newcomer, notifies the owner once, and only the owner can approve", async () => {
    const { bot, calls, access } = await botWith([ok]);
    const reply = await bot.handle(GUEST, "/report", { label: "@guest", isPrivate: true });
    expect(reply[0]).toMatch(/request was sent to the owner/);
    const toOwner = calls.filter((c) => c.body.chat_id === OWNER);
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0]!.body.text).toContain(`/approve ${GUEST}`);

    // A second message does not notify the owner again and gets no data.
    expect((await bot.handle(GUEST, "/report", { label: "@guest", isPrivate: true }))[0]).toMatch(/waiting for the owner/);
    expect(calls.filter((c) => c.body.chat_id === OWNER)).toHaveLength(1);

    // The guest cannot approve themselves or use owner commands.
    expect((await bot.handle(GUEST, `/approve ${GUEST}`))[0]).toMatch(/waiting for the owner/);
    expect(await access.role(GUEST)).toBe("pending");

    expect((await bot.handle(OWNER, `/approve ${GUEST}`))[0]).toMatch(/Approved/);
    expect(await access.role(GUEST)).toBe("member");
    expect(calls.some((c) => c.body.chat_id === GUEST && /Access granted/.test(c.body.text))).toBe(true);

    // Members get read-only commands but not /run or access management.
    expect((await bot.handle(GUEST, "/run"))[0]).toMatch(/Only the owner/);
    expect((await bot.handle(GUEST, "/users"))[0]).not.toMatch(/Members/);
    expect((await bot.handle(GUEST, "/help"))[0]).not.toMatch(/\/run — run the pipeline/);
  });

  it("ignores denied chats, groups, and bad ids", async () => {
    const { bot, calls, access } = await botWith([ok]);
    expect(await bot.handle("-100123456", "/report", { label: "group", isPrivate: false })).toEqual([]);
    await bot.handle(GUEST, "hi", { label: "@guest", isPrivate: true });
    await bot.handle(OWNER, `/deny ${GUEST}`);
    const before = calls.length;
    expect(await bot.handle(GUEST, "/report", { label: "@guest", isPrivate: true })).toEqual([]);
    expect(calls).toHaveLength(before);
    expect(await access.role(GUEST)).toBe("denied");
    expect((await bot.handle(OWNER, "/approve abc"))[0]).toMatch(/Usage/);
    expect((await bot.handle(OWNER, `/approve ${OWNER}`))[0]).toMatch(/owner/);
  });

  it("sends reports to the owner and members, and one blocked member does not hold back the rest", async () => {
    const { bot, tg, calls, access } = await botWith([ok], (chat) => (chat === "555000111" ? { status: 403, body: { ok: false, description: "Forbidden: bot was blocked by the user" } } : undefined));
    await access.approve("555000111"); // will be rejected by Telegram (blocked)
    await access.approve("555000222");
    await ctx!.prisma.provider.create({ data: { id: "fixture", name: "f", accessMethod: "fixture", isLive: false } });
    const run = await ctx!.prisma.pipelineRun.create({ data: { kind: "manual", slotTime: slotOf(new Date()), providerId: "fixture", status: "succeeded", startedAt: new Date(), isLiveData: false } });
    expect((await tg.prepare(run.id, ["part one", "part two"])).prepared).toBe(6);
    // Re-preparing the same report is still idempotent per recipient.
    expect((await tg.prepare(run.id, ["part one", "part two"])).duplicatesSuppressed).toBe(6);

    await tg.deliverPending();
    const sentTo = (id: string) => calls.filter((c) => c.body.chat_id === id).map((c) => c.body.text);
    expect(sentTo("555000111")).toEqual(["part one"]); // rejected once; its second part is never attempted
    expect(sentTo("555000222")).toEqual(["part one", "part two"]);
    expect(sentTo(OWNER)).toEqual(["part one", "part two"]);
    void bot;
  });

  it("removes a member so later reports no longer go to them", async () => {
    const { bot, tg, calls, access } = await botWith([ok]);
    await access.approve(GUEST);
    expect((await bot.handle(OWNER, `/remove ${GUEST}`))[0]).toMatch(/Removed/);
    await ctx!.prisma.provider.create({ data: { id: "fixture", name: "f", accessMethod: "fixture", isLive: false } });
    const run = await ctx!.prisma.pipelineRun.create({ data: { kind: "manual", slotTime: slotOf(new Date()), providerId: "fixture", status: "succeeded", startedAt: new Date(), isLiveData: false } });
    await tg.prepare(run.id, ["only"]);
    await tg.deliverPending();
    expect(calls.some((c) => c.body.chat_id === GUEST && c.body.text === "only")).toBe(false);
  });
});

describe("Telegram outage recovery and manual sending", () => {
  const OWNER = "186142556";
  const MEMBER = "555000222";
  const okStep = { status: 200, body: { ok: true, result: { message_id: 1 } } };

  async function setup(script: Parameters<typeof scriptedFetch>[0]) {
    const { TelegramAccessService } = await import("../../src/telegram/access.service.js");
    const { TelegramAdminService } = await import("../../src/telegram/admin.service.js");
    const sf = scriptedFetch(script);
    ctx = await makeApp({ TELEGRAM_MODE: "live", TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: OWNER }, sf.f);
    await resetDb(ctx.prisma);
    const tg = ctx.app.get(TelegramService);
    let now = Date.now();
    tg.clock = { now: () => new Date(now) };
    tg.sleep = async (ms) => void (now += ms);
    const advance = (ms: number) => (now += ms);
    await ctx.app.get(TelegramAccessService).approve(MEMBER);
    await ctx.prisma.provider.create({ data: { id: "fixture", name: "f", accessMethod: "fixture", isLive: false } });
    const slotTime = slotOf(new Date());
    const run = await ctx.prisma.pipelineRun.create({ data: { kind: "hourly", slotTime, providerId: "fixture", status: "partial", startedAt: new Date(), isLiveData: false } });
    // A scanned (empty) batch behind the run, so a fresh copy of its report can be built.
    const batch = await ctx.prisma.crawlBatch.create({ data: { providerId: "fixture", slotTime, pipelineRunId: run.id, isLive: false, startedAt: new Date(), finishedAt: new Date(), crawledAt: new Date(), status: "COMPLETE", collected: 0, fieldCounts: {} } });
    await ctx.prisma.pipelineRun.update({ where: { id: run.id }, data: { metrics: { batchId: batch.id } } });
    await ctx.prisma.scanRun.create({ data: { batchId: batch.id, providerId: "fixture", isLive: false, rulesetVersion: "vmc-tier1-1", configVersion: "test", overridesVersion: "none", startedAt: new Date(), finishedAt: new Date(), status: "succeeded", asOf: new Date(), queueStatus: "EMPTY", counts: { assets: 0, eligible: 0, needsReview: 0, excluded: 0, queue: 0 } } });
    return { tg, admin: ctx.app.get(TelegramAdminService), calls: sf.calls, script, runId: run.id, advance };
  }
  const rowFor = (runId: string, chatId: string) => ctx!.prisma.telegramDelivery.findFirstOrThrow({ where: { runId, chatId, mode: "live" } });

  it("keeps retrying through a network outage past 6 attempts, then delivers once it is back", async () => {
    const script: Parameters<typeof scriptedFetch>[0] = [new Error("fetch failed")];
    const { tg, runId, advance, calls } = await setup(script);
    await tg.prepare(runId, ["report"]);
    for (let i = 0; i < 20; i++) {
      await tg.deliverPending();
      advance(16 * 60_000); // longer than the backoff cap, so each cycle retries
    }
    const stuck = await rowFor(runId, OWNER);
    expect(stuck.status).toBe("failed");
    expect(stuck.attempts).toBeGreaterThan(MAX_DELIVERY_ATTEMPTS); // the old rule gave up here
    expect(stuck.nextAttemptAt).not.toBeNull(); // still scheduled
    script.splice(0, script.length, okStep); // network is back
    await tg.deliverPending();
    expect((await rowFor(runId, OWNER)).status).toBe("sent");
    expect(calls.at(-1)!.body.text).toBe("report");
  });

  it("gives up on a network outage only after 24 hours", async () => {
    const { tg, runId, advance } = await setup([new Error("fetch failed")]);
    await tg.prepare(runId, ["report"]);
    await tg.deliverPending();
    advance(25 * 3_600_000);
    await ctx!.prisma.telegramDelivery.updateMany({ where: { runId }, data: { nextAttemptAt: new Date(0) } });
    await tg.deliverPending();
    const r = await rowFor(runId, OWNER);
    expect(r.status).toBe("failed");
    expect(r.nextAttemptAt).toBeNull(); // given up; only a manual retry revives it
  });

  it("lists unsent reports per person and lets the owner retry or send a fresh copy", async () => {
    const { tg, admin, runId, calls } = await setup([okStep]);
    await tg.prepare(runId, ["part one"]);
    // The owner's copy arrived; the member's was given up on during an outage.
    await ctx!.prisma.telegramDelivery.updateMany({ where: { runId, chatId: OWNER }, data: { status: "sent", attempts: 1, sentAt: new Date() } });
    await ctx!.prisma.telegramDelivery.updateMany({ where: { runId, chatId: MEMBER }, data: { status: "failed", attempts: 7, lastError: "TypeError: fetch failed", nextAttemptAt: null } });

    const miss = await admin.missing(6);
    expect(miss).toHaveLength(1);
    expect(miss[0]).toMatchObject({ chatId: MEMBER, state: "gave_up", lastError: "TypeError: fetch failed", partsSent: 0, partCount: 1 });

    const r = await admin.retry({});
    expect(r.requeued).toBe(1);
    expect(calls.filter((c) => c.body.chat_id === MEMBER && c.body.text === "part one")).toHaveLength(1);
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
    expect((await admin.sendReport({ runId, chatIds: ["999999999"] })).queued).toBe(0);
    expect(calls).toHaveLength(n);
  });

  it("does not call a report missed for someone approved after it was created", async () => {
    const { admin, runId } = await setup([okStep]);
    await ctx!.prisma.pipelineRun.update({ where: { id: runId }, data: { finishedAt: new Date(Date.now() - 3_600_000) } });
    expect((await admin.missing(6)).map((m) => m.chatId)).toEqual([OWNER]);
  });

  it("flags everyone as not queued when a finished run has no deliveries, and sends on request", async () => {
    const { admin, runId, calls } = await setup([okStep]);
    // The member was approved "now", i.e. before this run is considered finished.
    await ctx!.prisma.pipelineRun.update({ where: { id: runId }, data: { finishedAt: new Date(Date.now() + 60_000) } });
    expect((await admin.missing(6)).map((m) => [m.chatId, m.state]).sort()).toEqual([[OWNER, "not_queued"], [MEMBER, "not_queued"]]);
    // retry() has nothing to requeue for "not queued"; sendReport creates the copies.
    expect((await admin.retry({})).requeued).toBe(0);
    const r = await admin.sendReport({ runId });
    expect(r.queued).toBeGreaterThan(0);
    expect(new Set(calls.map((c) => c.body.chat_id))).toEqual(new Set([OWNER, MEMBER]));
    expect(await admin.missing(6)).toEqual([]);
  });
});
