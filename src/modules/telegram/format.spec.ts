import { describe, expect, it } from 'vitest';

import {
  type CoinDetailInput,
  type QueueRow,
  TELEGRAM_LIMIT,
  type Tier1ReportInput,
  escapeHtml,
  formatCoinDetail,
  formatTier1Report,
  pack,
  queueTable,
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
  ['pre', 'b', 'i'].every((t) => msg.split(`<${t}>`).length === msg.split(`</${t}>`).length);

describe('Telegram Tier 1 summary (mobile)', () => {
  it('escapes untrusted text for HTML parse mode', () => {
    expect(escapeHtml('<b>&')).toBe('&lt;b&gt;&amp;');
    const parts = formatTier1Report(input({ rows: [row(1, { symbol: '<X&Y>' })] }));
    expect(parts.join('')).toContain('&lt;X&amp;Y');
    expect(parts.every(balanced)).toBe(true);
  });

  it('shows batch time, counts and a phone-width queue table that keeps mixed results visible', () => {
    const msg = formatTier1Report(input()).join('\n');
    expect(msg).toMatch(/Tier 1 VMC screen/);
    expect(msg).toMatch(/batch 2026-11-05T07:00 UTC · crawled 07:07 UTC/);
    expect(msg).toMatch(/8041 coins · ✅ 300 eligible · 🔎 250 need review · ⛔ 7491 excluded/);
    const table = /<pre>([\s\S]*?)<\/pre>/.exec(msg)![1]!;
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/^#\s+Coin\s+YES\s+3d\s+7d\s+30d\s+VMC$/);
    expect(lines.every((l) => l.length <= 44)).toBe(true);
    expect(lines[1]).toMatch(/^1\s+C1\s+\*\*\s+2\.00\*\s+1\.33\s+4\.00\*\s+20\.0%$/);
    expect(lines[2]).toMatch(/n\/a/);
    expect(msg).toMatch(/LBank Spot: C1: C1\/USDT/);
    expect(msg).not.toMatch(/\b(buy|sell|signal)\b/i);
  });

  it('withholds the queue for an incomplete batch or an unavailable LBank feed (p.18)', () => {
    const inc = formatTier1Report(
      input({
        batchStatus: 'INCOMPLETE',
        batchReasons: ['missing_ranks:3'],
        queueStatus: 'WITHHELD_INCOMPLETE_BATCH',
      }),
    ).join('\n');
    expect(inc).toMatch(/Review Queue withheld/);
    expect(inc).toMatch(/Batch INCOMPLETE: missing_ranks:3/);
    expect(inc).not.toContain('<pre>');
    const lb = formatTier1Report(input({ queueStatus: 'WITHHELD_LBANK_UNAVAILABLE' })).join('\n');
    expect(lb).toMatch(/LBank pair feed is unavailable/);
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
    expect(msg).toMatch(/TEST DATA/);
    expect(msg).toMatch(/Review Queue empty/);
    expect(msg).toMatch(
      /4 more coin\(s\) met a window but need review first \(3 with an unverified LBank pair\)/,
    );
  });

  it('/coin renders the dashboard drawer in phone-width messages', () => {
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
    const t: CoinDetailInput = {
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
    const parts = formatCoinDetail(t);
    const all = parts.join('\n');
    expect(all).toContain('&lt;GNO&gt;</b> · Gno &amp; sis · CMC 1659');
    expect(all).toMatch(/ELIGIBLE<\/b> · ★★☆ \(2 of 3 windows\) · Review Queue #3/);
    expect(all).toMatch(/\$2\.0M ÷ \$296\.6M = <b>0\.663%<\/b>/);
    expect(all).toMatch(/7d N\/A: a completed day is missing/);
    expect(all).toMatch(/10-26 {2}missing/);
    expect(all).toMatch(/GNO\/USDT · mapping OK · tradable \(listed\)/);
    expect(all).toMatch(/↳ LBank base GNOX ≠ CMC symbol GNO/);
    expect(all).toMatch(/Open mapping tasks: GNOX\/USDT \(symbol mismatch\)/);
    expect(all).toMatch(
      /r2 · 11-05 13:20 UTC · tester · PLAN_READY \(COMPLETE\) · venue ACCEPT · day FIRST/,
    );
    expect(all).not.toMatch(/\b(buy|sell)\b/i);
    for (const pre of all.match(/<pre>[\s\S]*?<\/pre>/g) ?? [])
      for (const line of pre.replace(/<\/?pre>/g, '').split('\n'))
        expect(line.length).toBeLessThanOrEqual(44);
    expect(parts.every((p) => p.length <= TELEGRAM_LIMIT && balanced(p))).toBe(true);
    // Column headers line up with the values below them.
    const daily = /<pre>(date[\s\S]*?)<\/pre>/.exec(all)![1]!.split('\n');
    expect(daily[0]!.indexOf('VMC') + 3).toBe(daily[1]!.indexOf('%') + 1);
  });

  it('splits long content under the Telegram limit without breaking tags', () => {
    const parts = pack(
      Array.from({ length: 30 }, (_, i) => `<b>block ${i}</b> ${'x'.repeat(300)}`),
    );
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= TELEGRAM_LIMIT && balanced(p))).toBe(true);
    expect(queueTable(Array.from({ length: 30 }, (_, i) => row(i + 1))).split('\n').length).toBe(
      31,
    );
  });
});
