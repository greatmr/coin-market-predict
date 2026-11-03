import { redact } from "../config/redact.js";
import { sleep as realSleep } from "../common/time.js";
import { parseRetryAfter } from "../sources/http/polite-client.js";
import { parseExactJson } from "./decimal.js";
import { parseStatus } from "./cmc-parse.js";

export const CMC_BASE_URL = "https://pro-api.coinmarketcap.com";

export type CmcErrorKind =
  | "auth" // 401, 1001/1002/1005/1007
  | "billing" // 402, 1003/1004
  | "plan_not_authorized" // 403 + 1006: endpoint not in the plan
  | "credits_exhausted" // 429 + 1009/1010
  | "rate_limited" // 429 + 1008/1011, retried
  | "bad_request" // 400
  | "server" // 5xx, retried
  | "network" // timeout / connection, retried
  | "budget" // local monthly credit budget reached
  | "invalid_response";

const PERMANENT: ReadonlySet<CmcErrorKind> = new Set(["auth", "billing", "plan_not_authorized", "credits_exhausted", "bad_request", "budget", "invalid_response"]);

export class CmcApiError extends Error {
  constructor(
    public readonly kind: CmcErrorKind,
    message: string,
    public readonly httpStatus: number | null,
    public readonly errorCode: number | null,
  ) {
    super(message);
    this.name = "CmcApiError";
  }
  get permanent() {
    return PERMANENT.has(this.kind);
  }
}

export function classify(httpStatus: number, errorCode: number | null): CmcErrorKind {
  if (errorCode === 1006) return "plan_not_authorized";
  if (errorCode === 1009 || errorCode === 1010) return "credits_exhausted";
  if (errorCode === 1008 || errorCode === 1011) return "rate_limited";
  if (errorCode !== null && [1001, 1002, 1005, 1007].includes(errorCode)) return "auth";
  if (errorCode === 1003 || errorCode === 1004) return "billing";
  if (httpStatus === 401) return "auth";
  if (httpStatus === 402) return "billing";
  if (httpStatus === 403) return "plan_not_authorized";
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus === 400) return "bad_request";
  return "server";
}

export interface RawRecord {
  endpoint: string;
  params: Record<string, string>;
  httpStatus: number | null;
  errorCode: number | null;
  creditCount: number | null;
  retrievedAt: Date;
  body: string;
}

export interface CmcClientOptions {
  apiKey: string | undefined;
  requestsPerMinute: number;
  maxRetries: number;
  monthlyCreditBudget: number;
  creditsUsedThisMonth: () => Promise<number>;
  record: (r: RawRecord) => Promise<string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  timeoutMs?: number;
  baseUrl?: string;
}

export interface CmcResponse {
  body: unknown;
  rawResponseId: string;
  creditCount: number;
  retrievedAt: Date;
}

/**
 * Client for documented CoinMarketCap Pro API endpoints. The key travels only in the
 * `X-CMC_PRO_API_KEY` header (never in the URL or stored params). Requests are sequential per
 * client and rate-limited; retries are bounded with exponential backoff, jitter and Retry-After.
 */
export class CmcClient {
  private lastAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  creditsThisRun = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly o: CmcClientOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? realSleep;
    this.now = o.now ?? (() => new Date());
  }

  get(endpoint: string, params: Record<string, string | number>, estimatedCredits = 1): Promise<CmcResponse> {
    const run = this.queue.then(() => this.doGet(endpoint, params, estimatedCredits));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doGet(endpoint: string, rawParams: Record<string, string | number>, estimatedCredits: number): Promise<CmcResponse> {
    if (!this.o.apiKey) throw new CmcApiError("auth", "CMC_API_KEY is not configured", null, null);
    const params = Object.fromEntries(Object.entries(rawParams).map(([k, v]) => [k, String(v)]));
    if (Object.keys(params).some((k) => /api.?key/i.test(k))) throw new Error("API keys must not be passed as query parameters");
    const used = await this.o.creditsUsedThisMonth();
    if (used + estimatedCredits > this.o.monthlyCreditBudget) {
      throw new CmcApiError("budget", `local monthly credit budget reached (${used} used, budget ${this.o.monthlyCreditBudget})`, null, null);
    }
    const url = `${this.o.baseUrl ?? CMC_BASE_URL}${endpoint}?${new URLSearchParams(params)}`;

    for (let attempt = 1; ; attempt++) {
      const wait = this.lastAt + 60_000 / this.o.requestsPerMinute - this.now().getTime();
      if (wait > 0) await this.sleep(wait);
      this.lastAt = this.now().getTime();
      const retrievedAt = this.now();
      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(url, {
          headers: { accept: "application/json", "X-CMC_PRO_API_KEY": this.o.apiKey, "user-agent": "CoinsPredicts/0.1" },
          signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
        });
        text = await res.text();
      } catch (err) {
        await this.o.record({ endpoint, params, httpStatus: null, errorCode: null, creditCount: null, retrievedAt, body: redact(String(err)) });
        if (attempt > this.o.maxRetries) throw new CmcApiError("network", `network error after ${attempt} attempts: ${redact(err)}`, null, null);
        await this.sleep(this.backoff(attempt));
        continue;
      }

      let body: unknown;
      try {
        body = parseExactJson(text);
      } catch {
        body = null;
      }
      const status = parseStatus(body);
      const credit = status?.creditCount ?? null;
      const rawId = await this.o.record({ endpoint, params, httpStatus: res.status, errorCode: status?.errorCode ?? null, creditCount: credit, retrievedAt, body: text });
      if (credit) this.creditsThisRun += credit;

      if (res.ok && body !== null && (status?.errorCode ?? 0) === 0) {
        return { body, rawResponseId: rawId, creditCount: credit ?? 0, retrievedAt };
      }
      if (res.ok && body === null) throw new CmcApiError("invalid_response", "response was not valid JSON", res.status, null);

      const code = status && status.errorCode !== 0 ? status.errorCode : null;
      const kind = res.ok ? classify(400, code) : classify(res.status, code);
      const msg = `HTTP ${res.status}${code ? ` error_code ${code}` : ""}: ${redact(status?.errorMessage ?? "")}`.trim();
      if (PERMANENT.has(kind) || attempt > this.o.maxRetries) throw new CmcApiError(kind, msg, res.status, code);
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"), this.now());
      // CMC: the per-minute limit (1008) resets every 60 s.
      const delay = Math.max(retryAfter ?? 0, kind === "rate_limited" ? 60_000 : 0, this.backoff(attempt));
      await this.sleep(Math.min(delay, 5 * 60_000));
    }
  }

  private backoff(attempt: number): number {
    const exp = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
    return Math.round(exp / 2 + Math.random() * (exp / 2));
  }
}
