import { describe, expect, it } from 'vitest';

import {
  type CoinDetailInput,
  type QueueRow,
  TELEGRAM_LIMIT,
  type Tier1ReportInput,
  coinLink,
  escapeHtml,
  formatCoinDetail,
  formatTier1Report,
  formatVmcBrief,
  multBar,
  pack,
  queueCard,
  sparkline,
} from './format.js';

const row = (i: number, extra: Partial<QueueRow> = {}): QueueRow => ({
  order: i,
  cmcId: 990000 + i,
  symbol: `C${i}`,
  stars: 2,
  pass: { d3: 'YES', d7: 'NO', d30: 'YES' },
  multiple: { d3: 2, d7: 1.3333, d30: 4 },
  currentVmc: 0.2,
  capUsd: 1e8,
  lbankPairs: [`C${i}/USDT`],
  ...extra,
});
const input = (o: Partial<Tier1ReportInput> = {}): Tier1ReportInput => ({
  generatedAt: new Date('2026-11-05T07:10:00Z'),
  slotTime: new Date('2026-11-05T07:00:00Z'),
  crawledAt: new Date('2026-11-05T07:07:31Z'),
  timezone: 'Asia/Tehran',
  providerName: 'CoinMarketCap website',
  isLive: true,
  attribution: 'Data: CoinMarketCap',
  batchStatus: 'COMPLETE',
  batchReasons: [],
  queueStatus: 'PUBLISHED',
  counts: { assets: 8041, eligible: 300, needsReview: 250, excluded: 7491, queue: 2 },
  needsReviewWithYes: 0,
  lbankUnverifiedWithYes: 0,
  rows: [
    row(1),
    row(2, {
      stars: 1,
      pass: { d3: 'NO', d7: 'N/A', d30: 'YES' },
      multiple: { d3: 1.2, d7: null, d30: 1.9 },
    }),
  ],
  warnings: [],
  ...o,
});
const balanced = (msg: string) =>
  ['pre', 'b', 'i'].every((t) => msg.split(`<${t}>`).length === msg.split(`</${t}>`).length) &&
  msg.split('<blockquote').length === msg.split('</blockquote>').length;

/** The GNO fixture: two YES windows, one N/A (missing day), a missing daily row, an ambiguous pair. */
function gnoTrace(): CoinDetailInput {
  const days = Array.from({ length: 30 }, (_, i) => ({
    dateUtc: `2026-10-${String(30 - i).padStart(2, '0')}`,
    volumeUsd: '1500000',
    marketCapUsd: '296608247.3582',
    vmc: '0.005057',
    closeUsd: '112.4',
    valid: true,
    invalidReasons: [],
    revision: 1,
  }));
  days[4] = {
    ...days[4]!,
    volumeUsd: null as never,
    marketCapUsd: null as never,
    vmc: null as never,
    closeUsd: null as never,
    valid: null as never,
    revision: null as never,
  };
  return {
    record: {
      cmcId: 1659,
      symbol: '<GNO>',
      name: 'Gno & sis',
      rank: 107,
      capUsd: '296608247.3582',
      volume24hUsd: '1966994.8645',
      priceUsd: '112.3725',
      currentVmc: '0.006631625661',
      currentStatus: 'OK',
      observedAt: '2026-11-05T13:05:03.000Z',
      crawledAt: '2026-11-05T13:07:10.000Z',
      dateAdded: '2017-05-01T00:00:00.000Z',
      ageDays: '3475.4',
      stars: 2,
      inQueue: true,
      queueOrder: 3,
      flags: [],
      venueFlags: ['UPBIT_TOP_VENUE'],
      lbankStatus: 'VERIFIED',
    },
    batch: { slotTime: '2026-11-05T13:00:00.000Z', isLive: true },
    eligibility: {
      status: 'ELIGIBLE',
      reasons: [],
      assetClass: 'regular',
      classSource: 'cmc_tags',
    },
    current: { formula: 'current_vmc = …' },
    windows: [
      {
        days: 3,
        mean: '0.004166774497',
        reason: null,
        pass: { status: 'YES', multiple: '1.5915', reason: null },
      },
      {
        days: 7,
        mean: null,
        reason: 'DAILY_ROW_MISSING',
        pass: { status: 'N/A', multiple: null, reason: 'DAILY_ROW_MISSING' },
      },
      { days: 14, mean: '0.003036', reason: null, pass: null },
      {
        days: 30,
        mean: '0.002778',
        reason: null,
        pass: { status: 'YES', multiple: '2.3870', reason: null },
      },
    ],
    daily: { asOfDate: '2026-11-05', used: days },
    lbank: {
      status: 'VERIFIED',
      reason: null,
      pairs: [
        {
          marketPair: 'GNO/USDT',
          mapping: 'OK',
          trading: 'TRADING',
          tradingSource: 'listing',
          volumeUsd: '123456',
          evidence: [],
        },
        {
          marketPair: 'GNOX/USDT',
          mapping: 'AMBIGUOUS',
          trading: 'TRADING',
          tradingSource: 'listing',
          volumeUsd: '10',
          evidence: ['LBank base GNOX ≠ CMC symbol GNO'],
        },
      ],
      crawl: { status: 'COMPLETE', finishedAt: '2026-11-05T12:26:30.715Z', fetchedCount: 899 },
      decisions: [],
      tasks: [{ marketPair: 'GNOX/USDT', kind: 'SYMBOL_MISMATCH', status: 'OPEN' }],
    },
    venues: {
      review: 'PENDING',
      flags: ['UPBIT_TOP_VENUE'],
      summary: {
        dataStatus: 'AVAILABLE',
        observedAt: '2026-11-05T13:10:00.000Z',
        pairsUsed: 34,
        expectedCount: 120,
        exchanges: [
          { name: 'Upbit', volumeUsd: '900000', volumePercent: '45.12' },
          { name: 'Binance', volumeUsd: '500000', volumePercent: '25' },
        ],
      },
    },
    reviews: [
      {
        revision: 2,
        reviewer: 'tester',
        reviewedAt: '2026-11-05T13:20:00.000Z',
        venueDecision: 'ACCEPT',
        eventDay: 'FIRST',
        finalDecision: 'PLAN_READY',
        planStatus: 'COMPLETE',
      },
    ],
  };
}

describe('Telegram Tier 1 summary (mobile)', () => {
  it('escapes untrusted text for HTML parse mode', () => {
    expect(escapeHtml('<b>&')).toBe('&lt;b&gt;&amp;');
    const parts = formatTier1Report(input({ rows: [row(1, { symbol: '<X&Y>' })] }));
    expect(parts.join('')).toContain('&lt;X&amp;Y');
    expect(parts.every(balanced)).toBe(true);
  });

  it('shows one local time, the counts and a two-line card per queued coin', () => {
    const msg = formatTier1Report(input()).join('\n');
    expect(msg).toMatch(/VMC screen · 10:30 IRST/); // 07:00 UTC in Asia/Tehran
    expect(msg).toMatch(/Thu 5 Nov · batch 07:00 UTC · CoinMarketCap website/);
    expect(msg).toMatch(/2 coins in the review queue/);
    expect(msg).toMatch(/8,041 coins · 300 eligible · 250 need review · 7,491 excluded/);
    // YES windows are bold, NO plain, N/A a dash; mixed results stay visible.
    expect(msg).toContain('<b>1. C1</b>  ★★☆  VMC <b>20.0%</b>  /coin_990001');
    expect(msg).toContain('└ 3d <b>2.00×</b> · 7d 1.33× · 30d <b>4.00×</b>');
    expect(msg).toContain('└ 3d 1.20× · 7d – · 30d <b>1.90×</b>');
    // The usual SYMBOL/USDT pair is implied; only an unusual pair is named.
    expect(msg).not.toMatch(/LBank C1\/USDT/);
    expect(
      formatTier1Report(input({ rows: [row(1, { lbankPairs: ['C1X/USDC'] })] })).join(''),
    ).toMatch(/LBank C1X\/USDC/);
    expect(msg).not.toContain('<pre>');
    expect(msg).not.toMatch(/\b(buy|sell|signal)\b/i);
  });

  it('makes each coin name a deep link to its details when the bot username is known', () => {
    const msg = formatTier1Report(input({ botUsername: 'coins_bot' })).join('\n');
    expect(msg).toContain(
      '<a href="https://t.me/coins_bot?start=coin_990001"><b>1. C1</b></a>  ★★☆  VMC <b>20.0%</b>',
    );
    expect(msg).not.toContain('/coin_990001'); // the tappable name replaces the command
    expect(msg).toMatch(/Tap a coin for its details/);
    expect(formatTier1Report(input()).join('\n')).toMatch(/Tap a \/coin link for details/);
    expect(formatTier1Report(input()).join('\n')).not.toContain('<a href');
  });

  it('builds coin links only from a valid username and id', () => {
    expect(coinLink('<b>SIGN</b>', 35600, 'coins_bot')).toBe(
      '<a href="https://t.me/coins_bot?start=coin_35600"><b>SIGN</b></a>',
    );
    expect(coinLink('SIGN', 35600, 'coins_bot', 'vmc')).toContain('?start=vmc_35600');
    expect(coinLink('SIGN', 35600, 'bad"name')).toBe('SIGN');
    expect(coinLink('SIGN', 1.5, 'coins_bot')).toBe('SIGN');
  });

  it('says how many queued coins are not listed', () => {
    const msg = formatTier1Report(
      input({
        counts: { assets: 8041, eligible: 300, needsReview: 250, excluded: 7491, queue: 12 },
      }),
    ).join('\n');
    expect(msg).toMatch(/10 more coins in the workbook and on the dashboard/);
  });

  it('withholds the queue for an incomplete batch or an unavailable LBank feed (p.18)', () => {
    const inc = formatTier1Report(
      input({
        batchStatus: 'INCOMPLETE',
        batchReasons: ['missing_ranks:3'],
        queueStatus: 'WITHHELD_INCOMPLETE_BATCH',
      }),
    ).join('\n');
    expect(inc).toMatch(/Review queue withheld/);
    expect(inc).toMatch(/Batch incomplete<\/b>: missing_ranks:3/);
    expect(inc).not.toContain('/coin_');
    const lb = formatTier1Report(input({ queueStatus: 'WITHHELD_LBANK_UNAVAILABLE' })).join('\n');
    expect(lb).toMatch(/LBank pair list is missing or stale/);
  });

  it('publishes an honest empty queue, points to coins needing review, and labels test data', () => {
    const msg = formatTier1Report(
      input({
        isLive: false,
        rows: [],
        counts: { assets: 1301, eligible: 40, needsReview: 30, excluded: 1231, queue: 0 },
        queueStatus: 'EMPTY',
        needsReviewWithYes: 4,
        lbankUnverifiedWithYes: 3,
      }),
    ).join('\n');
    expect(msg).toMatch(/Test data/);
    expect(msg).toMatch(/Review queue is empty/);
    expect(msg).toMatch(
      /4 more coins met a window but need review first \(3 with an unverified LBank pair\)/,
    );
  });

  it('/coin renders the coin detail with sparklines in phone-width messages', () => {
    const parts = formatCoinDetail(gnoTrace());
    const all = parts.join('\n');
    expect(all).toContain('🪙 <b>&lt;GNO&gt;</b> · Gno &amp; sis');
    expect(all).toMatch(/Rank 107 · CMC 1659 · batch 13:00 UTC/);
    expect(all).toMatch(/✅ Eligible · ★★☆ · 🎯 queue #3/);
    expect(all).toMatch(/now <b>0\.663%<\/b>/);
    expect(all).toMatch(/\$2\.0M rolling 24h volume ÷ \$296\.6M cap/);
    // Windows: bar + multiple + result; the N/A window explains itself; 14d is context.
    expect(all).toMatch(/3d {2,}0\.417% {2}████░░░░ +1\.59× YES/);
    expect(all).toMatch(/30d {2,}0\.278% {2}█████░░░ +2\.39× YES/);
    expect(all).toMatch(/14d {2,}0\.304% +context/);
    expect(all).toMatch(/7d N\/A: a completed day is missing/);
    // The VMC sparkline covers every daily row (one "·" for the missing day) and ends in now.
    const spark = /\n(30d [▁▂▃▄▅▆▇█·]+ [▁▂▃▄▅▆▇█] now)/.exec(all)![1]!;
    expect(spark.split(' ')[1]!.length).toBe(30);
    expect(spark.split(' ')[1]).toContain('·');
    expect(all).toMatch(/<b>Price<\/b> · 30 days/);
    expect(all).toMatch(/GNO\/USDT · tradable \(listed\) · vol \$123\.5K/);
    expect(all).toMatch(/GNOX\/USDT · tradable \(listed\) · mapping ambiguous/);
    expect(all).toMatch(/↳ LBank base GNOX ≠ CMC symbol GNO/);
    expect(all).toMatch(/Open mapping tasks: GNOX\/USDT \(symbol mismatch\)/);
    expect(all).toMatch(/Where it trades<\/b> · Upbit 45% · Binance 25%/);
    expect(all).toMatch(/upbit top venue/);
    expect(all).toMatch(/Review<\/b> · plan ready \(complete\) · r2 by tester, 11-05 13:20 UTC/);
    // Daily rows sit in a collapsed quote, newest first, with the missing day marked.
    expect(all).toMatch(/<blockquote expandable><b>Daily rows used<\/b> · 30 completed UTC days/);
    expect(all).toMatch(/26 Oct · missing/);
    expect(all).not.toMatch(/\b(buy|sell)\b/i);
    for (const pre of all.match(/<pre>[\s\S]*?<\/pre>/g) ?? [])
      for (const line of pre.replace(/<\/?pre>/g, '').split('\n'))
        expect(line.length).toBeLessThanOrEqual(44);
    expect(parts.every((p) => p.length <= TELEGRAM_LIMIT && balanced(p))).toBe(true);
  });

  it('/coin keeps an excluded coin short: reasons, no empty window table', () => {
    const t = gnoTrace();
    t.eligibility = { ...t.eligibility, status: 'EXCLUDED', reasons: ['NO_LBANK_SPOT_PAIR'] };
    t.windows = t.windows.map((w) => ({
      ...w,
      mean: null,
      pass: w.pass && { status: 'N/A', multiple: null, reason: 'NOT_EVALUATED_EXCLUDED' },
    }));
    t.daily = { ...t.daily, used: [] };
    t.reviews = [];
    t.venues = { review: null, flags: [], summary: null };
    const all = formatCoinDetail(t).join('\n');
    expect(all).toMatch(/⛔ Excluded/);
    expect(all).toMatch(/Left out: no LBank Spot pair/);
    expect(all).toMatch(/Windows not evaluated: excluded coins get no daily history/);
    expect(all).not.toContain('<pre>');
    expect(all).not.toMatch(/Where it trades|Review<\/b>|blockquote/);
  });

  it('/vmc shows the windows and links to /coin', () => {
    const msg = formatVmcBrief(gnoTrace());
    expect(msg).toMatch(/&lt;GNO&gt;<\/b> · Gno &amp; sis · ✅ Eligible · ★★☆ · 🎯 #3/);
    expect(msg).toMatch(/1\.59× YES/);
    expect(msg).toMatch(/\/coin_1659/);
    expect(balanced(msg)).toBe(true);
  });

  it('/vmc links to the full detail through the bot when the username is known', () => {
    const msg = formatVmcBrief(gnoTrace(), 'coins_bot');
    expect(msg).toContain(
      '<a href="https://t.me/coins_bot?start=coin_1659">Everything about &lt;GNO&gt;</a>',
    );
    expect(msg).not.toContain('/coin_1659');
  });

  it('draws sparklines and multiple bars on fixed scales', () => {
    expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7])).toBe('▁▂▃▄▅▆▇█');
    expect(sparkline([1, null, 1])).toBe('▁·▁');
    expect(sparkline([5], { lo: 0, hi: 10 })).toBe('▅');
    expect(multBar(0)).toBe('░░░░░░░░');
    expect(multBar(6)).toBe('████████');
    expect(multBar(1.5)).toBe('████░░░░'); // the YES line sits near the middle
    expect(multBar(null)).toBe('        ');
  });

  it('splits long content under the Telegram limit without breaking tags', () => {
    const parts = pack(
      Array.from({ length: 30 }, (_, i) => `<b>block ${i}</b> ${'x'.repeat(300)}`),
    );
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= TELEGRAM_LIMIT && balanced(p))).toBe(true);
    expect(queueCard(row(30)).split('\n')).toHaveLength(2);
  });
});
