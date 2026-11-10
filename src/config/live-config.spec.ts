import { describe, expect, it } from 'vitest';

import { type AppConfig, loadConfig } from './env.validation.js';
import { LiveConfig } from './live-config.js';
import type { SavedSettings, SettingKey } from './settings.catalog.js';

const env = { DATABASE_URL: 'postgresql://coins:pw@localhost:5433/coins' } as NodeJS.ProcessEnv;
const next = (saved: SavedSettings) => loadConfig(env, saved);

function setup() {
  const cfg = loadConfig(env);
  const live = new LiveConfig(cfg);
  const seen: Array<SettingKey[]> = [];
  live.onChange((changed) => seen.push([...changed].sort()));
  return { cfg, live, seen };
}

describe('LiveConfig', () => {
  it('copies live settings into the shared configuration and names what changed', () => {
    const { cfg, live, seen } = setup();
    const same: AppConfig = cfg;
    expect(
      live.apply(next({ PIPELINE_CRON: '17 * * * *', CRAWL_EXPECTED_INTERVAL_MINUTES: 30 })),
    ).toBe('applied');
    expect(same.PIPELINE_CRON).toBe('17 * * * *');
    // The derived maximum quote age follows the interval.
    expect(same.MAX_QUOTE_AGE_MINUTES).toBe(60);
    expect(seen).toEqual([
      ['CRAWL_EXPECTED_INTERVAL_MINUTES', 'MAX_QUOTE_AGE_MINUTES', 'PIPELINE_CRON'],
    ]);
    live.apply(next({ PIPELINE_CRON: '17 * * * *', CRAWL_EXPECTED_INTERVAL_MINUTES: 30 }));
    expect(seen).toHaveLength(1); // nothing changed, nobody notified
  });

  it('keeps start-up settings at the value the process started with', () => {
    const { cfg, live, seen } = setup();
    live.apply(next({ DATA_SOURCE: 'coinmarketcap_web', CMC_WEB_LISTING_PAGE_SIZE: 500 }));
    expect(cfg.DATA_SOURCE).toBe('fixture');
    expect(cfg.CMC_WEB_LISTING_PAGE_SIZE).toBe(10_000);
    expect(seen).toEqual([]);
  });

  it('defers a change while a run holds the configuration, until the last hold ends', () => {
    const { cfg, live, seen } = setup();
    const releaseA = live.hold();
    const releaseB = live.hold();
    expect(live.held).toBe(true);
    expect(live.apply(next({ TELEGRAM_QUEUE_ROWS: 5 }))).toBe('deferred');
    expect(live.apply(next({ TELEGRAM_QUEUE_ROWS: 7 }))).toBe('deferred'); // the newest wins
    expect([cfg.TELEGRAM_QUEUE_ROWS, live.hasPending]).toEqual([10, true]);
    releaseA();
    releaseA(); // idempotent: one hold is still held
    expect(cfg.TELEGRAM_QUEUE_ROWS).toBe(10);
    releaseB();
    expect([cfg.TELEGRAM_QUEUE_ROWS, live.hasPending, live.held]).toEqual([7, false, false]);
    expect(seen).toEqual([['TELEGRAM_QUEUE_ROWS']]);
  });

  it('keeps notifying the other listeners when one fails, and can unsubscribe', () => {
    const { live, seen } = setup();
    const off = live.onChange(() => {
      throw new Error('listener failed');
    });
    live.apply(next({ TELEGRAM_QUEUE_ROWS: 3 }));
    expect(seen).toHaveLength(1);
    off();
    live.apply(next({ TELEGRAM_QUEUE_ROWS: 4 }));
    expect(seen).toHaveLength(2);
  });
});
