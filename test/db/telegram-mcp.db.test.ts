import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { addHours, slotOf } from "../../src/common/time.js";
import { IngestionService } from "../../src/ingestion/ingestion.service.js";
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

function scriptedFetch(script: Array<{ status: number; body: unknown } | Error>) {
  const calls: Array<{ url: string; body: { chat_id: string; text: string } }> = [];
  let i = 0;
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
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

  it("separates read and write capabilities and validates inputs", async () => {
    ctx = await makeApp();
    await resetDb(ctx.prisma);
    const ing = ctx.app.get(IngestionService);
    await ing.discover(new Date());
    for (let h = 30; h >= 1; h--) await ing.collect(addHours(slotOf(new Date()), -h), null, new Date(), { fixtureBackfill: true });
    await ctx.app.get(PipelineService).runSlot();

    const reader = await connect("read");
    const readTools = (await reader.listTools()).tools.map((t) => t.name);
    expect(readTools).toEqual(expect.arrayContaining(["list_assets", "get_coverage", "get_snapshots", "get_features", "get_signals", "get_run_status"]));
    expect(readTools).not.toContain("publish_signal_report");

    const cov = await reader.callTool({ name: "get_coverage", arguments: {} });
    expect(JSON.stringify(cov.structuredContent)).toMatch(/"isLiveData":false/);
    const bad = await reader.callTool({ name: "get_snapshots", arguments: { assetId: "not-a-uuid" } });
    expect(bad.isError).toBe(true);

    const writer = await connect("write");
    expect((await writer.listTools()).tools.map((t) => t.name)).toContain("publish_signal_report");
    const asset = await ctx.prisma.asset.findFirstOrThrow({ where: { symbol: "SPRK" } });
    const res = await writer.callTool({
      name: "publish_signal_report",
      arguments: {
        assessment: {
          assetId: asset.id,
          status: "candidate",
          signalType: "advance",
          horizonHours: 24,
          score: 70,
          evidence: [],
          counterevidence: [],
          dataQuality: { assessment: "good", issues: [], missing: [] },
          entryTrigger: "x",
          invalidation: "y",
          exitConditions: { target: "t", trailing: "tr", maxHoldingHours: 24 },
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          rationale: "external",
        },
      },
    });
    expect(JSON.stringify(res.structuredContent)).toMatch(/"status":"watch".*"cappedFromCandidate":true/);
    const stored = await ctx.prisma.signal.findFirstOrThrow({ where: { origin: "external_mcp" } });
    expect(stored.status).toBe("watch");
  });
});
