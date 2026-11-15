// Live TradingView chart (1D, UTC candles like CMC's days). TradingView has no LBank Spot data, so
// every symbol is a proxy: first the spot markets CMC lists for this coin id, then the LBank
// perpetual and the ticker index.
//
// Only the advanced-chart widget is embedded, as a sandboxed cross-origin iframe in a fixed-size,
// isolated box: no TradingView script runs in this signed-in page, TradingView cannot resize our
// layout (the former symbol-info strip and its resize messages are gone), and the frame is only
// rebuilt when the symbol or the colour scheme changes.
import { useEffect, useMemo, useState } from 'react';

import { SkeletonBlock } from '../../../components/ui';
import { useApp } from '../../../state/app';

import type { ChartCandidate } from '../types';

const TV_ORIGIN = 'https://www.tradingview-widget.com';

type Scheme = 'light' | 'dark';
/** The scheme the page shows (the theme button, else the system's), for the widget's colours. */
function uiTheme(): Scheme {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Follows the theme button (data-theme on <html>) and the system scheme. */
function useScheme(): Scheme {
  const [scheme, setScheme] = useState<Scheme>(uiTheme);
  useEffect(() => {
    const update = () => setScheme(uiTheme());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', update);
    return () => {
      mo.disconnect();
      mq.removeEventListener('change', update);
    };
  }, []);
  return scheme;
}

export interface FrameProps {
  id: string;
  className: string;
  title: string;
  src: string;
  sandbox: string;
  referrerPolicy: 'no-referrer';
  loading: 'lazy';
}

/**
 * The advanced-chart widget as a sandboxed, cross-origin iframe: the URL TradingView's embed script
 * builds (`/embed-widget/<id>/?locale=en#<settings JSON>`), without running that script in this
 * signed-in page, so it cannot read the page, the session or the API. The id is derived from the
 * symbol, so the same symbol always gives the same frame.
 */
export function tvFrame(symbol: string, scheme: Scheme): FrameProps {
  const id = `tv-${symbol.replace(/[^A-Za-z0-9]+/g, '-')}`;
  const settings = {
    autosize: true,
    symbol,
    interval: 'D',
    timezone: 'Etc/UTC',
    theme: scheme,
    style: '1',
    allow_symbol_change: true,
    withdateranges: true,
    details: false,
    calendar: false,
    save_image: false,
    support_host: 'https://www.tradingview.com',
    frameElementId: id,
    // The embed script also passes the page as `page-uri`; only the host is sent here (no path,
    // coin or query), and the iframe gets no referrer.
    'page-uri': location.host,
  };
  return {
    id,
    className: 'tv-frame tv-advanced-chart',
    title: `TradingView chart of ${symbol}`,
    src: `${TV_ORIGIN}/embed-widget/advanced-chart/?locale=en#${encodeURIComponent(JSON.stringify(settings))}`,
    sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    referrerPolicy: 'no-referrer',
    loading: 'lazy',
  };
}

export const tvChartUrl = (symbol: string) =>
  `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`;

export const PROXY_REASON: Record<string, (c: ChartCandidate) => string> = {
  cmc_venue: (c) =>
    `TradingView has no LBank Spot data; ${c.label} is a spot market CMC lists for this coin.`,
  lbank_perpetual: () => 'TradingView has no LBank Spot data; LBank perpetual of the same coin.',
  ticker_index: (c) =>
    `TradingView has no LBank Spot data; ${c.symbol} index, checked to be this coin.`,
};

/** The review form's chart fields (names match the review API). */
export interface ChartFields {
  chartExchange: string;
  chartSymbol: string;
  chartQuote: string;
  chartUrl: string;
  chartTimezone: string;
  chartProxyReason: string;
}

/** The review form's chart fields for the chart shown (the reviewer still checks them). */
export const chartReviewFields = (c: ChartCandidate): ChartFields => ({
  chartExchange: c.exchange,
  chartSymbol: c.symbol.split(':')[1] || c.symbol,
  chartQuote: c.quote,
  chartUrl: tvChartUrl(c.symbol),
  chartTimezone: 'UTC',
  chartProxyReason: (PROXY_REASON[c.source] || PROXY_REASON.ticker_index!)(c),
});

/** The symbol picked per coin, kept while the page is open. */
const chartSymbols: Record<number, string> = {};

export default function ChartPanel({
  cmcId,
  candidates,
  onUseInReview,
}: {
  cmcId: number;
  candidates: ChartCandidate[];
  onUseInReview?: (fields: ChartFields) => void;
}) {
  const { can } = useApp();
  const scheme = useScheme();
  const [picked, setPicked] = useState<string | undefined>(() => chartSymbols[cmcId]);
  const current = candidates.find((c) => c.symbol === picked) || candidates[0];
  const symbol = current?.symbol ?? null;
  // Rebuilt only for another symbol or colour scheme, never because the trace was reloaded.
  const frame = useMemo(() => (symbol ? tvFrame(symbol, scheme) : null), [symbol, scheme]);
  // Which frame has finished loading; a new symbol or scheme shows the placeholder again.
  const [loadedFrame, setLoadedFrame] = useState<string | null>(null);
  const frameKey = frame ? `${frame.id}-${scheme}` : null;

  const head = (
    <div className="panel-head">
      <h3>Live chart</h3>
      <span className="hint">TradingView, daily candles closing 00:00 UTC</span>
    </div>
  );
  if (!current || !frame)
    return (
      <section className="panel tv-panel">
        {head}
        <div className="empty">No TradingView symbol is known for this coin.</div>
      </section>
    );

  return (
    <section className="panel tv-panel">
      {head}
      <div className="seg tv-seg" role="group" aria-label="Chart symbol">
        {candidates.map((c) => (
          <button
            key={c.symbol}
            type="button"
            aria-pressed={c.symbol === current.symbol}
            title={c.note}
            onClick={() => {
              chartSymbols[cmcId] = c.symbol;
              setPicked(c.symbol);
            }}
          >
            {c.symbol}
          </button>
        ))}
      </div>
      <p className="muted small tv-note">{current.note}</p>
      <div className={`tv-chart-box${loadedFrame === frameKey ? ' loaded' : ''}`}>
        <iframe key={frameKey} {...frame} onLoad={() => setLoadedFrame(frameKey)} />
        <SkeletonBlock
          className="tv-loading"
          height="auto"
          label="Loading the TradingView chart…"
        />
      </div>
      <div className="tv-foot">
        <a
          className="chip link-chip"
          target="_blank"
          rel="noopener noreferrer"
          href={tvChartUrl(current.symbol)}
        >
          Open on TradingView
        </a>
        {can('review:write') && onUseInReview ? (
          <button
            type="button"
            className="btn small"
            onClick={() => onUseInReview(chartReviewFields(current))}
          >
            Use in review form
          </button>
        ) : null}
        <span className="muted small">
          Live data from TradingView, separate from the CMC data the screen uses. If a symbol shows
          no data, pick another or use the chart&apos;s own symbol search.
        </span>
      </div>
    </section>
  );
}
