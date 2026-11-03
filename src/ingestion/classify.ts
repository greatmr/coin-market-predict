/**
 * Asset classification used for exclusion. Provider categories win; name/symbol heuristics
 * only ever make an asset MORE excluded (never promote an excluded asset to "regular").
 */
export interface Classification {
  assetClass: "regular" | "stablecoin" | "wrapped" | "bridged" | "staked";
  classSource: "provider_category" | "heuristic_name" | "heuristic_symbol" | "default";
  underlyingAsset: string | null;
}

const STABLE_SYMBOLS = new Set([
  "USDT", "USDC", "DAI", "FDUSD", "TUSD", "USDE", "PYUSD", "USDS", "BUSD", "USDD", "FRAX", "LUSD", "GUSD",
  "USDP", "EURC", "EURT", "USD0", "RLUSD", "USDX", "SUSD", "CRVUSD", "GHO", "USDB", "USDY", "USTC", "XAUT", "PAXG",
]);

const UNDERLYING: Array<[RegExp, string]> = [
  [/\bbitcoin\b|\bbtc\b/i, "bitcoin"],
  [/\bether(eum)?\b|\beth\b/i, "ethereum"],
  [/\bsol(ana)?\b/i, "solana"],
  [/\bbnb\b/i, "binancecoin"],
];

export function classifyAsset(input: { name: string; symbol: string; categories?: string[] }): Classification {
  const cats = (input.categories ?? []).map((c) => c.toLowerCase());
  const name = input.name;
  const underlying = () => UNDERLYING.find(([re]) => re.test(name))?.[1] ?? null;

  if (cats.some((c) => c.includes("stablecoin"))) return { assetClass: "stablecoin", classSource: "provider_category", underlyingAsset: null };
  if (cats.some((c) => c.includes("wrapped"))) return { assetClass: "wrapped", classSource: "provider_category", underlyingAsset: underlying() };
  if (cats.some((c) => c.includes("bridged"))) return { assetClass: "bridged", classSource: "provider_category", underlyingAsset: underlying() };
  if (cats.some((c) => c.includes("liquid-staking") || c.includes("staked"))) return { assetClass: "staked", classSource: "provider_category", underlyingAsset: underlying() };

  if (/\bwrapped\b/i.test(name)) return { assetClass: "wrapped", classSource: "heuristic_name", underlyingAsset: underlying() };
  if (/\bbridged\b|\(wormhole\)|\(portal\)|\(multichain\)/i.test(name)) return { assetClass: "bridged", classSource: "heuristic_name", underlyingAsset: underlying() };
  if (/\bstaked\b|\bliquid staking\b/i.test(name)) return { assetClass: "staked", classSource: "heuristic_name", underlyingAsset: underlying() };
  if (/\bstablecoin\b|\busd\b.*\bcoin\b/i.test(name) || STABLE_SYMBOLS.has(input.symbol.toUpperCase()))
    return { assetClass: "stablecoin", classSource: STABLE_SYMBOLS.has(input.symbol.toUpperCase()) ? "heuristic_symbol" : "heuristic_name", underlyingAsset: null };

  return { assetClass: "regular", classSource: "default", underlyingAsset: null };
}

/** Rank so that re-classification never relaxes an exclusion. */
const SEVERITY: Record<Classification["assetClass"], number> = { regular: 0, staked: 1, bridged: 2, wrapped: 3, stablecoin: 4 };

export function stricterClass(a: string, b: Classification["assetClass"]): boolean {
  return (SEVERITY[b] ?? 0) > (SEVERITY[a as Classification["assetClass"]] ?? 0);
}
