import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ConfigError, describeConfig, loadConfig } from './env.validation.js';

const base = { DATABASE_URL: 'postgresql://coins:pw@localhost:5433/coins' } as NodeJS.ProcessEnv;

describe('configuration', () => {
  it('uses safe defaults: fixture data, Telegram dry-run, Tehran display time, max quote age = 2 × crawl interval', () => {
    const c = loadConfig(base);
    expect(c.DATA_SOURCE).toBe('fixture');
    expect(c.TELEGRAM_MODE).toBe('dry_run');
    expect(c.DISPLAY_TIMEZONE).toBe('Asia/Tehran');
    expect(c.CRAWL_EXPECTED_INTERVAL_MINUTES).toBe(60);
    expect(c.MAX_QUOTE_AGE_MINUTES).toBe(120);
    expect(
      loadConfig({ ...base, CRAWL_EXPECTED_INTERVAL_MINUTES: '30' }).MAX_QUOTE_AGE_MINUTES,
    ).toBe(60);
    expect(loadConfig({ ...base, MAX_QUOTE_AGE_MINUTES: '90' }).MAX_QUOTE_AGE_MINUTES).toBe(90);
  });

  it('ignores retired settings left in an existing .env (agents, six-month VMC, legacy floors)', () => {
    const c = loadConfig({
      ...base,
      AGENT_PROVIDER: 'claude',
      VMC_SOURCE: 'cmc_web',
      MIN_MARKET_CAP_USD: '5000000',
    } as NodeJS.ProcessEnv) as Record<string, unknown>;
    expect(c.AGENT_PROVIDER).toBeUndefined();
    expect(c.VMC_SOURCE).toBeUndefined();
    expect(c.MIN_MARKET_CAP_USD).toBeUndefined();
  });

  it('refuses live Telegram without credentials and never echoes values', () => {
    try {
      loadConfig({
        ...base,
        TELEGRAM_MODE: 'live',
        TELEGRAM_BOT_TOKEN: '123456:SECRETSECRETSECRET',
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(String(e)).toMatch(/TELEGRAM_CHAT_ID/);
      expect(String(e)).not.toMatch(/SECRETSECRET/);
    }
  });

  it('requires dashboard auth when binding beyond loopback', () => {
    expect(() => loadConfig({ ...base, HOST: '0.0.0.0' })).toThrow(/DASHBOARD_BASIC_AUTH/);
  });

  it('reads *_FILE secrets and masks them in diagnostics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coins-'));
    const f = join(dir, 'tok');
    writeFileSync(f, 'file-based-bot-token\n');
    const c = loadConfig({ ...base, TELEGRAM_BOT_TOKEN_FILE: f });
    expect(c.TELEGRAM_BOT_TOKEN).toBe('file-based-bot-token');
    const d = describeConfig(c);
    expect(d.TELEGRAM_BOT_TOKEN).toBe('<set>');
    expect(d.DATABASE_URL).toBe('postgresql://coins:***@localhost:5433/coins');
    expect(JSON.stringify(d)).not.toMatch(/file-based-bot-token/);
  });

  it('treats empty secrets as not configured', () => {
    expect(loadConfig({ ...base, CMC_API_KEY: '  ' }).CMC_API_KEY).toBeUndefined();
  });

  it('treats empty optional numbers as not set, but still rejects invalid ones', () => {
    const c = loadConfig({ ...base, POSTGRES_PORT: '', MAX_QUOTE_AGE_MINUTES: ' ' });
    expect(c.POSTGRES_PORT).toBeUndefined();
    expect(c.MAX_QUOTE_AGE_MINUTES).toBe(120);
    expect(() => loadConfig({ ...base, POSTGRES_PORT: '0' })).toThrow(/POSTGRES_PORT/);
    expect(() => loadConfig({ ...base, MAX_QUOTE_AGE_MINUTES: 'soon' })).toThrow(
      /MAX_QUOTE_AGE_MINUTES/,
    );
  });

  it('accepts the POSTGRES_* variables instead of DATABASE_URL, and names what is missing', () => {
    const pg = {
      POSTGRES_HOST: '127.0.0.1',
      POSTGRES_PORT: '5433',
      POSTGRES_USER: 'coins',
      POSTGRES_PASSWORD: 'pw-not-logged',
      POSTGRES_DB: 'coins',
    } as NodeJS.ProcessEnv;
    const c = loadConfig(pg);
    expect([c.DATABASE_URL, c.POSTGRES_HOST, c.POSTGRES_PORT, c.POSTGRES_SSL]).toEqual([
      undefined,
      '127.0.0.1',
      5433,
      false,
    ]);
    expect(describeConfig(c).POSTGRES_PASSWORD).toBe('<set>');
    expect(JSON.stringify(describeConfig(c))).not.toMatch(/pw-not-logged/);
    try {
      loadConfig({ POSTGRES_HOST: 'h', POSTGRES_PASSWORD: 'pw-not-logged' } as NodeJS.ProcessEnv);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(String(e)).toMatch(/missing: POSTGRES_USER, POSTGRES_DB/);
      expect(String(e)).not.toMatch(/pw-not-logged/);
    }
  });
});
