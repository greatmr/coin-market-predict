import { describe, expect, it } from 'vitest';

import { TelegramService } from './telegram.service.js';

function service(token: string | null, respond: () => Promise<Response> | Response) {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return respond();
  }) as unknown as typeof fetch;
  const tg = new TelegramService(
    null as never,
    { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: '42', TELEGRAM_MODE: 'live' } as never,
    fetchImpl,
    null as never,
  );
  return { tg, calls: () => calls };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('Telegram bot username (for tappable coin links)', () => {
  it('loads the username with getMe once and caches it', async () => {
    const { tg, calls } = service('1:A', () =>
      json({ ok: true, result: { username: 'coins_bot' } }),
    );
    expect(tg.botUsername).toBeNull();
    expect(await tg.loadBotUsername()).toBe('coins_bot');
    expect(await tg.loadBotUsername()).toBe('coins_bot');
    expect(tg.botUsername).toBe('coins_bot');
    expect(calls()).toBe(1);
  });

  it('never trusts a malformed username, and stays null without a token or on errors', async () => {
    const bad = service('1:A', () => json({ ok: true, result: { username: 'x"><script>' } }));
    expect(await bad.tg.loadBotUsername()).toBeNull();
    const rejected = service('1:A', () => json({ ok: false, description: 'Unauthorized' }));
    expect(await rejected.tg.loadBotUsername()).toBeNull();
    const offline = service('1:A', () => Promise.reject(new Error('ENOTFOUND')));
    expect(await offline.tg.loadBotUsername()).toBeNull();
    const none = service(null, () => json({ ok: true, result: { username: 'coins_bot' } }));
    expect(await none.tg.loadBotUsername()).toBeNull();
    expect(none.calls()).toBe(0);
  });
});
