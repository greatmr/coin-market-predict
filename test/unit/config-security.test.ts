import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError, describeConfig, loadConfig } from "../../src/config/config.js";
import { redact, registerSecrets } from "../../src/config/redact.js";
import { resolveScope } from "../../src/mcp/mcp-auth.js";
import { defineTool, invokeTool } from "../../src/mcp/tool-def.js";
import { FixtureMarket } from "../../src/sources/fixture/fixture-market.js";

const base = { DATABASE_URL: "postgresql://coins:pw@localhost:5433/coins" } as NodeJS.ProcessEnv;

describe("configuration", () => {
  it("uses safe defaults: fixture data, fixture agents, Telegram dry-run, Tehran display time", () => {
    const c = loadConfig(base);
    expect(c.DATA_SOURCE).toBe("fixture");
    expect(c.AGENT_PROVIDER).toBe("fixture");
    expect(c.TELEGRAM_MODE).toBe("dry_run");
    expect(c.DISPLAY_TIMEZONE).toBe("Asia/Tehran");
    expect(c.SNAPSHOT_WINDOW).toBe(3);
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
    writeFileSync(f, "file-based-oauth-token\n");
    const c = loadConfig({ ...base, CLAUDE_CODE_OAUTH_TOKEN_FILE: f });
    expect(c.CLAUDE_CODE_OAUTH_TOKEN).toBe("file-based-oauth-token");
    const d = describeConfig(c);
    expect(d.CLAUDE_CODE_OAUTH_TOKEN).toBe("<set>");
    expect(d.DATABASE_URL).toBe("postgresql://coins:***@localhost:5433/coins");
    expect(JSON.stringify(d)).not.toMatch(/file-based-oauth-token/);
  });

  it("treats empty secrets as not configured", () => {
    expect(loadConfig({ ...base, CLAUDE_CODE_OAUTH_TOKEN: "  " }).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
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
  const anchor = new Date("2026-11-03T12:00:00Z");
  it("is deterministic and clearly synthetic", () => {
    const a = new FixtureMarket(anchor).observationsFor(anchor);
    const b = new FixtureMarket(anchor).observationsFor(anchor);
    expect(a).toEqual(b);
    expect(a.every((o) => o.providerAssetId.startsWith("fx-") && o.name.includes("(fixture)"))).toBe(true);
  });
  it("models gaps, stale observations, missing caps and shared symbols", () => {
    const m = new FixtureMarket(anchor);
    expect(m.observationsFor(new Date("2026-11-03T11:00:00Z")).find((o) => o.symbol === "GAP")).toBeUndefined();
    const now = m.observationsFor(anchor);
    expect(now.find((o) => o.symbol === "STAL")!.observedAt!.getTime()).toBeLessThan(anchor.getTime() - 3 * 3600_000);
    expect(now.find((o) => o.symbol === "NOCAP")!.marketCap).toBeNull();
    expect(now.filter((o) => o.symbol === "FROG").map((o) => o.providerAssetId).sort()).toEqual(["fx-frog-one", "fx-frog-two"]);
    expect(now.every((o) => o.volumeHourly === null)).toBe(true);
  });
});
