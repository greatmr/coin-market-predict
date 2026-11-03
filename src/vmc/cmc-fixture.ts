import { HOUR_MS } from "./window.js";

/**
 * OFFLINE fixture transport for the CoinMarketCap client. It answers the same documented
 * endpoints with deterministic SYNTHETIC numbers shaped like the documented responses, for
 * real CMC ids (1 = Bitcoin, 2 = Litecoin, 1027 = Ethereum, ...). Every payload carries
 * `status.notice = "SYNTHETIC FIXTURE"`; runs using it are stored with isFixture = true.
 * Base magnitudes loosely follow the PDF's page-6 screenshot; values are NOT market data.
 */

interface Spec {
  name: string;
  symbol: string;
  slug: string;
  first: string;
  mcap: number;
  ratio: number;
}

export const FIXTURE_ASSETS: Record<number, Spec> = {
  1: { name: "Bitcoin", symbol: "BTC", slug: "bitcoin", first: "2013-04-28T18:47:21.000Z", mcap: 1.55e12, ratio: 0.016 },
  2: { name: "Litecoin", symbol: "LTC", slug: "litecoin", first: "2013-04-28T18:47:22.000Z", mcap: 4.2e9, ratio: 0.036 },
  1027: { name: "Ethereum", symbol: "ETH", slug: "ethereum", first: "2015-08-07T14:49:30.000Z", mcap: 2.78e11, ratio: 0.031 },
  825: { name: "Tether USDt", symbol: "USDT", slug: "tether", first: "2015-02-25T13:34:26.000Z", mcap: 1.788e11, ratio: 0.3 },
  52: { name: "XRP", symbol: "XRP", slug: "xrp", first: "2013-08-04T18:51:00.000Z", mcap: 8.1e10, ratio: 0.02 },
  5426: { name: "Solana", symbol: "SOL", slug: "solana", first: "2020-04-10T04:40:00.000Z", mcap: 5.48e10, ratio: 0.048 },
};

const NOTICE = "SYNTHETIC FIXTURE — generated locally, not CoinMarketCap data";

function h(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return (x >>> 0) / 4294967296;
}

function values(id: number, t: number) {
  const s = FIXTURE_ASSETS[id]!;
  const day = Math.floor(t / 86_400_000);
  const mcap = s.mcap * (1 + 0.08 * Math.sin(day / 9 + id) + 0.01 * (h(`${id}m${t}`) - 0.5));
  const vol = mcap * s.ratio * (0.6 + 0.8 * h(`${id}v${Math.floor(t / HOUR_MS)}`));
  return { market_cap: Number(mcap.toFixed(2)), volume_24h: Number(vol.toFixed(2)), price: Number((mcap / 1e8).toFixed(6)) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ok = (data: unknown, credits: number, now: Date) => ({
  status: { timestamp: now.toISOString(), error_code: 0, error_message: null, elapsed: 1, credit_count: credits, notice: NOTICE },
  data,
});

export function fixtureFetch(now: () => Date = () => new Date()): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const p = url.searchParams;
    const ids = (p.get("id") ?? "").split(",").filter(Boolean).map(Number).filter((i) => FIXTURE_ASSETS[i]);
    const n = now();
    switch (url.pathname) {
      case "/v1/key/info":
        return json(ok({ plan: { credit_limit_monthly: 15000, credit_limit_monthly_reset: "fixture", credit_limit_monthly_reset_timestamp: null, rate_limit_minute: 50 }, usage: { current_month: { credits_used: 0, credits_left: 15000 } } }, 0, n));
      case "/v1/cryptocurrency/map":
        return json(ok(Object.entries(FIXTURE_ASSETS).map(([id, s]) => ({ id: Number(id), name: s.name, symbol: s.symbol, slug: s.slug, is_active: 1, first_historical_data: s.first, last_historical_data: n.toISOString() })), 0, n));
      case "/v3/cryptocurrency/quotes/latest":
        return json(
          ok(
            ids.map((id) => {
              const s = FIXTURE_ASSETS[id]!;
              const at = new Date(n.getTime() - 120_000);
              return { id, name: s.name, symbol: s.symbol, slug: s.slug, last_updated: at.toISOString(), quote: [{ id: 2781, symbol: "USD", ...values(id, at.getTime()), last_updated: at.toISOString() }] };
            }),
            Math.max(1, Math.ceil(ids.length / 250)),
            n,
          ),
        );
      case "/v3/cryptocurrency/quotes/historical": {
        const interval = p.get("interval");
        const start = new Date(p.get("time_start") ?? n.toISOString()).getTime();
        const end = new Date(p.get("time_end") ?? n.toISOString()).getTime();
        const step = interval === "daily" ? 86_400_000 : HOUR_MS;
        let points = 0;
        const data: Record<string, unknown> = {};
        for (const id of ids) {
          const s = FIXTURE_ASSETS[id]!;
          const quotes = [];
          const firstHist = new Date(s.first).getTime();
          for (let t = Math.ceil(start / step) * step; t <= end; t += step) {
            if (t < firstHist || t > n.getTime()) continue;
            const at = t + Math.floor(h(`${id}o${t}`) * 4) * 60_000 + 7_000; // first quote of the period
            if (at > end || at > n.getTime()) continue;
            quotes.push({ timestamp: new Date(at).toISOString(), quote: { USD: { ...values(id, at), timestamp: new Date(at).toISOString() } } });
          }
          points += quotes.length;
          data[String(id)] = { id, name: s.name, symbol: s.symbol, is_active: 1, is_fiat: 0, quotes };
        }
        return json(ok(data, Math.max(1, Math.ceil(points / 100)), n));
      }
      case "/v2/cryptocurrency/ohlcv/historical": {
        // The fixture models a plan without OHLCV access, which the probe must detect.
        return json({ status: { timestamp: n.toISOString(), error_code: 1006, error_message: "Your API Key subscription plan doesn't support this endpoint.", credit_count: 0, notice: NOTICE } }, 403);
      }
      default:
        return json({ status: { error_code: 400, error_message: `fixture: unsupported ${url.pathname}`, credit_count: 0 } }, 400);
    }
  }) as typeof fetch;
}
