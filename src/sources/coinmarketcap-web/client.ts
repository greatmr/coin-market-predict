import { CmcApiError, type CmcResponse, type RawRecord } from "../../vmc/cmc-client.js";
import { parseStatus } from "../../vmc/cmc-parse.js";
import { parseExactJson } from "../../vmc/decimal.js";
import { PoliteHttpClient, SourceUnavailableError } from "../http/polite-client.js";
import type { ProviderInfo } from "../types.js";
import { parseCoinPage, websiteData } from "./parse.js";

export const CMC_WEB_PROVIDER: ProviderInfo = {
  id: "coinmarketcap_web", name: "CoinMarketCap website", accessMethod: "website", isLive: true,
  baseUrl: "https://api.coinmarketcap.com", termsUrl: "https://coinmarketcap.com/terms/", attribution: "Data: CoinMarketCap",
};
export const WEB_LISTING = "/data-api/v3/cryptocurrency/listing";
export const WEB_DETAIL = "/data-api/v3/cryptocurrency/detail";
export const WEB_HISTORY = "/data-api/v3.1/cryptocurrency/historical";
export const WEB_CHART = "/data-api/v3/cryptocurrency/detail/chart";
export type RecordWebResponse = (r: RawRecord) => Promise<string>;
export interface CmcWebResponse extends CmcResponse {
  endpoint: string;
  params: Record<string, string>;
}

/** CMC's website can return error_code != 0 with HTTP 200. Never ingest that as success. */
export function webResponseStatus(res: Response, text: string): number {
  if (!res.ok) return res.status;
  if (text.trimStart().startsWith("<")) {
    if (/id\s*=\s*["']__NEXT_DATA__["']/.test(text)) return res.status;
    return /captcha|cf-chl-|just a moment|access denied/i.test(text) ? 403 : res.status;
  }
  try {
    const s = parseStatus(parseExactJson(text));
    if (!s) return 422;
    if (s.errorCode === 0) return res.status;
    if ([401, 403, 429].includes(s.errorCode)) return s.errorCode;
    if (/rate.?limit|too many/i.test(s.errorMessage ?? "")) return 429;
    if (/unexpected value|param|invalid/i.test(s.errorMessage ?? "")) return 400;
    return s.errorCode >= 500 ? 503 : 400;
  } catch { return 422; }
}

/** One shared HTTP queue for all website consumers in this application. */
export class CmcWebClient {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cache = new Map<string, { text: string; at: Date }>();
  creditsThisRun = 0;

  constructor(readonly http: PoliteHttpClient, private readonly cacheMs = 60_000, private readonly now: () => Date = () => new Date()) {}

  get requestsMade() { return this.http.requestsMade; }

  get(endpoint: string, rawParams: Record<string, string | number> = {}, record?: RecordWebResponse): Promise<CmcWebResponse> {
    const run = this.queue.then(() => this.request(endpoint, rawParams, record));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async request(endpoint: string, rawParams: Record<string, string | number>, record?: RecordWebResponse): Promise<CmcWebResponse> {
    const page = /^\/currencies\/[a-z0-9-]+\/$/.test(endpoint);
    if (!page && ![WEB_LISTING, WEB_DETAIL, WEB_HISTORY, WEB_CHART].includes(endpoint)) throw new Error("Unsupported CMC website endpoint");
    const params = Object.fromEntries(Object.entries(rawParams).map(([k, v]) => [k, String(v)]));
    const query = new URLSearchParams(params).toString();
    const url = `${page ? "https://coinmarketcap.com" : CMC_WEB_PROVIDER.baseUrl}${endpoint}${query ? `?${query}` : ""}`;
    const cached = this.cache.get(url);
    let rawResponseId = "";
    let retrievedAt = this.now();
    const save = async (status: number, text: string, at: Date) => {
      let code: number | null = null;
      try { code = parseStatus(parseExactJson(text))?.errorCode ?? null; } catch { /* HTML has no JSON status. */ }
      if (record) rawResponseId = await record({ endpoint, params, httpStatus: status, errorCode: code, creditCount: 0, retrievedAt: at, body: text });
    };
    let text: string;
    if (cached && this.now().getTime() - cached.at.getTime() < this.cacheMs) {
      text = cached.text;
      retrievedAt = cached.at;
      await save(200, text, retrievedAt);
    } else {
      try {
        text = await this.http.getText(url, async (res, body) => {
          retrievedAt = this.now();
          await save(res.status, body, retrievedAt);
        });
      } catch (err) {
        if (err instanceof SourceUnavailableError) {
          const kind = ["denied", "suspended"].includes(err.reason) ? "auth" : err.reason === "budget_exhausted" ? "budget" : ["retry_after", "circuit_open"].includes(err.reason) || err.httpStatus === 429 ? "rate_limited" : err.httpStatus === 422 ? "invalid_response" : err.httpStatus && err.httpStatus < 500 ? "bad_request" : err.httpStatus ? "server" : "network";
          throw new CmcApiError(kind, err.message, err.httpStatus, null);
        }
        throw err;
      }
      for (const [k, v] of this.cache) if (retrievedAt.getTime() - v.at.getTime() >= this.cacheMs) this.cache.delete(k);
      if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
      if (this.cacheMs > 0) this.cache.set(url, { text, at: retrievedAt });
    }
    return { body: page ? text : parseExactJson(text), rawResponseId, retrievedAt, creditCount: 0, endpoint, params };
  }

  /** Prefer the actual coin page; fall back to its JSON detail endpoint on layout changes. */
  async coin(cmcId: number, slug: string | null, record?: RecordWebResponse): Promise<CmcWebResponse> {
    if (slug && /^[a-z0-9-]+$/.test(slug)) {
      try {
        const r = await this.get(`/currencies/${slug}/`, {}, record);
        return { ...r, body: parseCoinPage(String(r.body), cmcId) };
      }
      catch (err) {
        if (!(err instanceof CmcApiError) || (err.kind !== "invalid_response" && err.httpStatus !== 404)) throw err;
      }
    }
    const r = await this.get(WEB_DETAIL, { id: cmcId, convertId: 2781 }, record);
    return { ...r, body: websiteData(r.body) };
  }
}
