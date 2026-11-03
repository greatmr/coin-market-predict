import type { CollectOptions, CollectResult, DiscoveryResult, MarketDataSource, SourceAsset } from "../types.js";
import { redact } from "../../config/redact.js";
import { CmcWebClient, CMC_WEB_PROVIDER, WEB_LISTING, WEB_CHART } from "./client.js";
import { parseWebListing, parseWebMarketHistory } from "./parse.js";

const PAGE_SIZE = 200;

export class CoinMarketCapWebSource implements MarketDataSource {
  readonly info = CMC_WEB_PROVIDER;
  private discoveryPage: { at: number; data: Awaited<ReturnType<CoinMarketCapWebSource["sweep"]>> } | null = null;
  constructor(private readonly client: CmcWebClient, private readonly discoveryMaxPages = 50) {}

  private async sweep(maxPages: number) {
    const before = this.client.requestsMade;
    const assets = new Map<string, ReturnType<typeof parseWebListing>["assets"][number]>();
    const observations = new Map<string, ReturnType<typeof parseWebListing>["observations"][number]>();
    let total = 0, pages = 0, skipped = 0, complete = false;
    const notes: string[] = [];
    while (pages < maxPages) {
      let page: ReturnType<typeof parseWebListing>;
      try {
        const r = await this.client.get(WEB_LISTING, { start: pages * PAGE_SIZE + 1, limit: PAGE_SIZE, convertId: 2781, sortBy: "market_cap", sortType: "desc", cryptoType: "all", tagType: "all", audited: "false" });
        page = parseWebListing(r.body);
      } catch (err) {
        if (pages === 0) throw err;
        notes.push(`listing stopped on page ${pages + 1}: ${redact(err).slice(0, 250)}`);
        break;
      }
      pages++;
      total = page.total;
      skipped += page.skipped;
      const previous = assets.size;
      page.assets.forEach((a) => assets.set(a.providerAssetId, a));
      page.observations.forEach((o) => observations.set(o.providerAssetId, o));
      // Featured coins may be repeated on every page. Only unique ids count toward coverage.
      if (assets.size >= total && skipped === 0 && total > 0) { complete = true; break; }
      if (page.count === 0 || assets.size === previous) { notes.push("listing ended or repeated before all reported assets were collected"); break; }
    }
    if (!complete) notes.push(`partial website coverage: ${assets.size}/${total} unique coins in ${pages} pages`);
    if (skipped) notes.push(`${skipped} malformed listing entries skipped`);
    return { assets: [...assets.values()], observations: [...observations.values()], total, pages, complete, notes, requests: this.client.requestsMade - before };
  }

  async discover(): Promise<DiscoveryResult> {
    const s = await this.sweep(this.discoveryMaxPages);
    this.discoveryPage = { at: Date.now(), data: s };
    return { assets: s.assets, complete: s.complete, sourceTotal: s.total, pagesFetched: s.pages, requestsUsed: s.requests, categoryMembers: {}, notes: s.notes };
  }

  async collect(opts: CollectOptions): Promise<CollectResult> {
    const cached = this.discoveryPage;
    this.discoveryPage = null;
    const reuse = cached && Date.now() - cached.at < 60_000 && opts.maxPages === this.discoveryMaxPages;
    const s = reuse ? { ...cached.data, requests: 0 } : await this.sweep(opts.maxPages);
    return { observations: s.observations, complete: s.complete, universeSize: s.total, pagesFetched: s.pages, requestsUsed: s.requests, notes: s.notes, quoteCurrency: "USD" };
  }

  async history(asset: SourceAsset, from: Date, to: Date) {
    const r = await this.client.get(WEB_CHART, { id: asset.providerAssetId, range: "7D", convertId: 2781 });
    return parseWebMarketHistory(r.body, asset, from, to);
  }
}
