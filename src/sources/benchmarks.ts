/** Provider asset ids of the BTC and ETH benchmarks, per provider. */
export const BENCHMARK_IDS: Record<string, { btc: string; eth: string }> = {
  fixture: { btc: "fx-bitcoin", eth: "fx-ethereum" },
  coinmarketcap: { btc: "1", eth: "1027" },
  coingecko: { btc: "bitcoin", eth: "ethereum" },
};
