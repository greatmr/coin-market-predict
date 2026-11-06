/**
 * Asset classification used for exclusion. Provider categories win; name/symbol and price
 * heuristics only ever make an asset MORE excluded (never promote an excluded asset to "regular").
 */
/** Stored asset classes (`asset.asset_class`); "unknown" until discovery or collection classifies it. */
export const ASSET_CLASSES = [
  'regular',
  'stablecoin',
  'tokenized',
  'wrapped',
  'bridged',
  'staked',
  'unknown',
] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export interface Classification {
  assetClass: Exclude<AssetClass, 'unknown'>;
  classSource:
    'provider_category' | 'heuristic_name' | 'heuristic_symbol' | 'heuristic_price' | 'default';
  underlyingAsset: string | null;
}

const STABLE_SYMBOLS = new Set([
  'USDT',
  'USDC',
  'DAI',
  'FDUSD',
  'TUSD',
  'USDE',
  'PYUSD',
  'USDS',
  'BUSD',
  'USDD',
  'FRAX',
  'LUSD',
  'GUSD',
  'USDP',
  'EURC',
  'EURT',
  'USD0',
  'RLUSD',
  'USDX',
  'SUSD',
  'CRVUSD',
  'GHO',
  'USDB',
  'USDY',
  'USTC',
  'XAUT',
  'PAXG',
]);

const UNDERLYING: Array<[RegExp, string]> = [
  [/\bbitcoin\b|\bbtc\b/i, 'bitcoin'],
  [/\bether(eum)?\b|\beth\b/i, 'ethereum'],
  [/\bsol(ana)?\b/i, 'solana'],
  [/\bbnb\b/i, 'binancecoin'],
];

/** Category emitted by `trackedExposure`: "tracks:<underlying>" or "pegged:usd". */
export const TRACKS_PREFIX = 'tracks:';
export const PEGGED_USD = 'pegged:usd';

export function classifyAsset(input: {
  name: string;
  symbol: string;
  categories?: string[];
}): Classification {
  const cats = (input.categories ?? []).map((c) => c.toLowerCase());
  const name = input.name;
  const underlying = () => UNDERLYING.find(([re]) => re.test(name))?.[1] ?? null;

  if (cats.some((c) => c.includes('stablecoin')))
    return { assetClass: 'stablecoin', classSource: 'provider_category', underlyingAsset: null };
  if (cats.some((c) => c.includes('tokenized')))
    return { assetClass: 'tokenized', classSource: 'provider_category', underlyingAsset: null };
  if (cats.some((c) => c.includes('wrapped')))
    return {
      assetClass: 'wrapped',
      classSource: 'provider_category',
      underlyingAsset: underlying(),
    };
  if (cats.some((c) => c.includes('bridged')))
    return {
      assetClass: 'bridged',
      classSource: 'provider_category',
      underlyingAsset: underlying(),
    };
  if (cats.some((c) => c.includes('liquid-staking') || c.includes('staked')))
    return {
      assetClass: 'staked',
      classSource: 'provider_category',
      underlyingAsset: underlying(),
    };

  if (/\bwrapped\b/i.test(name))
    return { assetClass: 'wrapped', classSource: 'heuristic_name', underlyingAsset: underlying() };
  if (/\bbridged\b|\(wormhole\)|\(portal\)|\(multichain\)/i.test(name))
    return { assetClass: 'bridged', classSource: 'heuristic_name', underlyingAsset: underlying() };
  if (/\bstaked\b|\bliquid staking\b/i.test(name))
    return { assetClass: 'staked', classSource: 'heuristic_name', underlyingAsset: underlying() };
  if (
    /\bstablecoin\b|\busd\b.*\bcoin\b/i.test(name) ||
    STABLE_SYMBOLS.has(input.symbol.toUpperCase())
  )
    return {
      assetClass: 'stablecoin',
      classSource: STABLE_SYMBOLS.has(input.symbol.toUpperCase())
        ? 'heuristic_symbol'
        : 'heuristic_name',
      underlyingAsset: null,
    };

  const tracked = cats.find((c) => c.startsWith(TRACKS_PREFIX));
  if (tracked)
    return {
      assetClass: 'wrapped',
      classSource: 'heuristic_price',
      underlyingAsset: tracked.slice(TRACKS_PREFIX.length),
    };
  if (cats.includes(PEGGED_USD))
    return { assetClass: 'stablecoin', classSource: 'heuristic_price', underlyingAsset: null };

  return { assetClass: 'regular', classSource: 'default', underlyingAsset: null };
}

/** Rank so that re-classification never relaxes an exclusion. */
const SEVERITY: Record<Classification['assetClass'], number> = {
  regular: 0,
  staked: 1,
  bridged: 2,
  wrapped: 3,
  tokenized: 4,
  stablecoin: 5,
};

export function stricterClass(a: string, b: Classification['assetClass']): boolean {
  return (SEVERITY[b] ?? 0) > (SEVERITY[a as Classification['assetClass']] ?? 0);
}

const TRACKED: Array<{ key: 'bitcoin' | 'ethereum' | 'solana' | 'binancecoin'; pattern: RegExp }> =
  [
    { key: 'bitcoin', pattern: /btc|bitcoin/i },
    { key: 'ethereum', pattern: /eth|ether/i },
    { key: 'solana', pattern: /sol/i },
    { key: 'binancecoin', pattern: /bnb/i },
  ];

/**
 * Price evidence of tracked exposure for coins whose tags do not say so (wstETH, LBTC, BTCB,
 * slisBNBx, tBTC, …): priced within 0.9×–1.4× of BTC/ETH/SOL/BNB *and* naming that asset in its
 * name or symbol; or USD-named and pinned to $1 (within 3%, < 0.5% 24h and < 1% 7d moves).
 * Requiring both conditions avoids coincidences; on the 2026-11-03 CoinMarketCap listing every
 * match inside the strategy floors was a wrapped, staked, bridged or pegged token.
 */
export function trackedExposure(
  o: {
    name: string;
    symbol: string;
    price: number | null;
    changePct24h?: number | null;
    changePct7d?: number | null;
  },
  refs: Partial<Record<'bitcoin' | 'ethereum' | 'solana' | 'binancecoin', number | null>>,
): string | null {
  const p = o.price;
  if (p === null || !Number.isFinite(p) || p <= 0) return null;
  const label = `${o.symbol} ${o.name}`;
  for (const t of TRACKED) {
    const ref = refs[t.key];
    if (ref && p >= 0.9 * ref && p <= 1.4 * ref && t.pattern.test(label))
      return `${TRACKS_PREFIX}${t.key}`;
  }
  const quiet = (x: number | null | undefined, max: number) =>
    typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < max;
  if (
    p >= 0.97 &&
    p <= 1.03 &&
    /usd/i.test(label) &&
    quiet(o.changePct24h, 0.5) &&
    quiet(o.changePct7d, 1)
  )
    return PEGGED_USD;
  return null;
}
