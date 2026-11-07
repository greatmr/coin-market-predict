/** Provider asset ids of the BTC and ETH benchmarks, per provider. */
export const BENCHMARK_IDS: Record<string, { btc: string; eth: string }> = {
  fixture: { btc: '990101', eth: '990102' },
  coinmarketcap: { btc: '1', eth: '1027' },
  coinmarketcap_web: { btc: '1', eth: '1027' },
  coingecko: { btc: 'bitcoin', eth: 'ethereum' },
};

/**
 * Provider ids of assets whose wrapped / staked / bridged variants trade near their price.
 * Used only as classification evidence (see `trackedExposure`), never as data.
 */
export const REFERENCE_IDS: Record<
  string,
  Partial<Record<'bitcoin' | 'ethereum' | 'solana' | 'binancecoin', string>>
> = {
  fixture: { bitcoin: '990101', ethereum: '990102' },
  coinmarketcap: { bitcoin: '1', ethereum: '1027', solana: '5426', binancecoin: '1839' },
  coinmarketcap_web: { bitcoin: '1', ethereum: '1027', solana: '5426', binancecoin: '1839' },
  coingecko: {
    bitcoin: 'bitcoin',
    ethereum: 'ethereum',
    solana: 'solana',
    binancecoin: 'binancecoin',
  },
};
