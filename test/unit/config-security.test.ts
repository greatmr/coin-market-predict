import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError, describeConfig, loadConfig } from "../../src/config/config.js";
import { redact, registerSecrets } from "../../src/config/redact.js";
import { resolveScope } from "../../src/mcp/mcp-auth.js";
import { defineTool, invokeTool } from "../../src/mcp/tool-def.js";
import { FixtureCmcMarket, FIXTURE_LISTED } from "../../src/sources/fixture/fixture-cmc.js";

const base = { DATABASE_URL: "postgresql://coins:pw@localhost:5433/coins" } as NodeJS.ProcessEnv;

describe("configuration", () => {
  it("uses safe defaults: fixture data, Telegram dry-run, Tehran display time, max quote age = 2 × crawl interval", () => {
    const c = loadConfig(base);
    expect(c.DATA_SOURCE).toBe("fixture");
    expect(c.TELEGRAM_MODE).toBe("dry_run");
    expect(c.DISPLAY_TIMEZONE).toBe("Asia/Tehran");
    expect(c.CRAWL_EXPECTED_INTERVAL_MINUTES).toBe(60);
    expect(c.MAX_QUOTE_AGE_MINUTES).toBe(120);
    expect(loadConfig({ ...base, CRAWL_EXPECTED_INTERVAL_MINUTES: "30" }).MAX_QUOTE_AGE_MINUTES).toBe(60);
    expect(loadConfig({ ...base, MAX_QUOTE_AGE_MINUTES: "90" }).MAX_QUOTE_AGE_MINUTES).toBe(90);
  });

  it("ignores retired settings left in an existing .env (agents, six-month VMC, legacy floors)", () => {
    const c = loadConfig({ ...base, AGENT_PROVIDER: "claude", VMC_SOURCE: "cmc_web", MIN_MARKET_CAP_USD: "5000000" } as NodeJS.ProcessEnv) as Record<string, unknown>;
    expect(c.AGENT_PROVIDER).toBeUndefined();
    expect(c.VMC_SOURCE).toBeUndefined();
    expect(c.MIN_MARKET_CAP_USD).toBeUndefined();
  });

  it("refuses live Telegram without credentials and never echoes values", () => {
    try {
      loadConfig({ ...base, TELEGRAM_MODE: "live", TELEGRAM_BOT_TOKEN: "123456:SECRETSECRETSECRET" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(String(e)).toMatch(/TELEGRAM_CHAT_ID/);
      expect(String(e)).not.toMatch(/SECRETSECRET/);
    }
  });

  it("requires dashboard auth when binding beyond loopback", () => {
    expect(() => loadConfig({ ...base, HOST: "0.0.0.0" })).toThrow(/DASHBOARD_BASIC_AUTH/);
  });

  it("reads *_FILE secrets and masks them in diagnostics", () => {
    const dir = mkdtempSync(join(tmpdir(), "coins-"));
    const f = join(dir, "tok");
    writeFileSync(f, "file-based-bot-token\n");
    const c = loadConfig({ ...base, TELEGRAM_BOT_TOKEN_FILE: f });
    expect(c.TELEGRAM_BOT_TOKEN).toBe("file-based-bot-token");
    const d = describeConfig(c);
    expect(d.TELEGRAM_BOT_TOKEN).toBe("<set>");
    expect(d.DATABASE_URL).toBe("postgresql://coins:***@localhost:5433/coins");
    expect(JSON.stringify(d)).not.toMatch(/file-based-bot-token/);
  });

  it("treats empty secrets as not configured", () => {
    expect(loadConfig({ ...base, CMC_API_KEY: "  " }).CMC_API_KEY).toBeUndefined();
  });
});

describe("redaction", () => {
  it("masks registered secrets and known credential shapes", () => {
    registerSecrets(["super-secret-value-123"]);
    expect(redact("error: super-secret-value-123 failed")).not.toMatch(/super-secret/);
    expect(redact("POST https://api.telegram.org/bot123456789:AAAbbbCCCdddEEEfffGGGhhh/sendMessage")).not.toMatch(/AAAbbb/);
    expect(redact("Authorization: Bearer abcdefghijklmnop")).not.toMatch(/abcdefghijklmnop/);
    expect(redact(`token ${"sk-ant-"}oat01-abcdefghijklmnopqrstuvwxyz`)).not.toMatch(/abcdefghijklmnop/);
    expect(redact("postgresql://u:pw@h/db")).toBe("postgresql://u:***@h/db");
  });

  it("never throws on undefined, null or non-JSON values (Nest passes undefined stacks)", () => {
    expect(redact(undefined)).toBe("undefined");
    expect(redact(null)).toBe("null");
    expect(redact(() => 1)).toMatch(/=>/);
  });

  it("shows the network cause behind Node's generic 'fetch failed', still masking secrets", () => {
    const timeout = Object.assign(new Error("Connect Timeout Error (attempted address: api.telegram.org:443, timeout: 10000ms)"), { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" });
    expect(redact(new TypeError("fetch failed", { cause: timeout }))).toBe("TypeError: fetch failed (cause: ConnectTimeoutError: Connect Timeout Error (attempted address: api.telegram.org:443, timeout: 10000ms) [UND_ERR_CONNECT_TIMEOUT])");
    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND api.telegram.org"), { code: "ENOTFOUND" });
    expect(redact(new TypeError("fetch failed", { cause: dns }))).toBe("TypeError: fetch failed (cause: Error: getaddrinfo ENOTFOUND api.telegram.org)");
    const leaky = new TypeError("fetch failed", { cause: new Error("socket closed for https://api.telegram.org/bot123456789:AAAbbbCCCdddEEEfffGGGhhh/getUpdates") });
    expect(redact(leaky)).not.toMatch(/AAAbbb/);
  });
});

describe("MCP access boundaries", () => {
  const tokens = { read: "r".repeat(32), write: "w".repeat(32) };
  it("grants scopes only for exact bearer tokens", () => {
    expect(resolveScope(`Bearer ${tokens.read}`, tokens)).toBe("read");
    expect(resolveScope(`Bearer ${tokens.write}`, tokens)).toBe("write");
    expect(resolveScope(`Bearer ${tokens.read}x`, tokens)).toBeNull();
    expect(resolveScope(undefined, tokens)).toBeNull();
    expect(resolveScope(`Basic ${tokens.read}`, tokens)).toBeNull();
  });

  it("validates tool inputs strictly and withholds invalid outputs", async () => {
    const t = defineTool({ name: "t", description: "d", scope: "read", input: { n: z.number().int() }, output: z.object({ ok: z.boolean() }), handler: async ({ n }) => ({ ok: n > 0 }) });
    expect((await invokeTool(t, { n: 1 })).structuredContent).toMatchObject({ data: { ok: true } });
    expect((await invokeTool(t, { n: "1" })).isError).toBe(true);
    expect((await invokeTool(t, { n: 1, sql: "drop" })).isError).toBe(true);
    const bad = defineTool({ name: "b", description: "d", scope: "read", input: {}, output: z.object({ ok: z.boolean() }), handler: async () => ({ ok: "yes" }) as never });
    expect((await invokeTool(bad, {})).content[0]!.text).toMatch(/withheld/);
  });
});

describe("fixture market", () => {
  const anchor = "2026-11-05";
  const slot = new Date("2026-11-05T07:00:00Z");
  it("is deterministic and clearly synthetic (ids ≥ 990001, names marked fixture)", () => {
    const a = new FixtureCmcMarket(anchor).observations(slot);
    const b = new FixtureCmcMarket(anchor).observations(slot);
    expect(a).toEqual(b);
    expect(a.every((o) => Number(o.providerAssetId) >= 990001 && o.name.includes("(fixture)"))).toBe(true);
    expect(new Set(a.filter((o) => o.rank !== null).map((o) => o.rank)).size).toBe(FIXTURE_LISTED);
  });
  it("daily rows are a pure function of asset and date (refreshes never invent revisions)", () => {
    const m = new FixtureCmcMarket(anchor);
    expect(m.dailyRows(990001, "2026-10-01", "2026-11-04")).toEqual(new FixtureCmcMarket(anchor).dailyRows(990001, "2026-10-01", "2026-11-04"));
    expect(m.dailyRows(990007, "2026-10-28", "2026-11-04").map((r) => r.dateUtc)).not.toContain("2026-10-31");
    expect(m.observations(slot).find((o) => o.symbol === "STAL")!.observedAt!.getTime()).toBeLessThan(slot.getTime() - 3 * 3600_000);
    expect(m.observations(slot).find((o) => o.symbol === "NOCAP")!.marketCap).toBeNull();
    expect(m.observations(slot).filter((o) => o.symbol === "TWIN").map((o) => o.providerAssetId).sort()).toEqual(["990005", "990006"]);
  });
});
