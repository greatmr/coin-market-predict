// Coins Predicts dashboard. Reads the NestJS JSON API only. All source text (coin names,
// symbols, notes) is rendered with textContent, never innerHTML, because it comes from
// external sources. Inline styles are never used (CSP); widths are set through the CSSOM.
"use strict";

/* ============================== Basics ============================== */

const $ = (id) => document.getElementById(id);
const SVGNS = "http://www.w3.org/2000/svg";

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

function svg(tag, attrs, ...children) {
  const e = document.createElementNS(SVGNS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, String(v));
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

/** replaceChildren that skips null/false and flattens arrays (replaceChildren renders null as "null"). */
function put(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
}

async function apiPost(path, body) {
  const r = await fetch(`/api/${path}`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!r.ok) {
    const m = data && data.message;
    throw new Error(Array.isArray(m) ? m.join(", ") : m || `HTTP ${r.status}`);
  }
  return data;
}

async function api(path) {
  const r = await fetch(`/api/${path}`, { headers: { accept: "application/json" } });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const b = await r.json();
      if (b && b.message) msg += `: ${Array.isArray(b.message) ? b.message.join(", ") : b.message}`;
    } catch { /* not JSON */ }
    throw new Error(`${path.split("?")[0]} — ${msg}`);
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const MINUS = "−";

/* ============================== State ============================== */

const S = {
  cfg: null,
  overview: null,
  tab: "overview",
  publishedRunId: null,
  signals: { runId: null, data: null },
  recs: null,
  screen: { runId: null, rows: [], page: 0, sort: { key: "score", dir: "desc" } },
  market: { page: 0, sort: "market_cap", dir: "desc", data: null, runId: null },
  drawer: { assetId: null, returnFocus: null },
};
const strategy = () => (S.cfg && S.cfg.strategy) || {};
const tz = () => (S.cfg && S.cfg.timezone) || "UTC";

/* ============================== Formatting ============================== */

const nfCache = new Map();
function nf(o) {
  const k = JSON.stringify(o);
  if (!nfCache.has(k)) nfCache.set(k, new Intl.NumberFormat("en-US", o));
  return nfCache.get(k);
}
function signed(rounded, text) {
  return rounded > 0 ? `+${text}` : rounded < 0 ? `${MINUS}${text}` : text;
}
/** USD price with precision that suits the magnitude: $104,532.18 · $3.4567 · $0.00001234. */
function fmtPrice(n) {
  if (!isNum(n)) return "—";
  const a = Math.abs(n);
  if (a === 0) return "$0";
  if (a >= 1000) return `$${nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`;
  if (a >= 1) return `$${nf({ minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(n)}`;
  return `$${nf({ maximumSignificantDigits: 4 }).format(n)}`;
}
/** Compact USD amount: $1.55T · $25.2B · $812.4M · $45.6K. */
function fmtUsd(n) {
  if (!isNum(n)) return "—";
  const a = Math.abs(n);
  if (a < 1000) return `$${nf({ maximumFractionDigits: a < 10 ? 2 : 0 }).format(n)}`;
  return `$${nf({ notation: "compact", maximumFractionDigits: a >= 1e12 ? 2 : 1 }).format(n)}`;
}
const fmtInt = (n) => (isNum(n) ? nf({ maximumFractionDigits: 0 }).format(n) : "—");
/** Signed percent from a fraction: 0.0123 → +1.23%. */
function fmtRet(frac, dp = 2) {
  if (!isNum(frac)) return "—";
  const r = Number((frac * 100).toFixed(dp));
  return signed(r, `${Math.abs(r).toFixed(dp)}%`);
}
/** Signed percent from a provider value that is already in percent (CMC percentChange*). */
const fmtPctValue = (pct, dp = 2) => (isNum(pct) ? fmtRet(pct / 100, dp) : "—");
/** Difference of two returns in percentage points. */
function fmtPP(frac, dp = 2) {
  if (!isNum(frac)) return "—";
  const r = Number((frac * 100).toFixed(dp));
  return signed(r, `${Math.abs(r).toFixed(dp)} pp`);
}
function fmtZ(z) {
  if (!isNum(z)) return "—";
  const r = Number(z.toFixed(1));
  return `${signed(r, Math.abs(r).toFixed(1))}σ`;
}
const fmtShare = (x, dp = 0) => (isNum(x) ? `${(x * 100).toFixed(dp)}%` : "—");
const fmtRatioPct = (x, dp = 2) => (isNum(x) ? `${(x * 100).toFixed(dp)}%` : "—");
const tone = (v) => (isNum(v) ? (v > 0 ? "up" : v < 0 ? "down" : "") : "");

function fmtTime(iso, opts = {}) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz(),
    ...(opts.date === false ? {} : { day: "2-digit", month: "short" }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}
function fmtAgo(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const f = Math.abs(s);
  if (f < 45) return "just now";
  const v = f < 3600 ? `${Math.round(f / 60)} min` : f < 86400 ? `${(f / 3600).toFixed(f < 36000 ? 1 : 0)} h` : `${Math.round(f / 86400)} d`;
  return s >= 0 ? `${v} ago` : `in ${v}`;
}
function fmtDuration(ms) {
  if (!isNum(ms)) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}
function tzName() {
  try {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz(), timeZoneName: "short" }).formatToParts(new Date());
    return p.find((x) => x.type === "timeZoneName")?.value ?? tz();
  } catch {
    return tz();
  }
}

/* ============================== Labels ============================== */

const PATTERN = {
  advance_candidate: { label: "Advance candidate", dot: "accent", why: "Volume building and price accelerating while still modest, ahead of the market" },
  move_underway: { label: "Move underway", dot: "accent", why: "Already up strongly in 2h: detection of a move, not an early signal" },
  gradual_trend: { label: "Gradual trend", dot: "", why: "Small, steady gains without acceleration or volume build" },
  market_wide: { label: "Market-wide move", dot: "", why: "Moving with a broad rally, little relative strength" },
  overextended: { label: "Overextended", dot: "", why: "Moved too far already to treat as an opportunity" },
  none: { label: "No pattern", dot: "", why: "None of the strategy patterns matched this hour" },
};
const STATUS = {
  candidate: { label: "Candidate", dot: "good" },
  watch: { label: "Watch", dot: "warning" },
  insufficient_data: { label: "Insufficient data", dot: "" },
  no_signal: { label: "No signal", dot: "" },
};
const RUN_STATUS = {
  succeeded: { label: "Succeeded", dot: "good" },
  partial: { label: "Partial", dot: "warning" },
  failed: { label: "Failed", dot: "critical" },
  running: { label: "Running", dot: "accent" },
  interrupted: { label: "Interrupted", dot: "warning" },
  missed: { label: "Missed", dot: "" },
  skipped: { label: "Skipped", dot: "" },
};
const STAGE = { discover: "Discover", collect: "Collect", history: "History", features: "Features", screen: "Screen", vmc: "VMC", analyze: "Agents", publish: "Publish", notify: "Telegram" };
const PUMP = { high: { label: "High", dot: "good" }, medium: { label: "Medium", dot: "warning" }, low: { label: "Low", dot: "" } };
const AGENT_REC = { buy: { label: "Buy", dot: "good" }, hold: { label: "Hold", dot: "warning" }, sell: { label: "Sell", dot: "critical" } };
const FINAL_REC = { buy: { label: "Buy (paper)", dot: "good" }, watch: { label: "Watch", dot: "warning" }, avoid: { label: "Avoid", dot: "critical" } };
const RISK = {
  thin_history: "Thin history (< 73 h)",
  no_liquidity_data: "No order-book depth",
  micro_cap: "Micro cap (< $20M)",
  market_cap_calculated: "Cap calculated from supply",
  large_fdv_overhang: "FDV > 5× market cap",
  extreme_1h_move: "Extreme 1h move (> 15%)",
  price_up_without_volume: "Price up without volume",
  provider_timing_mismatch: "Our 1h vs CMC 1h differ",
  volume_exceeds_market_cap: "24h volume > market cap",
  possible_wash_trading: "Possible wash trading",
};
const CLASS_LABEL = { stablecoin: "Stablecoin", tokenized: "Tokenized stock / RWA", wrapped: "Wrapped token", bridged: "Bridged token", staked: "Staked / liquid staking", regular: "Regular coin", unknown: "Unclassified" };
const FEATURE = {
  ret_1h: { label: "1h return", kind: "ret", help: "Price change since the previous hourly snapshot (t−1h)" },
  ret_2h: { label: "2h return", kind: "ret", help: "Price change since t−2h" },
  accel_1h: { label: "Acceleration", kind: "pp", help: "This hour's return minus the previous hour's; positive means the move is speeding up" },
  vol24_change_2h: { label: "Volume build", kind: "ret", help: "Change of the rolling 24h volume over 2h (a rolling total, not hourly volume)" },
  rs_market_2h: { label: "vs market (2h)", kind: "pp", help: "2h return minus the median 2h return of the strategy universe" },
  rs_btc_1h: { label: "vs BTC (1h)", kind: "pp", help: "1h return minus Bitcoin's 1h return" },
  rs_eth_1h: { label: "vs ETH (1h)", kind: "pp", help: "1h return minus Ethereum's 1h return" },
  vol_mcap: { label: "Turnover", kind: "ratio", help: "Rolling 24h volume ÷ circulating market cap" },
  provider_change_24h: { label: "24h change (CMC)", kind: "ret", help: "Provider-reported 24h price change" },
  provider_change_1h_gap: { label: "1h gap vs CMC", kind: "ratio", help: "Our 1h return vs CMC's 1h change; large gaps suggest timing problems" },
  trend_persistence_12h: { label: "Up-hours (12h)", kind: "share", help: "Share of the last 12 hours that ended higher" },
  realized_vol_24h: { label: "Volatility (24h)", kind: "ratio", help: "Standard deviation of hourly log returns over 24h" },
  ret_zscore_1h: { label: "1h move z-score", kind: "z", help: "This hour's log return divided by 24h volatility" },
  breakout_24h: { label: "vs prior 24h high", kind: "ret", help: "Price vs the highest hourly snapshot of the previous 24h (positive = new high)" },
  vol24_zscore_72h: { label: "Volume z-score (72h)", kind: "z", help: "Rolling 24h volume vs its previous 72 hourly values" },
  spread_pct: { label: "Bid/ask spread", kind: "ratio", help: "Only when the source provides order-book data" },
  est_slippage_pct: { label: "Est. slippage", kind: "ratio", help: "Only when the source provides order-book depth" },
};
function fmtFeature(key, v) {
  const k = FEATURE[key] ? FEATURE[key].kind : "ratio";
  return k === "ret" ? fmtRet(v) : k === "pp" ? fmtPP(v) : k === "z" ? fmtZ(v) : k === "share" ? fmtShare(v) : fmtRatioPct(v);
}
function reasonLabel(code) {
  const p = strategy();
  if (code.startsWith("excluded_class:")) return CLASS_LABEL[code.split(":")[1]] ?? code;
  const map = {
    warming_up: `Warming up (needs ${(S.cfg && S.cfg.snapshotWindow) || 3} hourly snapshots)`,
    illiquid_volume: `24h volume < ${fmtUsd(p.minVolume24hUsd)}`,
    below_min_market_cap: `Market cap < ${fmtUsd(p.minMarketCapUsd)}`,
    market_cap_unavailable: "No circulating market cap",
    benchmark_reference: "Benchmark (BTC/ETH reference)",
    stale_observation: "Stale quote",
    incomplete_data: "Price or volume missing",
    no_current_snapshot: "Not collected this hour",
  };
  return map[code] ?? code.replace(/_/g, " ");
}
const VMC_STATUS = {
  ok: "OK",
  no_quote_collected: "No quote yet",
  baseline_not_calculated: "Baseline not calculated",
  baseline_unavailable: "Baseline unavailable",
  baseline_partial: "Baseline partial (< 6 months)",
  baseline_older_than_8d: "Baseline older than 8 days",
};
function vmcStatusLabel(s) {
  if (VMC_STATUS[s]) return VMC_STATUS[s];
  let m = /^stale_quote_(\d+)min$/.exec(s);
  if (m) return `Quote ${m[1]} min old`;
  m = /^recent_window_incomplete_(\d+)\/(\d+)h$/.exec(s);
  if (m) return `72h window: ${m[1]}/${m[2]} hours`;
  m = /^hourly_backfill_(.+)$/.exec(s);
  if (m) return `Hourly backfill: ${m[1].replace(/_/g, " ")}`;
  return s.replace(/_/g, " ");
}

/* ============================== Components ============================== */

const statusLabel = (dotClass, text, pulse = false) =>
  el("span", { class: "status" }, el("span", { class: `dot ${dotClass}${pulse ? " pulse" : ""}`, "aria-hidden": "true" }), text);
const signalStatus = (s) => statusLabel((STATUS[s] || {}).dot || "", (STATUS[s] || {}).label || s);
const runStatus = (s, pulse) => statusLabel((RUN_STATUS[s] || {}).dot || "", (RUN_STATUS[s] || {}).label || s, pulse);
function patternLabel(cls) {
  const p = PATTERN[cls] || { label: cls || "—", dot: "" };
  return el("span", { class: "pattern", title: p.why || "" }, el("span", { class: "status" }, el("span", { class: `dot ${p.dot}`, "aria-hidden": "true" }), el("span", null, p.label)));
}
const chip = (text, opts = {}) => el("span", { class: `chip${opts.strong ? " strong" : ""}`, title: opts.title }, opts.dot ? el("span", { class: `dot ${opts.dot}`, "aria-hidden": "true" }) : null, text);
const riskChips = (flags, max = 4) => {
  const list = (flags || []).slice(0, max).map((f) => chip(RISK[f] || f.replace(/_/g, " ")));
  if ((flags || []).length > max) list.push(chip(`+${flags.length - max} more`));
  return el("span", null, list);
};
const reasonChips = (reasons) => el("span", null, (reasons || []).map((r) => chip(reasonLabel(r))));
/** CoinMarketCap serves a logo per coin id (the same host the data comes from). The CSP allows only this host. */
const logoUrl = (cmcId) => (Number.isInteger(cmcId) && cmcId > 0 ? `https://s2.coinmarketcap.com/static/img/coins/64x64/${cmcId}.png` : null);

/** Round logo with a letter badge as the fallback (no id, offline, or the image fails to load). */
function coinLogo(cmcId, symbol, size = 24) {
  const letter = () => el("span", { class: "logo fallback", style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.46)}px`, "aria-hidden": "true" }, (symbol || "?").slice(0, 1).toUpperCase());
  const url = logoUrl(cmcId);
  if (!url) return letter();
  const img = el("img", { class: "logo", src: url, width: size, height: size, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
  img.addEventListener("error", () => img.replaceWith(letter()), { once: true });
  return img;
}

const coinCell = (asset) => el("div", { class: "coin" }, coinLogo(asset.cmcId, asset.symbol), el("div", { class: "coin-text" }, el("b", null, asset.symbol), el("span", { title: asset.name }, asset.name)));
const pctCell = (v, fmt = fmtRet) => el("span", { class: tone(v) }, fmt(v));

function meter(score, opts = {}) {
  const fill = el("div", { class: "m-fill" });
  fill.style.width = `${Math.max(0, Math.min(100, isNum(score) ? score : 0))}%`;
  const title = opts.title ?? "Heuristic score 0–100 (a ranking aid, not a probability)";
  return el("span", { class: `meter${opts.wide ? " wide" : ""}`, title }, el("span", { class: "m-track" }, fill), el("span", null, isNum(score) ? `${score.toFixed(0)}${opts.suffix ?? ""}` : "—"));
}

function tiles(list, compact = false) {
  return el(
    "div",
    { class: `tiles${compact ? " compact" : ""}` },
    list.map((t) => el("div", { class: "tile", title: t.title }, el("div", { class: "label" }, t.label), el("div", { class: `value ${t.tone || ""}` }, t.value), t.sub ? el("div", { class: "sub" }, t.sub) : null)),
  );
}

/** Horizontal bars in one hue, value printed at the tip; `max` sets a shared scale. */
function barList(items, opts = {}) {
  if (!items.length) return el("div", { class: "empty" }, opts.empty || "Nothing to show.");
  const max = opts.max ?? Math.max(1, ...items.map((i) => i.value));
  return el(
    "div",
    { class: "bars" },
    items.map((it) => {
      const bar = el("div", { class: `bar${it.dim ? " dim" : ""}` });
      bar.style.width = `${Math.max(0.3, (it.value / max) * 78)}%`;
      return [
        el("div", { class: "name" }, it.label, it.why ? el("span", { class: "why" }, it.why) : null),
        el("div", { class: "track" }, bar, el("span", { class: "val" }, el("b", null, fmtInt(it.value)), it.note ? ` ${it.note}` : "")),
      ];
    }),
  );
}

/** Table with optional sortable headers and clickable (keyboard-accessible) rows. */
function table(cols, rows, opts = {}) {
  if (!rows.length) return el("div", { class: "empty" }, opts.empty || "Nothing to show.");
  const head = el(
    "tr",
    null,
    cols.map((c) => {
      const th = el("th", { class: [c.num ? "num" : "", c.sort ? "sortable" : ""].join(" ").trim() || null, scope: "col", title: c.title }, c.label);
      if (c.sort && opts.onSort) {
        th.tabIndex = 0;
        if (opts.sort && opts.sort.key === c.sort) th.setAttribute("aria-sort", opts.sort.dir === "asc" ? "ascending" : "descending");
        const go = () => opts.onSort(c.sort);
        th.addEventListener("click", go);
        th.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
        });
      }
      return th;
    }),
  );
  const body = rows.map((r) => {
    const tr = el("tr", { class: [opts.onRow ? "clickable" : "", opts.rowClass ? opts.rowClass(r) : ""].join(" ").trim() || null }, cols.map((c) => el("td", { class: c.num ? "num" : null }, c.render(r))));
    if (opts.onRow) {
      tr.tabIndex = 0;
      tr.addEventListener("click", () => opts.onRow(r, tr));
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") opts.onRow(r, tr); });
    }
    return tr;
  });
  return el("table", { class: opts.noHead ? "kv-table" : null }, opts.noHead ? null : el("thead", null, head), el("tbody", null, body));
}
const kvTable = (pairs) => table([{ label: "", render: (x) => x[0] }, { label: "", render: (x) => x[1] }], pairs, { noHead: true });

function pager(container, { page, pageSize, total, onPage }) {
  const from = total ? page * pageSize + 1 : 0;
  const to = Math.min(total, (page + 1) * pageSize);
  put(container, 
    el("span", null, `${fmtInt(from)}–${fmtInt(to)} of ${fmtInt(total)}`),
    el("button", { class: "btn", type: "button", disabled: page === 0, onclick: () => onPage(page - 1) }, "← Previous"),
    el("button", { class: "btn", type: "button", disabled: to >= total, onclick: () => onPage(page + 1) }, "Next →"),
  );
}

/* ---------- Tooltip ---------- */
function showTooltip(x, y, nodes) {
  const t = $("tooltip");
  put(t, ...nodes.filter(Boolean));
  t.hidden = false;
  const w = t.offsetWidth, h = t.offsetHeight;
  t.style.left = `${Math.min(window.innerWidth - w - 8, x + 14)}px`;
  t.style.top = `${y + h + 20 > window.innerHeight ? y - h - 12 : y + 14}px`;
}
const hideTooltip = () => { $("tooltip").hidden = true; };

/* ---------- Line chart (one series, crosshair + tooltip, keyboard, table twin) ---------- */
function niceTicks(min, max, n = 4) {
  if (min === max) {
    const d = Math.abs(min) * 0.05 || 1;
    min -= d;
    max += d;
  }
  const raw = (max - min) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.floor(min / step) * step; v <= Math.ceil(max / step) * step + step / 2; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}
function tzOffsetMs(t) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz(), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(t));
  const g = (k) => Number(p.find((x) => x.type === k).value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - Math.floor(t / 60000) * 60000;
}
function timeTicks(x0, x1, maxTicks) {
  const H = 3600000;
  const step = [1, 2, 3, 6, 12, 24, 48].map((h) => h * H).find((s) => (x1 - x0) / s <= maxTicks) || 96 * H;
  const off = tzOffsetMs(x1);
  const out = [];
  for (let t = Math.ceil((x0 + off) / step) * step - off; t <= x1; t += step) out.push(t);
  return out;
}
function nearestIndex(data, t) {
  let lo = 0, hi = data.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (data[mid].t < t) lo = mid;
    else hi = mid;
  }
  return Math.abs(data[lo].t - t) <= Math.abs(data[hi].t - t) ? lo : hi;
}
function mountChart(container, draw) {
  let lastW = 0;
  const render = () => {
    const w = Math.floor(container.clientWidth);
    if (w < 60 || w === lastW) return;
    lastW = w;
    put(container, draw(w));
  };
  requestAnimationFrame(render);
  if ("ResizeObserver" in window) new ResizeObserver(render).observe(container);
}
function lineChart(points, opts) {
  const data = points.filter((p) => isNum(p.v)).sort((a, b) => a.t - b.t);
  const box = el("div", { class: "chart" });
  const tableBox = el("div", { class: "table-wrap" });
  tableBox.hidden = true;
  const toggle = el("button", { type: "button", class: "linkish" }, "Show values as a table");
  toggle.addEventListener("click", () => {
    tableBox.hidden = !tableBox.hidden;
    toggle.textContent = tableBox.hidden ? "Show values as a table" : "Hide table";
    if (!tableBox.hidden && !tableBox.firstChild) {
      tableBox.append(table([{ label: "Hour", render: (p) => fmtTime(new Date(p.t).toISOString()) }, { label: opts.label, num: true, render: (p) => opts.format(p.v) }, { label: "Source", render: (p) => p.note || "hourly collection" }], [...data].reverse()));
    }
  });
  const wrap = el("div", null, el("div", { class: "chart-head" }, el("h3", null, opts.title), data.length >= 2 ? toggle : null), box, tableBox);
  if (data.length < 2) {
    box.append(el("div", { class: "empty" }, "Not enough hourly snapshots for a chart yet."));
    return wrap;
  }
  mountChart(box, (W) => drawLine(W, opts.height || 180, data, opts));
  return wrap;
}
function drawLine(W, H, data, opts) {
  const vals = data.map((p) => p.v);
  const yt = niceTicks(Math.min(...vals), Math.max(...vals), 4);
  const m = { t: 10, b: 24, l: Math.min(96, Math.max(44, Math.max(...yt.map((v) => opts.format(v).length)) * 6.6 + 10)), r: 78 };
  const x0 = data[0].t, x1 = data[data.length - 1].t;
  const X = (t) => m.l + ((t - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const ymin = yt[0], ymax = yt[yt.length - 1];
  const Y = (v) => m.t + (1 - (v - ymin) / (ymax - ymin || 1)) * (H - m.t - m.b);
  const root = svg("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${opts.title}. ${data.length} hourly values; latest ${opts.format(vals[vals.length - 1])}. Use arrow keys to read values.`, tabindex: 0 });
  for (const v of yt) {
    root.append(svg("line", { class: "grid-line", x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }));
    root.append(svg("text", { class: "tick", x: m.l - 6, y: Y(v) + 4, "text-anchor": "end" }, opts.format(v)));
  }
  const span = x1 - x0;
  for (const t of timeTicks(x0, x1, Math.max(2, Math.floor((W - m.l - m.r) / 110)))) {
    const label = span > 30 * 3600000 ? fmtTime(new Date(t).toISOString()) : fmtTime(new Date(t).toISOString(), { date: false });
    root.append(svg("text", { class: "tick", x: X(t), y: H - 6, "text-anchor": "middle" }, label));
  }
  root.append(svg("line", { class: "axis-line", x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }));
  // A missing hour stays a visible gap: the line is split instead of interpolated.
  const segs = [];
  let cur = [];
  for (const p of data) {
    if (cur.length && p.t - cur[cur.length - 1].t > 1.5 * 3600000) { segs.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) segs.push(cur);
  for (const s of segs) {
    const d = s.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
    if (s.length > 1) root.append(svg("path", { class: "wash", d: `${d}L${X(s[s.length - 1].t).toFixed(1)},${Y(ymin).toFixed(1)}L${X(s[0].t).toFixed(1)},${Y(ymin).toFixed(1)}Z` }));
    root.append(svg("path", { class: "series", d }));
    if (s.length === 1) root.append(svg("circle", { class: "end-dot", cx: X(s[0].t), cy: Y(s[0].v), r: 3 }));
  }
  const last = data[data.length - 1];
  root.append(svg("circle", { class: "end-dot", cx: X(last.t), cy: Y(last.v), r: 4 }));
  root.append(svg("text", { class: "end-label", x: X(last.t) + 9, y: Y(last.v) + 4 }, opts.format(last.v)));
  const cross = svg("line", { class: "cross", y1: m.t, y2: H - m.b, visibility: "hidden" });
  const dot = svg("circle", { class: "cross-dot", r: 4.5, visibility: "hidden" });
  root.append(cross, dot);
  let idx = data.length - 1;
  const show = (i, cx, cy) => {
    idx = i;
    const p = data[i];
    for (const [k, v] of [["x1", X(p.t)], ["x2", X(p.t)]]) cross.setAttribute(k, String(v));
    dot.setAttribute("cx", String(X(p.t)));
    dot.setAttribute("cy", String(Y(p.v)));
    cross.setAttribute("visibility", "visible");
    dot.setAttribute("visibility", "visible");
    const r = root.getBoundingClientRect();
    showTooltip(cx ?? r.left + X(p.t), cy ?? r.top + Y(p.v), [el("div", { class: "tv" }, opts.format(p.v)), el("div", { class: "tk" }, `${fmtTime(new Date(p.t).toISOString())} ${tzName()}`), p.note ? el("div", { class: "tk" }, p.note) : null]);
  };
  const hide = () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideTooltip(); };
  const overlay = svg("rect", { x: m.l, y: 0, width: Math.max(1, W - m.l - m.r), height: H - m.b, fill: "transparent" });
  overlay.addEventListener("pointermove", (e) => {
    const r = root.getBoundingClientRect();
    show(nearestIndex(data, x0 + ((e.clientX - r.left - m.l) / (W - m.l - m.r)) * (x1 - x0)), e.clientX, e.clientY);
  });
  overlay.addEventListener("pointerleave", hide);
  root.append(overlay);
  root.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); show(Math.max(0, idx - 1)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); show(Math.min(data.length - 1, idx + 1)); }
    else if (e.key === "Escape") hide();
  });
  root.addEventListener("focus", () => show(idx));
  root.addEventListener("blur", hide);
  return root;
}

/* ============================== Header ============================== */

function renderHeader() {
  const c = S.cfg;
  const agent = c.agentProvider === "claude" ? (c.agentAvailability && !c.agentAvailability.available ? "Agents: Claude (unavailable)" : "Agents: Claude") : c.agentProvider === "fixture" ? "Agents: offline stand-in" : "Agents: off";
  put($("badges"), 
    el("span", { class: `badge ${c.isLiveData ? "live" : "fixture"}` }, c.isLiveData ? `Live · ${c.providerName}` : "Fixture · synthetic data"),
    el("span", { class: "badge" }, agent),
    el("span", { class: "badge" }, `Telegram: ${c.telegramMode === "dry_run" ? "dry run" : c.telegramMode}`),
    el("span", { class: "badge" }, `Times: ${tzName()}`),
  );
  const banner = $("banner");
  if (!c.isLiveData) {
    banner.hidden = false;
    banner.textContent = "Fixture mode: every price, volume and signal on this page is SYNTHETIC test data. Set DATA_SOURCE=coinmarketcap_web to collect the real CoinMarketCap listing.";
  } else if (c.agentProvider !== "claude") {
    banner.hidden = false;
    banner.textContent = `Market data is live. Agent reviews are ${c.agentProvider === "fixture" ? "an offline deterministic stand-in (not Claude)" : "turned off"}; set AGENT_PROVIDER=claude for real model reviews.`;
  } else banner.hidden = true;
  $("footer").textContent = `${c.attribution ? `${c.attribution} · ` : ""}Research hypotheses only, not financial advice. Hourly snapshots cannot observe intrahour moves. Scores are heuristics, not probabilities. No orders are ever placed.`;
  const p = strategy();
  $("strategy-summary").textContent =
    `Advance candidate: rolling-24h volume up ≥ ${fmtShare(p.advanceMinVolumeBuild)} over 2h, price accelerating, 2h return between ${fmtRet(p.advanceMinRet2h, 1)} and ${fmtRet(p.underwayRet2h, 0)}, and ahead of the market median. ` +
    `At ≥ ${fmtRet(p.underwayRet2h, 0)} in 2h a coin is "move underway" (detection, not an advance signal); at ≥ ${fmtRet(p.overextendedRet2h, 0)} in 2h or ${fmtRet(p.overextendedChange24h, 0)} in 24h it is overextended. ` +
    `Floors: 24h volume ≥ ${fmtUsd(p.minVolume24hUsd)} and circulating market cap ≥ ${fmtUsd(p.minMarketCapUsd)}; stablecoins, wrapped, bridged and staked tokens are excluded. Shortlist: top ${c.shortlistSize} advance/underway coins scoring ≥ ${p.minShortlistScore}.`;
  const sel = $("screen-pattern");
  if (sel.options.length === 1) for (const [k, v] of Object.entries(PATTERN)) sel.append(el("option", { value: k }, v.label));
}

/* ============================== Overview ============================== */

function renderRunStrip(ov) {
  const run = ov.latestRun;
  const rd = ov.readiness || {};
  const box = $("run-strip");
  if (!run) {
    put(box, el("div", { class: "state" }, statusLabel("", "No runs yet")), el("div", { class: "meta" }, rd.message || ""));
    return;
  }
  const parts = [];
  if (run.status === "running") {
    parts.push(el("div", { class: "state" }, runStatus("running", true), el("span", null, `${STAGE[run.currentStage] || "Starting"} stage`)));
    const order = Object.keys(STAGE);
    const doneStages = (run.stages || []).filter((st) => st.status === "succeeded").length;
    const step = Math.max(order.indexOf(run.currentStage) + 1, doneStages, 1);
    parts.push(el("div", { class: "progress" }, el("div", { class: "label" }, `Step ${step} of ${order.length} · ${STAGE[run.currentStage] || "Starting"} · ${fmtDuration(Date.now() - new Date(run.startedAt))} elapsed — results and the Telegram report appear when the run finishes`), meter((doneStages / order.length) * 100, { wide: true, suffix: "%", title: "Pipeline progress (completed stages)" })));
    const h = run.metrics && run.metrics.history;
    if (run.currentStage === "history" && h && h.needed) {
      parts.push(el("div", { class: "progress" }, el("div", { class: "label" }, `Fetching genuine hourly history: ${fmtInt(h.attempted)} of ${fmtInt(h.needed)} coins`), meter((h.attempted / h.needed) * 100, { wide: true, suffix: "%", title: "History backfill progress" })));
    }
    const screenDone = (run.stages || []).some((st) => st.stage === "screen" && st.status === "succeeded");
    if (screenDone) parts.push(el("div", { class: "meta" }, "Strategy results are already live below; VMC baselines and agent review are still filling in (they can be skipped)."));
    parts.push(el("div", { class: "meta" }, `Slot ${fmtTime(run.slotTime)} · started ${fmtAgo(run.startedAt)}`));
  } else if (run.status === "interrupted") {
    parts.push(el("div", { class: "state" }, runStatus("interrupted"), el("span", null, `${STAGE[run.currentStage] || "Run"} stage stopped — the app was restarted mid-run`)));
    parts.push(el("div", { class: "meta" }, "It resumes automatically within 5 minutes while the app is running. Strategy results from completed stages stay available."));
  } else {
    parts.push(el("div", { class: "state" }, runStatus(run.status), el("span", null, `Last run · slot ${fmtTime(run.slotTime)}`)));
    parts.push(el("div", { class: "meta" }, `Finished ${fmtAgo(run.finishedAt)}${run.startedAt && run.finishedAt ? ` · took ${fmtDuration(new Date(run.finishedAt) - new Date(run.startedAt))}` : ""}`));
  }
  const c = S.cfg;
  parts.push(el("div", { class: "meta" }, c.schedulerEnabled ? (c.nextRunAt ? `Next run ${fmtTime(c.nextRunAt)} (${fmtAgo(c.nextRunAt)})` : "Scheduler on") : "Scheduler off — run npm run cli -- run-once"));
  if (rd.message) parts.push(el("div", { class: "meta" }, rd.message));
  put(box, ...parts);
}

function renderOverview(ov) {
  renderRunStrip(ov);
  const f = ov.funnel;
  const p = strategy();
  if (!f) {
    const cov = (ov.latestRun && ov.latestRun.coverage) || {};
    const h = ov.latestRun && ov.latestRun.metrics && ov.latestRun.metrics.history;
    put($("kpis"), 
      tiles([
        { label: "Coins collected this hour", value: fmtInt(cov.collected), sub: cov.label ? `${cov.universeSize ? `of ${fmtInt(cov.universeSize)} listed · ` : ""}${cov.label === "complete" ? "complete listing" : `${cov.label} coverage`}` : "collection not finished yet" },
        { label: "History backfill", value: h && h.needed ? `${fmtInt(h.attempted)} / ${fmtInt(h.needed)}` : "—", sub: h && h.needed ? "coins with genuine hourly history" : "starts after collection" },
        { label: "Research signals", value: "—", sub: "the first run is still in progress" },
      ]),
    );
    for (const id of ["funnel", "market-context", "patterns", "exclusions", "top-signals", "agent-review"]) put($(id), el("div", { class: "empty" }, "Appears when the first run is published."));
    renderHistoryCard($("history-backfill"), h);
    if (isNum(cov.collected)) $("count-market").textContent = fmtInt(cov.collected);
    return;
  }
  const signals = Object.values(f.signals || {}).reduce((a, b) => a + b, 0);
  const ready = f.screened - f.warming;
  const adv = (f.classifications.advance_candidate || 0) + (f.classifications.move_underway || 0);
  $("funnel-slot").textContent = `slot ${fmtTime(f.slotTime)} ${tzName()}`;
  put($("kpis"), 
    tiles([
      { label: "Coins collected this hour", value: fmtInt(f.collected), sub: `${f.listed ? `of ${fmtInt(f.listed)} listed · ` : ""}${f.coverageLabel === "complete" ? "complete listing" : `${f.coverageLabel || "unknown"} coverage`}` },
      { label: "Strategy universe", value: fmtInt(f.screened), sub: `cap ≥ ${fmtUsd(p.minMarketCapUsd)}, not stable/wrapped` },
      { label: "Ready to screen", value: fmtInt(ready), sub: f.warming ? `${fmtInt(f.warming)} still warming up` : "all have t, t−1h, t−2h" },
      { label: "Eligible", value: fmtInt(f.eligible), sub: `passed liquidity and data checks` },
      { label: "Shortlisted for agents", value: fmtInt(f.shortlisted), sub: `${fmtInt(adv)} advance/underway patterns` },
      { label: "Research signals", value: fmtInt(signals), sub: Object.entries(f.signals || {}).map(([k, v]) => `${v} ${(STATUS[k] || {}).label || k}`.toLowerCase()).join(" · ") || "none this hour" },
    ]),
  );
  const steps = [
    { label: "Listed by the source", value: f.listed ?? f.collected },
    { label: "Collected this hour", value: f.collected, why: f.stale ? `${f.stale} stale quotes` : null },
    { label: "Inside strategy floors", value: f.screened, why: `cap ≥ ${fmtUsd(p.minMarketCapUsd)}; BTC/ETH as benchmarks` },
    { label: "With 3 hourly snapshots", value: ready },
    { label: "Eligible", value: f.eligible, why: `24h volume ≥ ${fmtUsd(p.minVolume24hUsd)}, fresh, complete` },
    { label: "Advance or underway", value: adv },
    { label: "Shortlisted", value: f.shortlisted },
    { label: "Signals published", value: signals },
  ].filter((s) => isNum(s.value));
  const top = steps[0] ? steps[0].value : 1;
  put($("funnel"), barList(steps.map((s, i) => ({ ...s, note: i ? `· ${top ? ((s.value / top) * 100).toFixed(s.value / top < 0.01 ? 2 : 1) : 0}%` : "" })), { max: top }));

  const mk = f.market || {};
  const rally = isNum(mk.marketMedianRet2h) && isNum(p.marketRallyRet2h) ? mk.marketMedianRet2h >= p.marketRallyRet2h : null;
  put($("market-context"), 
    tiles(
      [
        { label: "Bitcoin · 1h", value: fmtRet(mk.btcRet1h), tone: tone(mk.btcRet1h) },
        { label: "Ethereum · 1h", value: fmtRet(mk.ethRet1h), tone: tone(mk.ethRet1h) },
        { label: "Market median · 1h", value: fmtRet(mk.marketMedianRet1h), tone: tone(mk.marketMedianRet1h) },
        { label: "Market median · 2h", value: fmtRet(mk.marketMedianRet2h), tone: tone(mk.marketMedianRet2h) },
        { label: "Advancing (2h)", value: fmtShare(mk.advancingShare), sub: "share of coins up over 2h" },
        { label: "Breadth", value: fmtInt(mk.breadth), sub: "coins in the median" },
      ],
      true,
    ),
    el("p", { class: "hint" }, rally === null ? "Not enough coins with 2h history for a market median yet." : rally ? `Broad rally: the market median is up ≥ ${fmtRet(p.marketRallyRet2h, 1)} in 2h, so moves without relative strength are classified market-wide.` : `No broad rally (threshold ${fmtRet(p.marketRallyRet2h, 1)} in 2h): coins are judged on their own move and relative strength.`),
  );

  const cls = Object.entries(f.classifications || {}).sort((a, b) => b[1] - a[1]);
  put($("patterns"), barList(cls.map(([k, v]) => ({ label: (PATTERN[k] || {}).label || k, why: (PATTERN[k] || {}).why, value: v, dim: k === "none" })), { empty: "No eligible coins this hour." }));

  const outside = Object.entries(f.outsideReasons || {}).sort((a, b) => b[1] - a[1]);
  const inside = Object.entries(f.insideReasons || {}).sort((a, b) => b[1] - a[1]);
  const maxR = Math.max(1, ...outside.map((x) => x[1]), ...inside.map((x) => x[1]));
  put($("exclusions"), 
    el("h3", { class: "small muted" }, `Outside the strategy floors (collected, not evaluated): ${fmtInt(f.outside)}`),
    barList(outside.map(([k, v]) => ({ label: reasonLabel(k), value: v, dim: true })), { max: maxR, empty: "None." }),
    el("h3", { class: "small muted" }, "Evaluated but not eligible this hour"),
    barList(inside.map(([k, v]) => ({ label: reasonLabel(k), value: v })), { max: maxR, empty: "None: every evaluated coin is eligible." }),
  );

  const ag = f.agent || {};
  put($("agent-review"), 
    el("p", null, statusLabel(ag.status === "completed" ? "good" : ag.status === "partial" ? "warning" : ag.status === "unavailable" ? "critical" : "", ({ completed: "Completed", partial: "Partial", unavailable: "Unavailable", skipped: "Skipped", not_needed: "Not needed (nothing shortlisted)" })[ag.status] || ag.status || "Not run")),
    ag.summary ? el("p", null, ag.summary) : null,
    (ag.notes || []).length ? el("ul", { class: "notes" }, ag.notes.map((n) => el("li", null, n))) : null,
    el("p", { class: "hint" }, `Provider: ${S.cfg.agentProvider} · analyst ${S.cfg.models.analyst}, reviewer ${S.cfg.models.reviewer}, coordinator ${S.cfg.models.coordinator} · estimated cost this run $${(ag.costUsd || 0).toFixed(4)}`),
  );
  renderHistoryCard($("history-backfill"), f.history);
}

function renderHistoryCard(box, h) {
  if (!h || h.status === "not_supported") {
    put(box, el("p", { class: "muted" }, "This source has no history endpoint; coins warm up from hourly collection."));
    return;
  }
  const stop = { time_budget: "per-run time budget reached", max_assets: "per-run coin limit reached", request_budget_reserve: "monthly request reserve protected", source_unavailable: "source refused or failed" }[h.stoppedBy];
  const running = h.status === "running";
  const remaining = running ? h.needed - h.attempted : h.remaining;
  put(box, 
    tiles(
      [
        { label: "Needed history", value: fmtInt(h.needed), sub: `of ${fmtInt(h.candidates)} candidates` },
        { label: "Backfilled", value: fmtInt(h.backfilled), sub: `${fmtInt(h.inserted)} genuine hourly rows${h.failed ? ` · ${h.failed} skipped` : ""}` },
        { label: running ? "Still to fetch" : "Still missing", value: fmtInt(remaining), sub: running ? "in progress" : remaining ? "continues next run" : "none" },
      ],
      true,
    ),
    el("p", { class: "hint" }, running ? "In progress: each coin gets one chart request for its previous 72 hours." : h.status === "disabled" ? "Backfill disabled: coins warm up over three hourly runs." : stop ? `Stopped early: ${stop}.` : remaining ? `${fmtInt(remaining)} coin(s) returned no usable history; they are retried next run or warm up from hourly collection.` : h.needed ? "Completed for every coin that needed it." : "No coin needed history this run: hourly collection already provides t−1h and t−2h."),
    (h.notes || []).length ? el("details", null, el("summary", null, "Details"), el("ul", { class: "notes" }, h.notes.map((n) => el("li", null, n)))) : null,
  );
}

/* ============================== Recommendations ============================== */

const levelLabel = (map, key, fallback = "—") => (map[key] ? statusLabel(map[key].dot, map[key].label) : el("span", { class: "muted" }, fallback));
const truncate = (t, n) => (t && t.length > n ? `${t.slice(0, n - 1)}…` : t || "");

function threeDayCell(t) {
  if (!t || !isNum(t.change)) return el("span", { class: "muted", title: "needs at least two stored hourly prices in the last 72 h" }, "—");
  return el("div", { class: "stacked" }, el("b", { class: tone(t.change) }, fmtRet(t.change)), el("span", null, t.spanHours >= 70 ? `${fmtPrice(t.low)} – ${fmtPrice(t.high)}` : `${t.spanHours} h so far`));
}

function vmcCell(r) {
  const v = r.vmc;
  const cur = v && isNum(v.currentRatio) ? v.currentRatio : isNum(r.volume24h) && isNum(r.marketCap) && r.marketCap > 0 ? r.volume24h / r.marketCap : null;
  if (!v || !isNum(v.multiple)) return el("div", { class: "stacked", title: "24h volume ÷ market cap now; the six-month baseline appears after the VMC stage fetched daily history" }, el("b", null, isNum(cur) ? cur.toFixed(3) : "—"), el("span", null, v && v.baselineStatus ? `baseline ${v.baselineStatus}` : "no 6-mo baseline yet"));
  return el(
    "div",
    { class: "stacked", title: `24h volume ÷ market cap now ${cur.toFixed(4)} vs six-month daily mean ${v.baselineMean.toFixed(4)} (${v.baselineValidDays} days, ${v.baselineStatus})` },
    el("b", null, `${v.multiple.toFixed(v.multiple >= 10 ? 0 : 1)}×`),
    el("span", null, `${cur.toFixed(3)} vs ${v.baselineMean.toFixed(3)}`),
  );
}

function recsTable(rows, full) {
  const cols = [
    { label: "#", num: true, render: (r) => String(rows.indexOf(r) + 1) },
    { label: "Coin", render: (r) => coinCell(r) },
    { label: "Price", num: true, render: (r) => fmtPrice(r.price) },
    { label: "Last 3 days", num: true, title: "Price change over the last 72 hourly snapshots (low – high)", render: (r) => threeDayCell(r.threeDay) },
    { label: "Market cap", num: true, render: (r) => fmtUsd(r.marketCap) },
    { label: "VMC vs 6-mo", num: true, title: "24h volume ÷ market cap now vs the coin's six-month daily average", render: vmcCell },
    {
      label: "Pump chance (strategy)",
      render: (r) => el("div", null, levelLabel(PUMP, r.pumpChance), full ? el("ul", { class: "notes" }, (r.pumpReasons || []).slice(0, 6).map((x) => el("li", null, x))) : el("div", { class: "hint" }, truncate((r.pumpReasons || [])[0], 70))),
    },
    {
      label: "Agents",
      render: (r) =>
        r.agent && r.agent.recommendation
          ? el("div", null, levelLabel(AGENT_REC, r.agent.recommendation), el("div", { class: "hint" }, full ? r.agent.reason || "" : truncate(r.agent.reason, 70)), r.agent.origin === "fixture_agent" ? el("div", { class: "hint" }, "offline stand-in, not Claude") : null)
          : el("span", { class: "muted" }, r.shortlisted ? "reviewing…" : "not reviewed (outside agent shortlist)"),
    },
    { label: "Recommendation", render: (r) => el("div", null, levelLabel(FINAL_REC, r.recommendation), full ? el("div", { class: "hint" }, r.recommendationReason) : null) },
  ];
  if (full) {
    cols.push({
      label: "Paper plan",
      render: (r) => (r.scenario ? el("div", { class: "stacked" }, el("b", null, `≥ ${fmtPrice(r.scenario.entryPrice)}`), el("span", null, `stop ${fmtPrice(r.scenario.stopPrice)} · target ${fmtPrice(r.scenario.targetPrice)}`), el("span", null, `until ${fmtTime(r.scenario.expiresAt, { date: false })}`)) : el("span", { class: "muted" }, "—")),
    });
  }
  return table(cols, rows, { onRow: (r, tr) => openCoin(r.assetId, tr), rowClass: (r) => (r.recommendation === "buy" ? "highlight" : ""), empty: "No coin has a high or medium pump chance this hour. That is a normal outcome." });
}

async function loadRecs() {
  const data = await api("recommendations");
  S.recs = data;
  put($("recs"), recsTable(data.rows, false));
  put($("recs-full"), recsTable(data.rows, true));
  const n = (k) => data.rows.filter((r) => r.recommendation === k).length;
  $("recs-meta").textContent = data.slotTime ? `${data.rows.length} coins · ${n("buy")} buy · ${n("watch")} watch · ${n("avoid")} avoid · slot ${fmtTime(data.slotTime)} ${tzName()}` : "";
  $("count-signals").textContent = fmtInt(data.rows.length);
}

/* ============================== Signals ============================== */

function signalCard(s, compact = false) {
  const sc = s.scenario || {};
  const q = s.quote || {};
  const f = (s.keyFeatures && s.keyFeatures.values) || {};
  const ref = sc.referencePrice;
  const card = el(
    "article",
    { class: "sig", tabindex: 0, role: "button", "aria-label": `${s.asset.symbol} ${(STATUS[s.status] || {}).label || s.status} signal: open details` },
    el("div", { class: "top" }, el("div", { class: "title with-logo" }, coinLogo(s.asset.cmcId, s.asset.symbol, 32), el("div", null, el("b", null, s.asset.symbol), el("span", null, s.asset.name))), el("div", null, signalStatus(s.status), el("div", { class: "hint" }, s.signalType === "move_underway" ? "Move underway (detection)" : s.signalType === "advance" ? "Advance" : "—"))),
    el("div", { class: "row" }, el("span", null, "Price ", el("b", null, fmtPrice(q.price ?? ref))), el("span", null, "1h ", el("b", { class: tone(q.change1h) }, fmtPctValue(q.change1h))), el("span", null, "24h ", el("b", { class: tone(q.change24h) }, fmtPctValue(q.change24h))), el("span", null, "Cap ", el("b", null, fmtUsd(q.marketCap))), el("span", null, "Vol 24h ", el("b", null, fmtUsd(q.volume24h)))),
    el(
      "div",
      { class: "plan" },
      el("div", null, el("span", { class: "k" }, `Entry ≥ (${fmtRet(isNum(ref) && isNum(sc.entryTriggerPrice) ? sc.entryTriggerPrice / ref - 1 : null, 0)})`), el("span", { class: "v" }, fmtPrice(sc.entryTriggerPrice))),
      el("div", null, el("span", { class: "k" }, `Stop ≤ (${fmtRet(isNum(sc.entryTriggerPrice) ? sc.stopPrice / sc.entryTriggerPrice - 1 : null, 0)})`), el("span", { class: "v" }, fmtPrice(sc.stopPrice))),
      el("div", null, el("span", { class: "k" }, `Target ≥ (${fmtRet(isNum(sc.entryTriggerPrice) ? sc.targetPrice / sc.entryTriggerPrice - 1 : null, 0)})`), el("span", { class: "v" }, fmtPrice(sc.targetPrice))),
    ),
    compact
      ? null
      : el("div", { class: "evidence" }, ["ret_2h", "accel_1h", "vol24_change_2h", "rs_market_2h"].map((k) => el("div", null, el("span", null, `${FEATURE[k].label}: `), el("b", { class: tone(f[k]) }, fmtFeature(k, f[k]))))),
    el("div", { class: "row" }, el("span", null, "Score ", meter(s.heuristicScore)), isNum(s.agentScore) ? el("span", null, "Agent ", el("b", null, s.agentScore.toFixed(0))) : null, el("span", null, `Entry window until ${fmtTime(sc.signalExpiresAt || s.expiresAt, { date: false })} (${fmtAgo(sc.signalExpiresAt || s.expiresAt)})`)),
    el("div", { class: "row" }, el("span", null, "Pump ", levelLabel(PUMP, s.pumpChance)), el("span", null, "Agents ", levelLabel(AGENT_REC, s.agentRecommendation, "n/a")), el("span", null, "Call ", levelLabel(FINAL_REC, s.recommendation, "n/a"))),
    compact || !s.agentRecommendationReason ? null : el("div", { class: "hint" }, `Agents: ${s.agentRecommendationReason}`),
    compact ? null : riskChips(s.riskFlags),
    el("div", { class: "hint" }, `${s.origin === "agent" ? "Reviewed by Claude agents" : s.origin === "fixture_agent" ? "Offline stand-in review (not Claude)" : "Deterministic screen only"} · review: ${(s.reviewOutcome || "n/a").replace(/_/g, " ")}`),
  );
  card.addEventListener("click", () => openCoin(s.assetId, card));
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCoin(s.assetId, card); }
  });
  return card;
}

async function loadSignals() {
  const q = new URLSearchParams();
  if ($("f-status").value) q.set("status", $("f-status").value);
  if ($("f-type").value) q.set("classification", $("f-type").value);
  const data = await api(`signals?${q}`);
  S.signals.data = data;
  const rd = data.readiness || {};
  $("signals-meta").textContent = data.signals.length ? `slot ${fmtTime(data.signals[0].slotTime)} ${tzName()}` : "";
  $("signals-status").textContent = data.signals.length ? "" : rd.message || "No signals yet.";
  put($("signals"), ...data.signals.map((s) => signalCard(s)));
  if (!data.signals.length && rd.state === "ready") put($("signals"), el("div", { class: "empty" }, "No signals match the selected filters."));
}

/* ============================== Strategy screen ============================== */

const SCREEN_SORT = {
  score: (r) => r.heuristicScore,
  symbol: (r) => r.asset.symbol,
  price: (r) => r.quote && r.quote.price,
  cap: (r) => r.quote && r.quote.marketCap,
  vol: (r) => r.quote && r.quote.volume24h,
};
for (const k of ["ret_1h", "ret_2h", "accel_1h", "vol24_change_2h", "rs_market_2h", "vol_mcap"]) SCREEN_SORT[k] = (r) => r.keyFeatures && r.keyFeatures.values[k];

async function ensureScreenRows() {
  const runId = S.publishedRunId;
  if (!runId) return [];
  if (S.screen.runId !== runId) {
    $("screen-table").classList.add("loading");
    const data = await api(`screening?runId=${runId}&limit=5000`);
    S.screen.rows = data.results;
    S.screen.slotTime = data.slotTime;
    S.screen.runId = runId;
    $("screen-table").classList.remove("loading");
  }
  return S.screen.rows;
}

async function renderScreen() {
  const rows = await ensureScreenRows();
  $("count-screen").textContent = fmtInt(rows.length);
  if (!S.publishedRunId) {
    put($("screen-table"), el("div", { class: "empty" }, "The screen appears after the first run is published."));
    put($("screen-pager"), );
    return;
  }
  const q = $("screen-search").value.trim().toLowerCase();
  const ready = $("screen-ready").value;
  const pat = $("screen-pattern").value;
  let list = rows.filter((r) => {
    if (q && !r.asset.symbol.toLowerCase().includes(q) && !r.asset.name.toLowerCase().includes(q)) return false;
    if (ready === "eligible" && !r.eligible) return false;
    if (ready === "shortlisted" && !r.shortlisted) return false;
    if (ready === "warming" && !r.exclusionReasons.includes("warming_up")) return false;
    if (ready === "excluded" && r.eligible) return false;
    if (pat && (!r.eligible || r.classification !== pat)) return false;
    return true;
  });
  const { key, dir } = S.screen.sort;
  const get = SCREEN_SORT[key] || SCREEN_SORT.score;
  list = [...list].sort((a, b) => {
    if (key === "score" && a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    const va = get(a), vb = get(b);
    if (va === vb) return a.asset.symbol.localeCompare(b.asset.symbol);
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    const c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    return dir === "asc" ? c : -c;
  });
  const size = Number($("screen-rows").value);
  const pages = Math.max(1, Math.ceil(list.length / size));
  S.screen.page = Math.min(S.screen.page, pages - 1);
  const page = list.slice(S.screen.page * size, (S.screen.page + 1) * size);
  $("screen-meta").textContent = `${fmtInt(rows.length)} coins evaluated · slot ${fmtTime(S.screen.slotTime)} ${tzName()}`;
  const fv = (r, k) => r.keyFeatures && r.keyFeatures.values[k];
  const cols = [
    { label: "#", num: true, render: (r) => (r.rank ? String(r.rank) : "") },
    { label: "Coin", sort: "symbol", render: (r) => coinCell(r.asset) },
    { label: "Price", num: true, sort: "price", render: (r) => fmtPrice(r.quote && r.quote.price) },
    { label: "1h", num: true, sort: "ret_1h", title: FEATURE.ret_1h.help, render: (r) => pctCell(fv(r, "ret_1h")) },
    { label: "2h", num: true, sort: "ret_2h", title: FEATURE.ret_2h.help, render: (r) => pctCell(fv(r, "ret_2h")) },
    { label: "Accel.", num: true, sort: "accel_1h", title: FEATURE.accel_1h.help, render: (r) => pctCell(fv(r, "accel_1h"), fmtPP) },
    { label: "Vol. build", num: true, sort: "vol24_change_2h", title: FEATURE.vol24_change_2h.help, render: (r) => pctCell(fv(r, "vol24_change_2h")) },
    { label: "vs market", num: true, sort: "rs_market_2h", title: FEATURE.rs_market_2h.help, render: (r) => pctCell(fv(r, "rs_market_2h"), fmtPP) },
    { label: "Turnover", num: true, sort: "vol_mcap", title: FEATURE.vol_mcap.help, render: (r) => fmtRatioPct(fv(r, "vol_mcap")) },
    { label: "Cap · 24h vol", num: true, sort: "cap", title: "Circulating market cap and rolling 24h volume (sorts by cap)", render: (r) => el("div", { class: "stacked" }, el("b", null, fmtUsd(r.quote && r.quote.marketCap)), el("span", null, fmtUsd(r.quote && r.quote.volume24h))) },
    { label: "Pattern", render: (r) => (r.eligible ? patternLabel(r.classification) : el("span", { class: "muted" }, "—")) },
    { label: "Pump", title: "Strategy pump chance (heuristic level, not a probability)", render: (r) => (r.eligible ? el("span", { title: (r.pumpReasons || []).join("\n") }, levelLabel(PUMP, r.pumpChance)) : el("span", { class: "muted" }, "—")) },
    { label: "Score", sort: "score", render: (r) => meter(r.heuristicScore) },
    { label: "Status", render: (r) => (r.eligible ? (r.shortlisted ? chip("Shortlisted", { dot: "good", strong: true }) : chip("Eligible", { dot: "accent" })) : reasonChips(r.exclusionReasons)) },
  ];
  put($("screen-table"), 
    table(cols, page, {
      sort: S.screen.sort,
      onSort: (k) => {
        S.screen.sort = S.screen.sort.key === k ? { key: k, dir: S.screen.sort.dir === "asc" ? "desc" : "asc" } : { key: k, dir: k === "symbol" ? "asc" : "desc" };
        S.screen.page = 0;
        void renderScreen();
      },
      onRow: (r, tr) => openCoin(r.assetId, tr),
      rowClass: (r) => (r.shortlisted ? "highlight" : ""),
      empty: "No coins match these filters.",
    }),
  );
  pager($("screen-pager"), { page: S.screen.page, pageSize: size, total: list.length, onPage: (p) => { S.screen.page = p; void renderScreen(); } });
}

/* ============================== All coins ============================== */

async function loadMarket() {
  const size = Number($("market-rows").value);
  const q = new URLSearchParams({ sort: S.market.sort, dir: S.market.dir, scope: $("market-scope").value, limit: String(size), offset: String(S.market.page * size) });
  const search = $("market-search").value.trim();
  if (search) q.set("search", search);
  $("market-table").classList.add("loading");
  const data = await api(`market?${q}`);
  $("market-table").classList.remove("loading");
  S.market.data = data;
  S.market.runId = S.publishedRunId;
  if ($("market-scope").value === "all" && !search) $("count-market").textContent = fmtInt(data.total);
  $("market-meta").textContent = data.slotTime ? `${fmtInt(data.total)} coins · slot ${fmtTime(data.slotTime)} ${tzName()}` : "";
  const strategyCell = (c) => {
    const s = c.strategy;
    if (!s.inUniverse) return el("span", { class: "muted" }, reasonChips(s.reasons));
    if (!s.screened) return chip("In universe · pending screen", { dot: "" });
    if (s.eligible) return el("span", null, patternLabel(s.classification), s.shortlisted ? chip("Shortlisted", { dot: "good", strong: true }) : null);
    return reasonChips(s.reasons);
  };
  const cols = [
    { label: "#", num: true, render: (c) => String(data.coins.indexOf(c) + 1 + data.offset) },
    { label: "Coin", sort: "symbol", render: (c) => coinCell(c.asset) },
    { label: "Price", num: true, render: (c) => fmtPrice(c.price) },
    { label: "1h", num: true, sort: "change_1h", render: (c) => pctCell(c.providerChangePct1h, fmtPctValue) },
    { label: "24h", num: true, sort: "change_24h", render: (c) => pctCell(c.providerChangePct24h, fmtPctValue) },
    { label: "7d", num: true, sort: "change_7d", render: (c) => pctCell(c.providerChangePct7d, fmtPctValue) },
    { label: "Market cap", num: true, sort: "market_cap", render: (c) => (isNum(c.marketCap) ? fmtUsd(c.marketCap) : el("span", { class: "muted", title: "CoinMarketCap reports no circulating supply; FDV is never substituted" }, "not reported")) },
    { label: "24h volume", num: true, sort: "volume", render: (c) => fmtUsd(c.volumeRolling24h) },
    { label: "Turnover", num: true, render: (c) => (isNum(c.marketCap) && isNum(c.volumeRolling24h) && c.marketCap > 0 ? fmtRatioPct(c.volumeRolling24h / c.marketCap) : "—") },
    { label: "Strategy", render: strategyCell },
  ];
  put($("market-table"), 
    table(cols, data.coins, {
      sort: { key: S.market.sort, dir: S.market.dir },
      onSort: (k) => {
        S.market.dir = S.market.sort === k ? (S.market.dir === "asc" ? "desc" : "asc") : k === "symbol" ? "asc" : "desc";
        S.market.sort = k;
        S.market.page = 0;
        void loadMarket().catch(showError("market-table"));
      },
      onRow: (c, tr) => openCoin(c.assetId, tr),
      empty: data.slotTime ? "No coins match." : "No coins collected yet.",
    }),
  );
  pager($("market-pager"), { page: S.market.page, pageSize: size, total: data.total, onPage: (p) => { S.market.page = p; void loadMarket().catch(showError("market-table")); } });
}

/* ============================== Collection ============================== */

async function loadCollection() {
  const h = await api("health");
  const c = h.coverage;
  const cov = c.lastRunCoverage || {};
  const sh = c.sourceHealth || {};
  put($("coverage-tiles"), 
    tiles([
      { label: "Source", value: c.provider ? c.provider.name : "—", sub: c.isLiveData ? (c.provider && c.provider.accessMethod === "website" ? "website collector (no key)" : "official API") : "synthetic fixture" },
      { label: "Listed coins", value: fmtInt(cov.universeSize ?? (c.lastDiscovery && c.lastDiscovery.sourceTotal)), sub: c.lastDiscovery ? `discovery ${fmtAgo(c.lastDiscovery.startedAt)}` : "no discovery yet" },
      { label: "Collected last run", value: fmtInt(cov.collected), sub: cov.label ? `${cov.label}${isNum(cov.coveragePct) ? ` · ${cov.coveragePct.toFixed(2)}%` : ""}` : "" },
      { label: "Stale quotes", value: fmtInt(cov.stale), sub: `older than ${S.cfg.staleAfterMinutes} min at collection` },
      { label: "Known coins", value: fmtInt(c.knownAssets), sub: `${fmtInt(c.activeIdentities)} active listings` },
    ]),
  );
  const budget = c.monthlyRequestBudget;
  put($("source-health"), 
    kvTable(
      [
        ["Circuit", sh.state ? statusLabel(sh.state === "closed" ? "good" : sh.state === "suspended" ? "critical" : "warning", { closed: "Closed (healthy)", open: "Open (cooling down)", half_open: "Half-open (testing)", suspended: "Suspended" }[sh.state] || sh.state) : "No requests yet"],
        ["Last success", sh.lastSuccessAt ? `${fmtTime(sh.lastSuccessAt)} (${fmtAgo(sh.lastSuccessAt)})` : "—"],
        ["Last failure", sh.lastFailureAt ? `${fmtTime(sh.lastFailureAt)} (${fmtAgo(sh.lastFailureAt)})${sh.consecutiveFailures ? ` · ${sh.consecutiveFailures} in a row` : " · recovered"}` : "none"],
        ["Last response", sh.lastStatusCode ? `HTTP ${sh.lastStatusCode}` : "—"],
        ["Retry-after", sh.retryAfterUntil && new Date(sh.retryAfterUntil) > new Date() ? `until ${fmtTime(sh.retryAfterUntil)}` : "—"],
        ["Monthly requests", budget ? el("div", null, `${fmtInt(sh.budgetUsed || 0)} of ${fmtInt(budget)}`, meter(((sh.budgetUsed || 0) / budget) * 100, { wide: true, suffix: "%", title: "Share of the monthly request budget used" })) : fmtInt(sh.budgetUsed || 0)],
        ...(sh.suspendedReason ? [["Suspended", `${sh.suspendedReason} — fix the cause, then run npm run cli -- source:reset`]] : []),
      ],
    ),
  );
  const rt = S.cfg.retention || {};
  const hs = S.cfg.history || {};
  put($("storage-policy"), 
    el("ul", { class: "notes" },
      el("li", null, "Every listed coin gets one snapshot per UTC hour (idempotent: re-runs never duplicate)."),
      el("li", null, `Strategy-universe coins keep every hourly snapshot ${rt.snapshotDays ? `for ${rt.snapshotDays} days` : "forever"}.`),
      el("li", null, rt.detailDays ? `Coins outside the floors keep hourly detail for ${rt.detailDays} days, then the first snapshot of each UTC day (rows within 72 h of any hour a coin qualified stay hourly).` : "Coins outside the floors keep every hourly snapshot (RETENTION_DETAIL_DAYS=0)."),
      el("li", null, `Features and screening rows are stored only for evaluated coins${rt.detailDays ? ` and pruned after ${rt.detailDays} days (recomputable)` : ""}; shortlisted rows, signals and paper trades are kept.`),
      el("li", null, `History backfill: up to ${fmtInt(hs.maxAssetsPerRun)} coins and ${hs.maxMinutesPerRun} minutes per run, never spending the request budget reserved for hourly listings.`),
    ),
  );
  const runs = h.runs.map((r) => ({ ...r, durationMs: r.finishedAt && r.startedAt ? new Date(r.finishedAt) - new Date(r.startedAt) : null }));
  put($("runs"), 
    table(
      [
        { label: "Slot", render: (r) => el("span", { class: "nowrap" }, fmtTime(r.slotTime)) },
        { label: "Status", render: (r) => runStatus(r.status, r.status === "running") },
        { label: "Took", num: true, render: (r) => fmtDuration(r.durationMs) },
        { label: "Stages", render: (r) => el("span", null, (r.stages || []).map((s) => chip(`${STAGE[s.stage] || s.stage}${s.finishedAt ? ` ${fmtDuration(new Date(s.finishedAt) - new Date(s.startedAt))}` : ""}`, { dot: s.status === "succeeded" ? "good" : s.status === "failed" ? "critical" : s.status === "running" ? "accent" : "", title: s.error || "" }))) },
        { label: "Coverage", render: (r) => (r.coverage ? `${fmtInt(r.coverage.collected)}${r.coverage.universeSize ? ` / ${fmtInt(r.coverage.universeSize)}` : ""} · ${r.coverage.label}` : "—") },
        { label: "Eligible", num: true, render: (r) => fmtInt(r.metrics && r.metrics.eligible) },
        { label: "Model cost", num: true, render: (r) => `$${Number(r.modelCostUsd || 0).toFixed(4)}` },
        { label: "Note", render: (r) => el("span", { class: r.error ? "error small" : "muted small" }, r.error ? r.error.slice(0, 160) : "") },
      ],
      runs,
      { empty: "No runs yet." },
    ),
  );
}

/* ============================== VMC ============================== */

async function loadVmc() {
  const c = await api("vmc/comparison");
  $("vmc-meta").textContent = `${c.isFixture ? "SYNTHETIC FIXTURE DATA · " : ""}generated ${fmtTime(c.generatedAt)}`;
  const ratio = (s) => (s === null || s === undefined ? "—" : fmtRatioPct(Number(s), 3));
  put($("vmc"), 
    table(
      [
        { label: "CMC id", num: true, render: (r) => String(r.cmcId) },
        { label: "Coin", render: (r) => coinCell({ symbol: r.symbol, name: r.name, cmcId: r.cmcId }) },
        { label: "Observed", render: (r) => (r.observationTimeUtc ? `${fmtTime(r.observationTimeUtc)}${r.quoteAgeMinutes !== null ? ` (${r.quoteAgeMinutes} min old)` : ""}` : "—") },
        { label: "24h volume", num: true, render: (r) => fmtUsd(r.volume24hUsd === null ? null : Number(r.volume24hUsd)) },
        { label: "Market cap", num: true, render: (r) => fmtUsd(r.marketCapUsd === null ? null : Number(r.marketCapUsd)) },
        { label: "Current ratio", num: true, title: "Rolling 24h volume ÷ market cap", render: (r) => ratio(r.currentRatio) },
        { label: "6-month baseline", num: true, render: (r) => ratio(r.baselineMean) },
        { label: "Current ÷ baseline", num: true, render: (r) => (/^[\d.]+x$/.test(r.ratioToBaseline) ? `${Number(r.ratioToBaseline.slice(0, -1)).toFixed(2)}×` : el("span", { class: "muted" }, r.ratioToBaseline.replace(/^n\/a /, ""))) },
        { label: "Baseline coverage", render: (r) => el("span", { class: "small" }, r.baselineCoverage) },
        { label: "72h window", render: (r) => el("span", { class: "small" }, r.recentWindow) },
        { label: "Data status", render: (r) => el("span", null, r.dataStatus.map((s) => chip(vmcStatusLabel(s), { dot: s === "ok" ? "good" : "warning" }))) },
      ],
      c.rows,
      { empty: "No coins configured. Set VMC_ASSET_IDS (e.g. 1,1027,2) and run npm run cli -- vmc:run-all." },
    ),
  );
}

/* ============================== Paper trading ============================== */

async function loadPaper() {
  const [p, b] = await Promise.all([api("paper"), api("backtest").catch(() => null)]);
  const s = p.summary;
  put($("paper-tiles"), 
    tiles([
      { label: "Paper positions", value: fmtInt(s.total), sub: `${s.open} open · ${s.pendingEntry} awaiting entry` },
      { label: "Closed", value: fmtInt(s.closed), sub: `${s.expiredWithoutEntry} expired without entry` },
      { label: "Win rate", value: s.winRate === null ? "pending" : fmtShare(s.winRate, 1), sub: "net of fees and slippage" },
      { label: "Average net return", value: s.avgNetReturn === null ? "pending" : fmtRet(s.avgNetReturn), tone: tone(s.avgNetReturn) },
      { label: "Ambiguous ordering", value: fmtInt(s.ambiguousOrdering), sub: "stop and target inside one hour" },
    ]),
  );
  put($("paper"), 
    el("p", { class: "hint" }, s.note),
    table(
      [
        { label: "Coin", render: (x) => coinCell(x.signal.asset) },
        { label: "Signal", render: (x) => el("span", { class: "nowrap" }, fmtTime(x.signal.slotTime)) },
        { label: "Status", render: (x) => ({ pending_entry: "Awaiting entry", open: "Open", closed: "Closed", expired: "Expired (no entry)" })[x.status] || x.status },
        { label: "Entry trigger", num: true, render: (x) => fmtPrice(x.entryTriggerPrice) },
        { label: "Entry", num: true, render: (x) => fmtPrice(x.entryPrice) },
        { label: "Stop", num: true, render: (x) => fmtPrice(x.stopPrice) },
        { label: "Target", num: true, render: (x) => fmtPrice(x.targetPrice) },
        { label: "Exit", num: true, render: (x) => fmtPrice(x.exitPrice) },
        { label: "Reason", render: (x) => (x.exitReason || "").replace(/_/g, " ") },
        { label: "Net", num: true, render: (x) => pctCell(x.netReturn) },
      ],
      p.positions,
      { empty: "No paper positions yet. They open when a published signal has an entry rule." },
    ),
  );
  if (!b) {
    put($("backtest"), el("div", { class: "empty" }, "No backtest yet. Run npm run cli -- backtest once enough history exists (≥ 168 h)."));
    return;
  }
  const r = b.report;
  if (r.status !== "completed") {
    put($("backtest"), el("div", { class: "empty" }, `Evaluation pending: ${r.reason}`));
    return;
  }
  const m = (x) => (x ? `${x.signals} signals, ${x.trades} trades, precision ${fmtShare(x.precision, 1)}, false positives ${fmtShare(x.falsePositiveRate, 1)}, average net ${fmtRet(x.avgNetReturn)}, total ${fmtRet(x.totalNetReturn)}, max drawdown ${fmtRet(x.maxDrawdown)}` : "—");
  put($("backtest"), 
    b.isLiveData ? null : el("p", null, el("b", null, "Synthetic fixture data: says nothing about real-market performance.")),
    kvTable([
      ["Period", `${fmtTime(r.periodStart)} → ${fmtTime(r.periodEnd)}`],
      ["Strategy", m(r.strategy)],
      ["Momentum baseline", m(r.momentumBaseline)],
      ["BTC buy & hold", `${fmtRet(r.btcBuyHold.avgReturnPerWindow)} average per window (${r.btcBuyHold.windows} windows)`],
      ["Market median", `${fmtRet(r.marketMedian.avgReturnPerWindow)} average per window`],
      ["Final test", r.finalTest ? m(r.finalTest.strategy) : "held out (untouched)"],
      ["Calibration", r.calibration],
    ]),
    el("ul", { class: "notes" }, r.assumptions.map((a) => el("li", null, a))),
  );
}

/* ============================== Coin drawer ============================== */

function advanceChecks(f, market, p) {
  const v = (k) => (f && isNum(f[k]) ? f[k] : null);
  const r2 = v("ret_2h"), acc = v("accel_1h"), vb = v("vol24_change_2h"), rs = v("rs_market_2h"), ch24 = v("provider_change_24h");
  const med = market && isNum(market.marketMedianRet2h) ? market.marketMedianRet2h : null;
  const c = (ok, label, actual) => ({ ok, label, actual });
  return [
    c(vb === null ? null : vb >= p.advanceMinVolumeBuild, `Volume building: rolling 24h volume up ≥ ${fmtShare(p.advanceMinVolumeBuild)} over 2h`, fmtRet(vb)),
    c(acc === null ? null : acc > 0, "Price accelerating: this hour's return above the previous hour's", fmtPP(acc)),
    c(r2 === null ? null : r2 >= p.advanceMinRet2h, `Started moving: 2h return ≥ ${fmtRet(p.advanceMinRet2h, 1)}`, fmtRet(r2)),
    c(r2 === null ? null : r2 < p.underwayRet2h, `Still early: 2h return below ${fmtRet(p.underwayRet2h, 0)} (otherwise "move underway")`, fmtRet(r2)),
    c(rs === null ? null : rs > 0, "Ahead of the market median over 2h", fmtPP(rs)),
    c(med === null ? null : !(med >= p.marketRallyRet2h && (rs === null || rs < p.minRelativeStrength)), `Not just a broad rally (market median 2h < ${fmtRet(p.marketRallyRet2h, 1)} or ≥ ${fmtPP(p.minRelativeStrength, 0)} ahead)`, `median ${fmtRet(med)}`),
    c(r2 === null ? null : r2 < p.overextendedRet2h && (ch24 === null || ch24 < p.overextendedChange24h), `Not overextended (< ${fmtRet(p.overextendedRet2h, 0)} in 2h and < ${fmtRet(p.overextendedChange24h, 0)} in 24h)`, `24h ${fmtRet(ch24)}`),
  ];
}

async function openCoin(assetId, returnFocus) {
  S.drawer = { assetId, returnFocus: returnFocus || document.activeElement };
  $("drawer-backdrop").hidden = false;
  const d = $("drawer");
  d.hidden = false;
  $("drawer-title").textContent = "Loading…";
  $("drawer-sub").textContent = "";
  put($("drawer-body"), el("div", { class: "empty" }, "Loading coin data…"));
  $("drawer-close").focus();
  try {
    const [asset, snaps, feats] = await Promise.all([api(`assets/${assetId}`), api(`assets/${assetId}/snapshots?hours=168`), api(`assets/${assetId}/features`)]);
    if (S.drawer.assetId !== assetId) return;
    renderCoin(asset, snaps.snapshots, feats.features);
  } catch (e) {
    put($("drawer-body"), el("div", { class: "error" }, `Could not load this coin: ${e.message}`));
  }
}

function renderCoin(asset, snaps, feats) {
  const p = strategy();
  const latest = snaps[snaps.length - 1];
  const f = feats[0];
  const fv = (f && f.values) || {};
  const scr = asset.latestScreening;
  const sig = asset.latestSignal;
  const ident = (asset.identities || [])[0];
  const cmcIdent = (asset.identities || []).find((i) => /^coinmarketcap/.test(i.providerId) && /^\d+$/.test(i.providerAssetId));
  put($("drawer-title"), coinLogo(cmcIdent ? Number(cmcIdent.providerAssetId) : null, asset.symbol, 28), ` ${asset.symbol} · ${asset.name}`);
  put($("drawer-sub"), 
    el("span", null, `${CLASS_LABEL[asset.assetClass] || asset.assetClass}${asset.isBenchmark ? " · benchmark" : ""}`),
    latest && latest.sourceUrl && /^https:\/\//.test(latest.sourceUrl) ? el("span", null, " · ", el("a", { href: latest.sourceUrl, target: "_blank", rel: "noopener noreferrer" }, "Open on CoinMarketCap ↗")) : null,
  );
  const body = [];
  body.push(
    tiles(
      [
        { label: "Price", value: fmtPrice(latest && latest.price), sub: latest ? `observed ${fmtTime(latest.observedAt)}` : "" },
        { label: "1h (CMC)", value: fmtPctValue(latest && latest.providerChangePct1h), tone: tone(latest && latest.providerChangePct1h) },
        { label: "24h (CMC)", value: fmtPctValue(latest && latest.providerChangePct24h), tone: tone(latest && latest.providerChangePct24h) },
        { label: "Market cap", value: fmtUsd(latest && latest.marketCap), sub: latest && latest.marketCapProvenance === "calculated_from_circulating_supply" ? "calculated from supply" : "circulating" },
        { label: "24h volume", value: fmtUsd(latest && latest.volumeRolling24h), sub: "rolling 24h" },
        { label: "History", value: f ? `${f.historyDepth} h` : "—", sub: f ? { warming_up: "warming up", limited: "enough for the screen", full: "full statistical history" }[f.warmupState] : "" },
      ],
      true,
    ),
  );

  // The three hourly records the strategy compares (t, t−1h, t−2h).
  const last3 = snaps.slice(-Math.max(3, (S.cfg && S.cfg.snapshotWindow) || 3)).reverse();
  body.push(
    el(
      "div",
      { class: "card" },
      el("div", { class: "card-head" }, el("h2", null, "Latest hourly records"), el("span", { class: "hint" }, "the screen compares t, t−1h and t−2h; a missing hour breaks the chain")),
      el(
        "div",
        { class: "table-wrap" },
        table(
          [
            { label: "Slot", render: (s) => el("span", { class: "nowrap" }, fmtTime(s.slotTime)) },
            { label: "Observed", render: (s) => el("span", { class: "nowrap muted" }, fmtTime(s.observedAt, { date: false })) },
            { label: "Price", num: true, render: (s) => fmtPrice(s.price) },
            { label: "vs previous hour", num: true, render: (s) => { const prev = snaps[snaps.indexOf(s) - 1]; return prev && isNum(prev.price) && isNum(s.price) && new Date(s.slotTime) - new Date(prev.slotTime) === 3600000 ? pctCell(s.price / prev.price - 1) : el("span", { class: "muted" }, "gap"); } },
            { label: "Rolling 24h volume", num: true, render: (s) => fmtUsd(s.volumeRolling24h) },
            { label: "Market cap", num: true, render: (s) => fmtUsd(s.marketCap) },
            { label: "Source", render: (s) => (s.qualityFlags.includes("historical_backfill") ? chip("chart history") : s.qualityFlags.includes("fixture_backfill") ? chip("synthetic backfill") : chip("hourly listing")) },
          ],
          last3,
          { empty: "No snapshots yet." },
        ),
      ),
    ),
  );

  const pricePts = snaps.map((s) => ({ t: new Date(s.slotTime).getTime(), v: s.price, note: s.qualityFlags.includes("historical_backfill") ? "genuine chart history (backfilled)" : null }));
  const volPts = snaps.map((s) => ({ t: new Date(s.slotTime).getTime(), v: s.volumeRolling24h, note: s.qualityFlags.includes("historical_backfill") ? "genuine chart history (backfilled)" : null }));
  body.push(el("div", { class: "card" }, lineChart(pricePts, { title: "Price (USD) · hourly snapshots", label: "Price", format: fmtPrice }), lineChart(volPts, { title: "Rolling 24h volume (USD)", label: "Rolling 24h volume", format: fmtUsd, height: 140 })));

  // Strategy view.
  const market = S.overview && S.overview.funnel ? S.overview.funnel.market : null;
  const checks = advanceChecks(fv, market, p);
  const stratCard = el(
    "div",
    { class: "card" },
    el("div", { class: "card-head" }, el("h2", null, "Strategy view"), scr ? el("span", { class: "hint" }, `screened ${fmtTime(scr.slotTime)}`) : null),
    scr
      ? el(
          "div",
          { class: "row" },
          el("p", null, scr.eligible ? patternLabel(scr.classification) : el("span", null, "Not eligible: ", reasonChips(scr.exclusionReasons)), " ", scr.shortlisted ? chip("Shortlisted for agents", { dot: "good", strong: true }) : null),
          el("div", null, el("span", { class: "hint" }, "Heuristic score "), meter(Number(scr.heuristicScore))),
          scr.riskFlags.length ? el("p", null, el("span", { class: "hint" }, "Risk flags: "), riskChips(scr.riskFlags, 10)) : null,
        )
      : el("p", { class: "muted" }, "This coin is outside the strategy floors (or not screened yet), so it has no screening result."),
    scr && scr.eligible ? el("div", null, el("h3", { class: "small muted" }, "Pump chance (base strategy)"), el("p", null, levelLabel(PUMP, scr.pumpChance)), el("ul", { class: "notes" }, (scr.pumpReasons || []).map((x) => el("li", null, x)))) : null,
    el("h3", { class: "small muted" }, "Advance-candidate checklist"),
    el(
      "ul",
      { class: "checks" },
      checks.map((c) => el("li", null, el("span", { class: `mark ${c.ok === null ? "na" : c.ok ? "ok" : "no"}`, "aria-label": c.ok === null ? "not available" : c.ok ? "met" : "not met" }, c.ok === null ? "–" : c.ok ? "✓" : "✕"), el("span", null, c.label), el("span", { class: "actual" }, c.actual))),
    ),
  );
  body.push(stratCard);

  if (f) {
    const keys = Object.keys(FEATURE).filter((k) => k in f.values);
    body.push(
      el(
        "div",
        { class: "card" },
        el("div", { class: "card-head" }, el("h2", null, "Features"), el("span", { class: "hint" }, `computed for slot ${fmtTime(f.slotTime)}; unavailable values show why`)),
        el(
          "div",
          { class: "table-wrap" },
          table(
            [
              { label: "Feature", render: (k) => el("span", { title: FEATURE[k].help }, FEATURE[k].label) },
              { label: "Value", num: true, render: (k) => (f.values[k] === null ? el("span", { class: "muted" }, "—") : el("span", { class: ["ret", "pp", "z"].includes(FEATURE[k].kind) ? tone(f.values[k]) : "" }, fmtFeature(k, f.values[k]))) },
              { label: "Meaning", render: (k) => el("span", { class: "small muted" }, f.values[k] === null ? (f.unavailable[k] || "unavailable") : FEATURE[k].help) },
            ],
            keys,
          ),
        ),
      ),
    );
  }

  if (sig) {
    const sc = sig.scenario || {};
    body.push(
      el(
        "div",
        { class: "card" },
        el("div", { class: "card-head" }, el("h2", null, "Latest research signal"), el("span", { class: "hint" }, `slot ${fmtTime(sig.slotTime)}`)),
        el("p", null, signalStatus(sig.status), " · ", sig.signalType === "move_underway" ? "move underway (detection)" : sig.signalType, " · score ", meter(Number(sig.heuristicScore))),
        kvTable([
          ["Entry", sc.entryRule || sig.entryTrigger],
          ["Invalidation", sc.stopRule || sig.invalidation],
          ["Target", sc.targetRule || ""],
          ["Trailing stop", sc.trailingRule || ""],
          ["Costs", `${sc.feeBps} bps fee + ${sc.slippageBps} bps slippage per side`],
          ["Execution", sc.executionAssumption || ""],
          ["Paper position", sig.paperPosition ? `${sig.paperPosition.status.replace(/_/g, " ")}${sig.paperPosition.netReturn !== null ? ` · net ${fmtRet(sig.paperPosition.netReturn)}` : ""}` : "none"],
          ["Agents' stance", el("span", null, levelLabel(AGENT_REC, sig.agentRecommendation, "not reviewed"), sig.agentRecommendationReason ? ` — ${sig.agentRecommendationReason}` : "")],
          ["Combined call", el("span", null, levelLabel(FINAL_REC, sig.recommendation, "n/a"), sig.recommendationReason ? ` — ${sig.recommendationReason}` : "")],
          ["Rationale", sig.rationale],
        ]),
        el("h3", { class: "small muted" }, "Evidence"),
        el("ul", { class: "notes" }, (sig.evidence || []).map((e) => el("li", null, `${(FEATURE[e.metric] || {}).label || e.metric}: ${FEATURE[e.metric] ? fmtFeature(e.metric, e.value) : e.value} — ${e.interpretation}`))),
        el("h3", { class: "small muted" }, "Counter-evidence"),
        el("ul", { class: "notes" }, (sig.counterevidence || []).map((c) => el("li", null, c.point))),
        (sig.dataQuality && sig.dataQuality.guardrailNotes || []).length ? el("details", null, el("summary", null, "Guardrail notes"), el("ul", { class: "notes" }, sig.dataQuality.guardrailNotes.map((n) => el("li", null, n)))) : null,
      ),
    );
  }

  body.push(
    el(
      "details",
      { class: "card" },
      el("summary", null, "Identity and provenance"),
      kvTable([
        ["Canonical id", asset.id],
        ["Provider ids", (asset.identities || []).map((i) => `${i.providerId}: ${i.providerAssetId}`).join(", ") || "—"],
        ["Contracts", (asset.contracts || []).map((c) => `${c.chain}: ${c.contractAddress}`).join(", ") || "none recorded"],
        ["First seen", fmtTime(asset.firstSeenAt)],
        ["Latest quality flags", latest && latest.qualityFlags.length ? latest.qualityFlags.join(", ") : "none"],
        ["Missing fields", latest ? Object.keys(latest.nullReasons || {}).join(", ") || "none" : "—"],
        ["Listing", ident && ident.delistedAt ? `delisted ${fmtTime(ident.delistedAt)}` : "active"],
      ]),
    ),
  );
  put($("drawer-body"), ...body);
}

function closeDrawer() {
  $("drawer").hidden = true;
  $("drawer-backdrop").hidden = true;
  hideTooltip();
  const back = S.drawer.returnFocus;
  S.drawer = { assetId: null, returnFocus: null };
  if (back && document.contains(back)) back.focus();
}

/* ============================== Router & refresh ============================== */

const TABS = ["overview", "signals", "screen", "market", "collection", "vmc", "paper", "access"];
const showError = (id) => (e) => {
  console.error(e);
  const box = $(id);
  if (box) put(box, el("div", { class: "error" }, `Could not load: ${e.message}`));
};

async function loadTab(tab) {
  if (tab === "signals") await Promise.all([loadRecs().catch(showError("recs-full")), loadSignals().catch(showError("signals"))]);
  else if (tab === "screen") await renderScreen().catch(showError("screen-table"));
  else if (tab === "market") await loadMarket().catch(showError("market-table"));
  else if (tab === "collection") await loadCollection().catch(showError("runs"));
  else if (tab === "vmc") await loadVmc().catch(showError("vmc"));
  else if (tab === "paper") await loadPaper().catch(showError("paper"));
  else if (tab === "access") await loadAccess().catch(showError("access-pending"));
  else if (tab === "overview" && S.overview && S.overview.funnel) await Promise.all([loadRecs().catch(showError("recs")), loadTopSignals().catch(showError("top-signals"))]);
}

/* ============================== Telegram access ============================== */

let accessBusy = false;

async function changeAccess(action, chatId, doneMsg) {
  if (accessBusy) return;
  accessBusy = true;
  try {
    const r = await apiPost(`telegram/access/${action}`, { chatId });
    await loadAccess();
    if (action === "approve" && r && r.notified === false) showAccessNote("warning", `${doneMsg} — but Telegram would not deliver the welcome message. They must open the bot and press Start to receive reports.`);
    else showAccessNote("ok", doneMsg);
  } catch (e) {
    showAccessNote("error", `Could not change access: ${e.message}`);
  } finally {
    accessBusy = false;
  }
}

function showAccessNote(kind, text) {
  put($("access-note"), el("div", { class: kind === "error" ? "error" : "banner-note" }, text));
}

const MISSED_STATE = {
  pending: { label: "Queued", dot: "accent" },
  retrying: { label: "Retrying", dot: "warning" },
  gave_up: { label: "Gave up", dot: "critical" },
  not_queued: { label: "Not sent", dot: "" },
};

/** Send / retry, then show the outcome and refresh; delivery may still be finishing, so refresh again shortly. */
async function deliveryAction(path, body, okMsg) {
  if (accessBusy) return;
  accessBusy = true;
  try {
    const r = await apiPost(path, body);
    const d = r.delivery;
    const outcome = d ? `${d.sent} sent${d.failed ? `, ${d.failed} failed` : ""}${d.deferred ? `, ${d.deferred} will retry` : ""}` : r.reason || ((r.queued ?? r.requeued) ? "sending in the background" : "nothing to send");
    showAccessNote(d && d.failed ? "warning" : "ok", `${okMsg}: ${outcome}.`);
  } catch (e) {
    showAccessNote("error", `Could not send: ${e.message}`);
  } finally {
    accessBusy = false;
  }
  await loadAccess().catch(() => undefined);
  setTimeout(() => void loadAccess().catch(() => undefined), 6000);
}

async function loadAccess() {
  const [a, missed] = await Promise.all([api("telegram/access"), api("telegram/missing")]);
  $("count-access").textContent = fmtInt(a.pending.length + missed.rows.length);
  const label = (r) => `${r.label}`;
  put($("access-missed"), table([
    { label: "Report hour", render: (r) => fmtTime(r.slotTime) },
    { label: "Person", render: (r) => el("span", null, el("strong", null, label(r)), " ", el("span", { class: "hint" }, `id ${r.chatId}`)) },
    { label: "State", render: (r) => statusLabel((MISSED_STATE[r.state] || {}).dot || "", (MISSED_STATE[r.state] || {}).label || r.state) },
    { label: "Parts", render: (r) => (r.partCount ? `${r.partsSent}/${r.partCount}` : "—") },
    { label: "Why", render: (r) => (r.state === "not_queued" ? "no copy was queued for this person (e.g. approved later)" : r.lastError || (r.state === "pending" ? "waiting to be sent" : "")) },
    { label: "Next try", render: (r) => (r.nextAttemptAt ? fmtTime(r.nextAttemptAt) : r.state === "gave_up" ? "manual" : "") },
    { label: "", render: (r) => el("button", { type: "button", class: "btn", disabled: !a.canManage, onclick: () => void (r.state === "not_queued" ? deliveryAction("telegram/send", { runId: r.runId, chatIds: [r.chatId] }, `Sent ${fmtTime(r.slotTime)} report to ${r.label}`) : deliveryAction("telegram/retry", { runId: r.runId, chatId: r.chatId }, `Retried ${r.label}`)) }, r.state === "not_queued" ? "Send" : "Retry") },
  ], missed.rows, { empty: missed.mode === "live" ? "No missed reports in the last 6 hours." : `Telegram is ${missed.mode}: nothing is sent.` }));
  $("missed-retry-all").disabled = !a.canManage || !missed.rows.some((r) => r.state !== "not_queued");
  $("send-latest-all").disabled = !a.canManage || missed.mode !== "live";
  const act = (label, cls, fn) => el("button", { type: "button", class: `btn${cls ? ` ${cls}` : ""}`, disabled: !a.canManage, onclick: fn }, label);
  const who = (r) => el("span", null, el("strong", null, r.label), " ", el("span", { class: "hint" }, `id ${r.chatId}`));
  const when = { label: "Since", render: (r) => (r.at ? fmtTime(r.at) : "") };
  if (!a.canManage) put($("access-note"), el("div", { class: "error" }, "Read-only: set DASHBOARD_BASIC_AUTH (or keep HOST on 127.0.0.1) to approve or reject from the dashboard."));
  else if (a.mode !== "live" || !a.commandsEnabled) put($("access-note"), el("div", { class: "banner-note" }, `Telegram is ${a.mode === "live" ? "live" : a.mode}${a.commandsEnabled ? "" : " and bot commands are off"}: new people can only ask for access when the app runs with TELEGRAM_MODE=live and TELEGRAM_COMMANDS_ENABLED=true.`));
  else put($("access-note"));
  put($("access-pending"), table([
    { label: "Person", render: who }, when,
    { label: "", render: (r) => el("div", { class: "row-actions" }, act("Approve", "primary", () => changeAccess("approve", r.chatId, `Approved ${r.label}.`)), act("Reject", "danger", () => changeAccess("reject", r.chatId, `Rejected ${r.label}.`))) },
  ], a.pending, { empty: "No pending requests. Ask the person to open your bot and send /start." }));
  put($("access-members"), table([
    { label: "Person", render: who }, when,
    { label: "", render: (r) => el("div", { class: "row-actions" }, r.chatId && r.chatId !== "—" ? el("button", { type: "button", class: "btn", disabled: !a.canManage || missed.mode !== "live", onclick: () => void deliveryAction("telegram/send", { chatIds: [r.chatId] }, `Sent latest report to ${r.label}`) }, "Send latest report") : null, r.owner ? el("span", { class: "hint" }, "always allowed") : act("Remove", "danger", () => changeAccess("remove", r.chatId, `Removed ${r.label}.`))) },
  ], [{ chatId: a.owner || "—", label: "Owner", at: null, owner: true }, ...a.members].map((r) => r), { empty: "No members." }));
  put($("access-denied"), table([
    { label: "Chat id", render: (r) => r.chatId },
    { label: "", render: (r) => act("Allow again", "", () => changeAccess("approve", r.chatId, `Approved ${r.chatId}.`)) },
  ], a.denied.map((chatId) => ({ chatId })), { empty: "Nobody rejected." }));
}

async function loadTopSignals() {
  const data = await api("signals?limit=6");
  put($("top-signals"), data.signals.length ? el("div", { class: "signal-cards" }, data.signals.map((s) => signalCard(s, true))) : el("div", { class: "empty" }, (data.readiness && data.readiness.message) || "No signals this hour."));
}

function selectTab(tab, push = true) {
  if (!TABS.includes(tab)) tab = "overview";
  S.tab = tab;
  for (const t of TABS) {
    $(`tab-${t}`).hidden = t !== tab;
    const b = $(`t-${t}`);
    b.setAttribute("aria-selected", String(t === tab));
    b.tabIndex = t === tab ? 0 : -1;
  }
  if (push && location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  void loadTab(tab);
}

async function refreshOverview() {
  const ov = await api("overview");
  S.overview = ov;
  const newRun = ov.funnel ? ov.funnel.runId : null;
  const changed = newRun !== S.publishedRunId;
  S.publishedRunId = newRun;
  renderOverview(ov);
  if (changed && ov.funnel && !["overview", "signals"].includes(S.tab)) void loadRecs().catch(() => undefined);
  if (ov.funnel) {
    $("count-screen").textContent = fmtInt(ov.funnel.screened);
    $("count-market").textContent = fmtInt(ov.funnel.collected);
  }
  return changed;
}

/** While a run is active, poll the cheap overview every 5s so the progress bar moves. */
let fastTimer = null;
function watchRun() {
  const running = S.overview && S.overview.latestRun && S.overview.latestRun.status === "running";
  if (running && !fastTimer) {
    fastTimer = setInterval(async () => {
      try {
        const was = S.publishedRunId;
        await refreshOverview();
        const still = S.overview.latestRun && S.overview.latestRun.status === "running";
        if (!still || S.publishedRunId !== was) { clearInterval(fastTimer); fastTimer = null; await loadTab(S.tab); }
      } catch { /* the 30s tick reports API errors */ }
    }, 5_000);
  }
}

async function tick() {
  try {
    const changed = await refreshOverview();
    if (changed || ["overview", "collection"].includes(S.tab)) await loadTab(S.tab);
    else if (S.tab === "signals") await loadSignals().catch(() => undefined);
    if (S.tab !== "access") void api("telegram/access").then((a) => { $("count-access").textContent = fmtInt(a.pending.length + (a.missingCount || 0)); }).catch(() => undefined);
  } catch (e) {
    console.error(e);
    put($("run-strip"), el("div", { class: "error" }, `Could not reach the API: ${e.message}`));
  }
}

function initTheme() {
  const btn = $("theme");
  const apply = (m) => {
    if (m === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = m;
    btn.textContent = `Theme: ${m}`;
  };
  let mode = "auto";
  try { mode = localStorage.getItem("theme") || "auto"; } catch { /* storage unavailable */ }
  apply(mode);
  btn.addEventListener("click", () => {
    mode = mode === "auto" ? "light" : mode === "light" ? "dark" : "auto";
    try { localStorage.setItem("theme", mode); } catch { /* storage unavailable */ }
    apply(mode);
  });
}

function wire() {
  for (const t of TABS) $(`t-${t}`).addEventListener("click", () => selectTab(t));
  $("tab-overview").addEventListener("click", (e) => {
    const target = e.target.closest("[data-goto]");
    if (target) selectTab(target.getAttribute("data-goto"));
  });
  document.querySelector(".tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = TABS.indexOf(S.tab) + (e.key === "ArrowRight" ? 1 : -1);
    const next = TABS[(i + TABS.length) % TABS.length];
    selectTab(next);
    $(`t-${next}`).focus();
  });
  $("f-status").addEventListener("change", () => void loadSignals().catch(showError("signals")));
  $("f-type").addEventListener("change", () => void loadSignals().catch(showError("signals")));
  let screenTimer = null;
  $("screen-search").addEventListener("input", () => { clearTimeout(screenTimer); screenTimer = setTimeout(() => { S.screen.page = 0; void renderScreen(); }, 150); });
  for (const id of ["screen-ready", "screen-pattern", "screen-rows"]) $(id).addEventListener("change", () => { S.screen.page = 0; void renderScreen(); });
  let marketTimer = null;
  $("market-search").addEventListener("input", () => { clearTimeout(marketTimer); marketTimer = setTimeout(() => { S.market.page = 0; void loadMarket().catch(showError("market-table")); }, 250); });
  for (const id of ["market-scope", "market-rows"]) $(id).addEventListener("change", () => { S.market.page = 0; void loadMarket().catch(showError("market-table")); });
  $("missed-retry-all").addEventListener("click", () => void deliveryAction("telegram/retry", {}, "Retried all missed"));
  $("send-latest-all").addEventListener("click", () => void deliveryAction("telegram/send", {}, "Sent latest report to everyone"));
  $("access-add").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = $("access-add-id").value.trim();
    if (id) void changeAccess("approve", id, `Approved ${id}.`).then(() => { $("access-add-id").value = ""; });
  });
  $("drawer-close").addEventListener("click", closeDrawer);
  $("drawer-backdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("drawer").hidden) closeDrawer(); });
  window.addEventListener("hashchange", () => {
    if (!$("drawer").hidden) closeDrawer();
    selectTab(location.hash.slice(1), false);
  });
  window.addEventListener("scroll", hideTooltip, { passive: true });
}

async function start() {
  initTheme();
  wire();
  try {
    S.cfg = await api("config");
    renderHeader();
    await refreshOverview();
    void api("telegram/access").then((a) => { $("count-access").textContent = fmtInt(a.pending.length + (a.missingCount || 0)); }).catch(() => undefined);
  } catch (e) {
    $("banner").hidden = false;
    $("banner").textContent = `Failed to load the dashboard: ${e.message}`;
  }
  selectTab(location.hash.slice(1) || "overview", false);
  setInterval(() => { void tick().then(watchRun); }, 30_000);
  watchRun();
}

void start();
