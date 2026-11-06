/** Providers whose asset ids are CoinMarketCap numeric ids (the fixture uses CMC-shaped synthetic ids). */
export const CMC_ID_PROVIDERS: ReadonlySet<string> = new Set([
  'coinmarketcap_web',
  'coinmarketcap',
  'fixture',
]);

export const isCmcIdProvider = (providerId: string) => CMC_ID_PROVIDERS.has(providerId);
