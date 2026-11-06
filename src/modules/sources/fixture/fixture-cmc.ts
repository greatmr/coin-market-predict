import { DAY_MS, addDays, isoDate, parseIsoDate } from '../../../common/utils/dates.js';
import { D } from '../../../common/utils/decimal.js';

import { LBANK } from '../../strategy/index.js';
import type { VenuePair } from '../../strategy/index.js';
import type { DailySourceRow, RawObservation } from '../source.types.js';

/**
 * Deterministic SYNTHETIC CoinMarketCap-shaped market for offline runs, demos and tests.
 * Nothing here is market data: every id is ≥ 990001 (far above real CMC ids), every name ends in
 * "(fixture)", and the provider is registered with isLive=false so every output is labelled.
 *
 * Designed cases (PDF p.20) hold for batches on the anchor date; daily rows are a pure function
 * of (asset, UTC date) so refreshes never invent revisions. Ranks 1–1300 are contiguous so the
 * rank-continuity check passes; filler coins make the universe realistic.
 */

export const FIXTURE_LISTED = 1300;
const FILLER_ID_BASE = 990_100;

type DailySpec = (offset: number) => { vmc: string } | 'missing' | 'invalid';

interface Scenario {
  cmcId: number;
  symbol: string;
  name: string;
  rank: number | null;
  cap: string | null;
  tags?: string[];
  /** Listing age in days relative to the slot (null = no date_added). */
  ageDays?: number | null;
  /** Designed daily VMC by offset (1 = T−1); offsets it does not cover use `baseVmc`. */
  daily?: DailySpec;
  baseVmc: string;
  /** Current VMC on the anchor date. */
  currentVmc: string;
  quote?: 'stale' | 'no_timestamp';
  lbank?: Array<{ base?: string; quote: string; trading: boolean }>;
  venues?: Array<{ exchange: string; name: string; share: number }>;
}

const VERIFIED = [{ quote: 'USDT', trading: true }];
const const_ =
  (vmc: string): DailySpec =>
  () => ({ vmc });

/** PDF p.19 B: mean3 0.10, mean7 0.15, mean30 0.05 → with current 0.20: YES / NO / YES. */
const yesNoYes: DailySpec = (o) => ({
  vmc: o <= 3 ? '0.10' : o <= 7 ? '0.1875' : o <= 29 ? '0.02' : o === 30 ? '0.01' : '0.02',
});

const SCENARIOS: Scenario[] = [
  {
    cmcId: 990001,
    symbol: 'YNY',
    name: 'Yes No Yes Labs (fixture)',
    rank: 150,
    cap: '100000000',
    daily: yesNoYes,
    baseVmc: '0.02',
    currentVmc: '0.20',
    lbank: [
      { quote: 'USDT', trading: true },
      { quote: 'BTC', trading: true },
    ],
  },
  {
    cmcId: 990002,
    symbol: 'ZERO',
    name: 'Zero Star (fixture)',
    rank: 151,
    cap: '90000000',
    daily: const_('0.10'),
    baseVmc: '0.10',
    currentVmc: '0.05',
    lbank: VERIFIED,
  },
  {
    cmcId: 990003,
    symbol: 'TRIP',
    name: 'Triple Star (fixture)',
    rank: 152,
    cap: '80000000',
    daily: const_('0.05'),
    baseVmc: '0.05',
    currentVmc: '0.20',
    lbank: VERIFIED,
    venues: [
      { exchange: 'upbit', name: 'Upbit', share: 0.71 },
      { exchange: 'binance', name: 'Binance', share: 0.17 },
      { exchange: LBANK, name: 'LBank', share: 0.12 },
    ],
  },
  // Symbol mismatch: CMC symbol AMB, LBank base ticker AMBX → ambiguous mapping, held for review.
  {
    cmcId: 990004,
    symbol: 'AMB',
    name: 'Ambiguous Ticker (fixture)',
    rank: 160,
    cap: '70000000',
    daily: const_('0.04'),
    baseVmc: '0.04',
    currentVmc: '0.12',
    lbank: [{ base: 'AMBX', quote: 'USDT', trading: true }],
  },
  // Two CMC assets share the symbol TWIN; the LBank ticker TWIN maps to both → ambiguous for both.
  {
    cmcId: 990005,
    symbol: 'TWIN',
    name: 'Twin Alpha (fixture)',
    rank: 161,
    cap: '65000000',
    daily: const_('0.05'),
    baseVmc: '0.05',
    currentVmc: '0.11',
    lbank: [{ quote: 'USDT', trading: true }],
  },
  {
    cmcId: 990006,
    symbol: 'TWIN',
    name: 'Twin Beta (fixture)',
    rank: 162,
    cap: '64000000',
    daily: const_('0.05'),
    baseVmc: '0.05',
    currentVmc: '0.06',
    lbank: [{ quote: 'BTC', trading: true }],
  },
  // Missing completed day T−5 → 3d valid, 7d/14d/30d N/A.
  {
    cmcId: 990007,
    symbol: 'GAPD',
    name: 'Missing Day (fixture)',
    rank: 170,
    cap: '60000000',
    daily: (o) => (o === 5 ? 'missing' : { vmc: '0.05' }),
    baseVmc: '0.05',
    currentVmc: '0.09',
    lbank: VERIFIED,
  },
  // Invalid day T−8 (cap 0) → 3d and 7d valid; 14d and 30d N/A (p.19 D).
  {
    cmcId: 990008,
    symbol: 'BADD',
    name: 'Invalid Day (fixture)',
    rank: 171,
    cap: '59000000',
    daily: (o) => (o === 8 ? 'invalid' : { vmc: '0.05' }),
    baseVmc: '0.05',
    currentVmc: '0.08',
    lbank: VERIFIED,
  },
  {
    cmcId: 990009,
    symbol: 'UNV',
    name: 'Unverified Pair (fixture)',
    rank: 180,
    cap: '58000000',
    daily: const_('0.03'),
    baseVmc: '0.03',
    currentVmc: '0.12',
    lbank: [{ quote: 'USDT', trading: false }],
  },
  {
    cmcId: 990010,
    symbol: 'NOLB',
    name: 'No LBank Pair (fixture)',
    rank: 181,
    cap: '57000000',
    daily: const_('0.03'),
    baseVmc: '0.03',
    currentVmc: '0.12',
  },
  {
    cmcId: 990011,
    symbol: 'STBL',
    name: 'Stable Dollar (fixture)',
    rank: 190,
    cap: '56000000',
    tags: ['stablecoin', 'usd-stablecoin'],
    baseVmc: '0.30',
    currentVmc: '0.30',
    lbank: VERIFIED,
  },
  {
    cmcId: 990012,
    symbol: 'TSLAX',
    name: 'Tokenized Stock (fixture)',
    rank: 191,
    cap: '55000000',
    tags: ['tokenized-stock'],
    baseVmc: '0.02',
    currentVmc: '0.05',
    lbank: VERIFIED,
  },
  {
    cmcId: 990013,
    symbol: 'FANX',
    name: 'Fan Token (fixture)',
    rank: 192,
    cap: '54000000',
    tags: ['fan-token', 'sports'],
    daily: const_('0.06'),
    baseVmc: '0.06',
    currentVmc: '0.07',
    lbank: VERIFIED,
  },
  {
    cmcId: 990014,
    symbol: 'WRPX',
    name: 'Wrapped Thing (fixture)',
    rank: 193,
    cap: '53000000',
    tags: ['wrapped-tokens'],
    daily: const_('0.02'),
    baseVmc: '0.02',
    currentVmc: '0.05',
    lbank: VERIFIED,
  },
  {
    cmcId: 990015,
    symbol: 'STAL',
    name: 'Stale Quote (fixture)',
    rank: 200,
    cap: '52000000',
    daily: const_('0.03'),
    baseVmc: '0.03',
    currentVmc: '0.12',
    quote: 'stale',
    lbank: VERIFIED,
  },
  {
    cmcId: 990016,
    symbol: 'NOTS',
    name: 'No Timestamp (fixture)',
    rank: 201,
    cap: '51000000',
    daily: const_('0.03'),
    baseVmc: '0.03',
    currentVmc: '0.12',
    quote: 'no_timestamp',
    lbank: VERIFIED,
  },
  // Zero volume on T−1..T−3 → mean3 = 0 → 3d N/A ZERO_BASELINE.
  {
    cmcId: 990017,
    symbol: 'ZBAS',
    name: 'Zero Baseline (fixture)',
    rank: 202,
    cap: '50000000',
    daily: (o) => ({ vmc: o <= 3 ? '0' : '0.04' }),
    baseVmc: '0.04',
    currentVmc: '0.10',
    lbank: VERIFIED,
  },
  {
    cmcId: 990018,
    symbol: 'YUNG',
    name: 'Young Listing (fixture)',
    rank: 210,
    cap: '49000000',
    ageDays: 10,
    daily: const_('0.05'),
    baseVmc: '0.05',
    currentVmc: '0.20',
    lbank: VERIFIED,
  },
  {
    cmcId: 990019,
    symbol: 'AGE60',
    name: 'Sixty Days Old (fixture)',
    rank: 211,
    cap: '48000000',
    ageDays: 60,
    daily: const_('0.05'),
    baseVmc: '0.05',
    currentVmc: '0.04',
    lbank: VERIFIED,
  },
  {
    cmcId: 990020,
    symbol: 'AGE59',
    name: 'Fifty Nine Days Old (fixture)',
    rank: 212,
    cap: '47000000',
    ageDays: 59,
    daily: const_('0.05'),
    baseVmc: '0.05',
    currentVmc: '0.04',
    lbank: VERIFIED,
  },
  {
    cmcId: 990021,
    symbol: 'NORK',
    name: 'No Rank (fixture)',
    rank: null,
    cap: '46000000',
    daily: const_('0.05'),
    baseVmc: '0.05',
    currentVmc: '0.04',
    lbank: VERIFIED,
  },
  {
    cmcId: 990022,
    symbol: 'NOCAP',
    name: 'No Market Cap (fixture)',
    rank: 220,
    cap: null,
    baseVmc: '0.05',
    currentVmc: '0.05',
    lbank: VERIFIED,
  },
  {
    cmcId: 990023,
    symbol: 'CAP15',
    name: 'Cap Exactly 15M (fixture)',
    rank: 1150,
    cap: '15000000',
    daily: const_('0.05'),
    baseVmc: '0.05',
    currentVmc: '0.04',
    lbank: VERIFIED,
  },
  {
    cmcId: 990024,
    symbol: 'CAPLO',
    name: 'Cap Below 15M (fixture)',
    rank: 1151,
    cap: '14999999.99',
    daily: const_('0.05'),
    baseVmc: '0.05',
    currentVmc: '0.04',
    lbank: VERIFIED,
  },
  {
    cmcId: 990025,
    symbol: 'R100',
    name: 'Rank One Hundred (fixture)',
    rank: 100,
    cap: '900000000',
    baseVmc: '0.05',
    currentVmc: '0.20',
    lbank: VERIFIED,
  },
  {
    cmcId: 990026,
    symbol: 'R101',
    name: 'Rank One Hundred One (fixture)',
    rank: 101,
    cap: '880000000',
    daily: const_('0.05'),
    baseVmc: '0.05',
    currentVmc: '0.04',
    lbank: VERIFIED,
  },
  {
    cmcId: 990027,
    symbol: 'R1200',
    name: 'Rank Twelve Hundred (fixture)',
    rank: 1200,
    cap: '15500000',
    daily: const_('0.05'),
    baseVmc: '0.05',
    currentVmc: '0.04',
    lbank: VERIFIED,
  },
  {
    cmcId: 990028,
    symbol: 'R1201',
    name: 'Rank Twelve Hundred One (fixture)',
    rank: 1201,
    cap: '15400000',
    baseVmc: '0.05',
    currentVmc: '0.20',
    lbank: VERIFIED,
  },
  {
    cmcId: 990029,
    symbol: 'SNGL',
    name: 'Single Venue (fixture)',
    rank: 230,
    cap: '45000000',
    daily: const_('0.04'),
    baseVmc: '0.04',
    currentVmc: '0.10',
    lbank: VERIFIED,
    venues: [{ exchange: LBANK, name: 'LBank', share: 1 }],
  },
];

/** mulberry32 seeded by an FNV-1a hash: deterministic per key. */
function rand(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  let a = h >>> 0;
  a = (a + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const fixed = (x: number, dp: number) => new D(x).toDecimalPlaces(dp).toFixed();

/** Power-law cap by rank: rank 1 ≈ $1.5T, rank 100 ≈ $850M, rank 1200 ≈ $15.6M. */
const capForRank = (rank: number) => 1.5e12 * rank ** -1.62;

function fillers(): Scenario[] {
  const taken = new Set(SCENARIOS.map((s) => s.rank).filter((r): r is number => r !== null));
  const out: Scenario[] = [];
  for (let rank = 1; rank <= FIXTURE_LISTED; rank++) {
    if (taken.has(rank)) continue;
    const cmcId = FILLER_ID_BASE + rank;
    const r = rand(`filler:${cmcId}`);
    const base = 0.01 + 0.15 * rand(`base:${cmcId}`);
    const inBand = rank >= 101 && rank <= 1200;
    const lbank =
      inBand && r < 0.18
        ? [{ quote: 'USDT', trading: r < 0.15 }]
        : rank <= 100 && r < 0.5
          ? VERIFIED
          : undefined;
    out.push({
      cmcId,
      symbol: `F${String(rank).padStart(4, '0')}`,
      name:
        rank === 1
          ? 'Bitcoin (fixture)'
          : rank === 2
            ? 'Ethereum (fixture)'
            : `Filler ${String(rank).padStart(4, '0')} (fixture)`,
      rank,
      cap: fixed(capForRank(rank) * (1 + 0.02 * (rand(`cap:${cmcId}`) - 0.5)), 2),
      tags: r > 0.95 ? ['meme'] : r > 0.9 ? ['defi'] : [],
      ageDays: 200 + Math.floor(3000 * rand(`age:${cmcId}`)),
      baseVmc: fixed(base, 6),
      currentVmc: fixed(base * (0.5 + 2.2 * rand(`cur:${cmcId}`)), 6),
      lbank,
    });
  }
  return out;
}

export class FixtureCmcMarket {
  private readonly all: Scenario[] = [...SCENARIOS, ...fillers()];
  private readonly byId = new Map(this.all.map((s) => [s.cmcId, s]));

  /** `anchorDate` = UTC date on which the designed cases hold (stored once per database). */
  constructor(private readonly anchorDate: string) {}

  static scenarioIds(): number[] {
    return SCENARIOS.map((s) => s.cmcId);
  }

  /** Daily VMC of an asset on a UTC date (pure in asset + date). */
  private dailyVmc(s: Scenario, date: string): { vmc: string } | 'missing' | 'invalid' {
    const offset = Math.round(
      (parseIsoDate(this.anchorDate).getTime() - parseIsoDate(date).getTime()) / DAY_MS,
    );
    if (s.daily && offset >= 1 && offset <= 40) return s.daily(offset);
    const noise = 0.7 + 0.6 * rand(`day:${s.cmcId}:${date}`);
    return { vmc: fixed(Number(s.baseVmc) * noise, 6) };
  }

  dailyRows(cmcId: number, from: string, to: string): DailySourceRow[] {
    const s = this.byId.get(cmcId);
    if (!s) return [];
    const added = this.dateAdded(s);
    const rows: DailySourceRow[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (added && parseIsoDate(d) < added) continue;
      const v = this.dailyVmc(s, d);
      if (v === 'missing') continue;
      const cap = s.cap ?? '0';
      const capDay = v === 'invalid' ? '0' : cap;
      const volume = new D(v === 'invalid' ? '0.05' : v.vmc).times(cap).toFixed(2);
      const open = new Date(`${d}T00:00:00.000Z`);
      const close = new Date(open.getTime() + DAY_MS - 1);
      const price = fixed(
        1 + 10 * rand(`px:${cmcId}`) * (0.9 + 0.2 * rand(`pxd:${cmcId}:${d}`)),
        8,
      );
      rows.push({
        cmcId,
        dateUtc: d,
        volume,
        marketCap: capDay,
        open: price,
        high: price,
        low: price,
        close: price,
        invalidReasons: [],
        periodStart: open,
        periodEnd: close,
        sourceCloseAt: close,
        sourceFields: { synthetic: true, volume, marketCap: capDay, close: price },
      });
    }
    return rows;
  }

  /** Fixed listing date: `ageDays` before the start of the anchor date (null = not reported). */
  private dateAdded(s: Scenario): Date | null {
    if (s.ageDays === null) return null;
    return new Date(parseIsoDate(this.anchorDate).getTime() - (s.ageDays ?? 900) * DAY_MS);
  }

  /** Listing observations for a slot (every coin; rank, tags, date added and USD quote). */
  observations(slot: Date): RawObservation[] {
    const date = isoDate(slot);
    return this.all.map((s) => {
      const vmc =
        date === this.anchorDate
          ? s.currentVmc
          : fixed(Number(s.baseVmc) * (0.6 + 1.6 * rand(`cur:${s.cmcId}:${date}`)), 6);
      const cap = s.cap === null ? null : Number(s.cap);
      const volume =
        cap === null
          ? Number(new D(s.baseVmc).times(50_000_000))
          : Number(new D(vmc).times(s.cap!));
      const price = 1 + 10 * rand(`px:${s.cmcId}`);
      const observedAt =
        s.quote === 'no_timestamp'
          ? null
          : s.quote === 'stale'
            ? new Date(slot.getTime() - 5 * 3_600_000)
            : new Date(slot.getTime() + 3 * 60_000);
      const slug = s.symbol.toLowerCase();
      return {
        providerAssetId: String(s.cmcId),
        name: s.name,
        symbol: s.symbol,
        sourceUrl: `fixture://cmc/${s.cmcId}`,
        observedAt,
        price,
        marketCap: cap,
        fullyDilutedValuation: cap === null ? null : cap * 1.2,
        circulatingSupply: cap === null ? null : cap / price,
        volume24h: volume,
        changePct1h: null,
        changePct24h: null,
        changePct7d: null,
        categories: [],
        rank: s.rank,
        dateAdded: this.dateAdded(s),
        tags: s.tags ?? [],
        slug,
        platform: null,
      };
    });
  }

  /** Synthetic LBank Spot pairs. Unlike CMC data, this feed carries an explicit trading status. */
  lbankPairs(at: Date): VenuePair[] {
    const out: VenuePair[] = [];
    for (const s of this.all) {
      for (const p of s.lbank ?? []) {
        const base = p.base ?? s.symbol;
        out.push({
          exchange: LBANK,
          exchangeName: 'LBank',
          marketPair: `${base}/${p.quote}`,
          category: 'spot',
          baseSymbol: base,
          baseCurrencyId: s.cmcId,
          quoteSymbol: p.quote,
          quoteCurrencyId: p.quote === 'USDT' ? 825 : 1,
          volumeUsd: fixed(1e5 + 5e6 * rand(`lb:${s.cmcId}:${p.quote}`), 2),
          volumePercent: null,
          priceUsd: null,
          lastUpdated: new Date(at.getTime() - 60_000).toISOString(),
          marketUrl: null,
          tradingStatus: p.trading ? 'TRADING' : null,
          type: 'cex',
          flags: [],
        });
      }
    }
    return out;
  }

  /** Synthetic CMC Markets spot pairs for one asset. */
  assetMarkets(cmcId: number, at: Date): { pairs: VenuePair[]; expected: number } {
    const s = this.byId.get(cmcId);
    if (!s) return { pairs: [], expected: 0 };
    const venues = s.venues ?? [
      { exchange: 'binance', name: 'Binance', share: 0.4 },
      { exchange: 'okx', name: 'OKX', share: 0.25 },
      { exchange: 'gate', name: 'Gate', share: 0.2 },
      { exchange: LBANK, name: 'LBank', share: 0.15 },
    ];
    const total = 1e7 * (1 + rand(`mk:${cmcId}`));
    const pairs = venues.map((v) => ({
      exchange: v.exchange,
      exchangeName: v.name,
      marketPair: `${s.symbol}/USDT`,
      category: 'spot',
      baseSymbol: s.symbol,
      baseCurrencyId: cmcId,
      quoteSymbol: 'USDT',
      quoteCurrencyId: 825,
      volumeUsd: fixed(total * v.share, 2),
      volumePercent: fixed(v.share * 100, 4),
      priceUsd: null,
      lastUpdated: new Date(at.getTime() - 120_000).toISOString(),
      marketUrl: null,
      tradingStatus: null,
      type: 'cex',
      flags: [],
    }));
    return { pairs, expected: pairs.length };
  }
}
