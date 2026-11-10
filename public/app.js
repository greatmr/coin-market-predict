// Coins Predicts dashboard (Two-Tier VMC strategy). Reads the NestJS JSON API only. All source
// text (coin names, symbols, notes) is rendered with textContent, never innerHTML, because it comes
// from external sources or reviewers. The CSP forbids inline style attributes, so dynamic sizes are
// set through the CSSOM (element.style.x), and charts are hand-drawn SVG (no third-party scripts).
'use strict';

/* ============================== Basics ============================== */

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let uidCounter = 0;
const uid = (p) => `${p}${++uidCounter}`;

function attach(e, attrs, children, isSvg) {
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') isSvg ? e.setAttribute('class', v) : (e.className = v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}
const el = (tag, attrs, ...children) => attach(document.createElement(tag), attrs, children, false);
const svg = (tag, attrs, ...children) =>
  attach(document.createElementNS(SVGNS, tag), attrs, children, true);

function put(node, ...children) {
  node.replaceChildren(
    ...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  );
}

/** Every /api response is an envelope: `{ data, errors: null }` or `{ data: null, errors: [{ message, code }] }`. */
function errorText(body) {
  const errors = body && Array.isArray(body.errors) ? body.errors : [];
  return errors
    .map((e) => e && e.message)
    .filter(Boolean)
    .join(', ');
}
async function readEnvelope(r) {
  const text = await r.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
const errorCode = (body) =>
  body && Array.isArray(body.errors) && body.errors[0] ? body.errors[0].code : null;

/** One request; a lost session sends the person back to sign-in, a pending password change to that form. */
async function request(method, path, body) {
  const init = { method, headers: { accept: 'application/json' } };
  if (method !== 'GET') {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  const r = await fetch(`/api/${path}`, init);
  const res = await readEnvelope(r);
  if (!r.ok) {
    const code = errorCode(res);
    const detail = errorText(res);
    const err = new Error(detail || `HTTP ${r.status}`);
    err.status = r.status;
    err.code = code;
    err.detail = detail;
    err.errors = res && Array.isArray(res.errors) ? res.errors : [];
    if (!path.startsWith('auth/')) {
      if (code === 'AUTH_REQUIRED') showAuth('login', 'Your session ended. Sign in again.');
      else if (code === 'PASSWORD_CHANGE_REQUIRED') showAuth('change');
    }
    throw err;
  }
  return res ? res.data : null;
}
const api = (path) => request('GET', path);
const apiPost = (path, body) => request('POST', path, body);
const apiPatch = (path, body) => request('PATCH', path, body);
const apiPut = (path, body) => request('PUT', path, body);
const apiDelete = (path) => request('DELETE', path, {});

const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/* ============================== State & formatting ============================== */

const S = {
  cfg: null,
  overview: null,
  lbank: null,
  tab: 'overview',
  sheets: {
    queue: { page: 0, search: '', view: 'table' },
    eligible: { page: 0, search: '', view: 'table' },
    needs_review: { page: 0, search: '', view: 'table' },
    excluded: { page: 0, search: '', view: 'table' },
  },
  drawer: { cmcId: null, batchId: null, returnFocus: null },
  forward: { view: 'active', stars: '', search: '', page: 0 },
  priceRange: 'daily',
  detailTab: 'review',
  me: null,
  started: false,
  lastBatch: null,
};
const tz = () => (S.cfg && S.cfg.timezone) || 'UTC';
/** Whether the signed-in user's role has a permission (the server checks it again on every call). */
const can = (perm) => !!(S.me && S.me.permissions.includes(perm));
const live = () => !!(S.cfg && S.cfg.isLiveData);

function nf(o) {
  return new Intl.NumberFormat('en-US', o);
}
const fmtInt = (n) => (isNum(num(n)) ? nf({ maximumFractionDigits: 0 }).format(num(n)) : '—');
function fmtUsd(n) {
  n = num(n);
  if (!isNum(n)) return '—';
  const big = Math.abs(n) >= 1e6;
  return nf({
    style: 'currency',
    currency: 'USD',
    notation: big ? 'compact' : 'standard',
    maximumFractionDigits: big ? 2 : 0,
  }).format(n);
}
function fmtPrice(n) {
  n = num(n);
  if (!isNum(n)) return '—';
  if (n >= 1000)
    return nf({ style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
  if (n >= 1) return nf({ style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(n);
  return `$${n.toPrecision(4)}`;
}
/** VMC as percent (PDF p.13: 0.20 = 20%), optionally with the raw ratio. */
function fmtVmc(x, withRatio = false) {
  x = num(x);
  if (!isNum(x)) return '—';
  const p = x * 100;
  const pct = `${p.toFixed(p >= 10 ? 1 : p >= 1 ? 2 : 3)}%`;
  return withRatio ? `${pct} (${x.toPrecision(4)})` : pct;
}
function fmtMult(x) {
  x = num(x);
  return isNum(x) ? `${x >= 100 ? x.toFixed(0) : x.toFixed(x >= 10 ? 1 : 2)}×` : '—';
}
function fmtTime(iso, opts = {}) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: tz(),
    year: opts.year ? 'numeric' : undefined,
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
const fmtClock = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString('en-GB', {
        timeZone: tz(),
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '—';
const fmtDay = (ymd) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  });
function fmtAgo(iso) {
  if (!iso) return '—';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}
/** "1 h 05 min", "4 min 12 s", "38 s". */
function fmtSpan(seconds) {
  const t = Math.max(0, Math.round(seconds));
  const h = Math.floor(t / 3600),
    m = Math.floor((t % 3600) / 60),
    sec = t % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(sec).padStart(2, '0')} s`;
  return `${sec} s`;
}
const fmtMs = (ms) => (isNum(ms) ? (ms < 1000 ? `${Math.round(ms)} ms` : fmtSpan(ms / 1000)) : '');
const utc = (iso) => (iso ? String(iso).replace('.000Z', 'Z') : '—');
const shortId = (id) => String(id || '').slice(0, 8);

const ELIG = {
  ELIGIBLE: ['good', 'Eligible'],
  NEEDS_REVIEW: ['warning', 'Needs review'],
  EXCLUDED: ['', 'Excluded'],
};
const LBANK = {
  VERIFIED: ['good', 'LBank verified'],
  PAIR_LISTED_UNVERIFIED: ['warning', 'LBank listed, unverified'],
  NOT_LISTED: ['', 'Not on LBank'],
  NOT_TRADABLE: ['critical', 'LBank not tradable'],
  UNKNOWN: ['serious', 'LBank unknown'],
};
const CURRENT = {
  OK: ['good', 'Quote OK'],
  STALE: ['serious', 'Stale quote'],
  TIMESTAMP_UNVERIFIED: ['serious', 'Time unverified'],
  MISMATCHED: ['critical', 'Mismatched'],
  MISSING: ['critical', 'No quote'],
  INVALID: ['critical', 'Invalid quote'],
};
const QUEUE = {
  PUBLISHED: ['good', 'Published'],
  EMPTY: ['', 'Empty'],
  WITHHELD_INCOMPLETE_BATCH: ['critical', 'Withheld: incomplete batch'],
  WITHHELD_LBANK_UNAVAILABLE: ['critical', 'Withheld: LBank list unavailable'],
};
const BATCH = {
  COMPLETE: ['good', 'Complete'],
  INCOMPLETE: ['serious', 'Incomplete'],
  FAILED: ['critical', 'Failed'],
};
const RUN = {
  running: ['accent', 'Running'],
  succeeded: ['good', 'Succeeded'],
  partial: ['warning', 'Partial'],
  failed: ['critical', 'Failed'],
  skipped: ['', 'Skipped'],
  missed: ['', 'Missed'],
  interrupted: ['critical', 'Interrupted'],
};
const STAGES = [
  ['discover', 'Discover'],
  ['collect', 'Collect'],
  ['lbank', 'LBank'],
  ['daily', 'Daily rows'],
  ['scan', 'Scan'],
  ['venues', 'Venues'],
  ['export', 'Export'],
  ['notify', 'Notify'],
  ['forward', 'Forward test'],
];

const statusLabel = (dot, text, title) =>
  el(
    'span',
    { class: 'status', title },
    el('span', { class: `dot ${dot || ''}`, 'aria-hidden': 'true' }),
    text,
  );
const lab = (map, key) => statusLabel((map[key] || [])[0], (map[key] || [])[1] || key || '—');
const chip = (text, opts = {}) =>
  el(
    'span',
    {
      class: `chip${opts.strong ? ' strong' : ''}${opts.tone ? ` ${opts.tone}` : ''}`,
      title: opts.title,
    },
    opts.dot ? el('span', { class: `dot ${opts.dot}`, 'aria-hidden': 'true' }) : null,
    text,
  );

const REASON_TEXT = {
  RANK_OUT_OF_RANGE: 'rank outside 101–1200',
  RANK_MISSING: 'no CMC rank',
  RANK_AMBIGUOUS: 'duplicate rank in batch',
  MARKET_CAP_BELOW_MIN: 'market cap below $15M',
  MARKET_CAP_MISSING: 'market cap missing',
  LISTING_AGE_BELOW_60D: 'listed under 60 days',
  DATE_ADDED_MISSING: 'no listing date',
  DATE_ADDED_AFTER_SCAN: 'listing date after scan',
  STABLECOIN: 'stablecoin',
  TOKENIZED_ASSET: 'tokenized stock or asset',
  CLASS_AMBIGUOUS: 'class ambiguous',
  NO_LBANK_SPOT_PAIR: 'no LBank Spot pair',
  LBANK_NOT_TRADABLE: 'LBank pair not tradable',
  LBANK_PAIR_UNVERIFIED: 'LBank pair unverified',
  LBANK_STATUS_UNKNOWN: 'LBank status unknown',
  DAILY_ROW_MISSING: 'a completed day is missing',
  DAILY_ROW_INVALID: 'a completed day is invalid',
  ZERO_BASELINE: 'zero baseline',
  NOT_EVALUATED_EXCLUDED: 'not evaluated (excluded)',
  CURRENT_MISSING: 'no current quote',
  CURRENT_STALE: 'stale quote',
  TIMESTAMP_UNVERIFIED: 'no provider time',
  TIMESTAMP_IN_FUTURE: 'provider time in the future',
  MISMATCHED_OBSERVATION: 'volume and cap mismatch',
  CURRENT_CAP_INVALID: 'current cap invalid',
  CURRENT_VOLUME_INVALID: 'current volume invalid',
};
function reasonText(code) {
  if (!code) return '';
  const [k, detail] = String(code).split(':');
  const base = REASON_TEXT[k] || k.replace(/_/g, ' ').toLowerCase();
  return `${base}${detail ? ` (${detail.replace(/_/g, ' ').toLowerCase()})` : ''}`;
}

/* Multiples are drawn on a log scale up to 6×, so the 1.5× line sits at a fixed spot. */
const MULT_MAX = 6;
const multPos = (m) => Math.max(0, Math.min(1, Math.log1p(Math.max(0, m)) / Math.log1p(MULT_MAX)));
const passLine = () => num(S.cfg && S.cfg.strategy.rules.passMultiple) || 1.5;

function multBar(m, status) {
  const bar = el(
    'span',
    { class: `mbar ${status === 'YES' ? 'yes' : 'no'}`, 'aria-hidden': 'true' },
    el('i'),
    el('s'),
  );
  bar.firstChild.style.width = `${(multPos(m) * 100).toFixed(1)}%`;
  bar.lastChild.style.left = `${(multPos(passLine()) * 100).toFixed(1)}%`;
  return bar;
}

/** YES / NO / N/A with the multiple as a bar against the 1.5× line, and the N/A reason as a tooltip. */
function passCell(status, multiple, reason) {
  if (status === 'N/A' || status === null || status === undefined)
    return el('span', { class: 'pass na', title: reasonText(reason) || 'not available' }, 'N/A');
  const m = num(multiple);
  return el(
    'span',
    {
      class: `pass ${status === 'YES' ? 'yes' : 'no'}`,
      title: `${status}: current ÷ mean = ${isNum(m) ? m.toFixed(4) : '?'}`,
    },
    el('b', null, fmtMult(m)),
    multBar(m, status),
  );
}
/** Weighted points (weighted_star_v1): a lower bound when a window is N/A; strength in the tooltip. */
function pointsCell(points, complete, strength) {
  if (points === null || points === undefined) return el('span', { class: 'muted' }, '—');
  const s = num(strength);
  return el(
    'span',
    {
      class: complete ? 'pts' : 'pts lower',
      title: `${complete ? 'Weighted points' : 'Confirmed lower bound: a window is N/A'} (3d 60 · 7d 25 · 30d 15 per YES)${isNum(s) ? `; strength ${s.toFixed(2)}` : ''}`,
    },
    `${complete ? '' : '≥ '}${points}`,
  );
}

const stars = (n) =>
  el(
    'span',
    { class: `stars s${n}`, title: `${n} of 3 windows met`, 'aria-label': `${n} of 3 stars` },
    '★'.repeat(n),
    el('span', { class: 'off', 'aria-hidden': 'true' }, '★'.repeat(3 - n)),
  );

function logo(cmcId, size = 22) {
  if (!(live() && Number.isInteger(cmcId) && cmcId < 900000))
    return el('span', { class: 'logo ph', 'aria-hidden': 'true' });
  return el('img', {
    class: 'logo',
    src: `https://s2.coinmarketcap.com/static/img/coins/64x64/${cmcId}.png`,
    width: size,
    height: size,
    alt: '',
    loading: 'lazy',
    onerror: (e) => e.target.replaceWith(el('span', { class: 'logo ph', 'aria-hidden': 'true' })),
  });
}
const coinCell = (r) =>
  el(
    'div',
    { class: 'coin' },
    logo(r.cmcId),
    el(
      'div',
      { class: 'coin-text' },
      el('b', null, r.symbol),
      el('span', { title: r.name }, r.name),
    ),
  );

function table(cols, rows, opts = {}) {
  if (!rows.length) return el('div', { class: 'empty' }, opts.empty || 'Nothing to show.');
  const head = el(
    'thead',
    null,
    el(
      'tr',
      null,
      cols.map((c) =>
        el('th', { class: c.num ? 'num' : null, title: c.title, scope: 'col' }, c.label),
      ),
    ),
  );
  const body = el(
    'tbody',
    null,
    rows.map((r) => {
      const tr = el(
        'tr',
        { class: opts.onRow ? 'clickable' : null, tabindex: opts.onRow ? 0 : null },
        cols.map((c) => el('td', { class: c.num ? 'num' : null }, c.render(r))),
      );
      if (opts.onRow) {
        tr.addEventListener('click', (e) => {
          if (!e.target.closest('button, a, input, select, textarea')) opts.onRow(r, tr);
        });
        tr.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') opts.onRow(r, tr);
        });
      }
      return tr;
    }),
  );
  return el('table', null, head, body);
}
const kv = (pairs) =>
  el(
    'dl',
    { class: 'kv' },
    pairs.filter(Boolean).map(([k, v]) => el('div', null, el('dt', null, k), el('dd', null, v))),
  );

function pager(container, { page, pageSize, total, onPage, unit = 'coins' }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  put(
    container,
    el('span', null, `${fmtInt(total)} ${unit}, page ${page + 1} of ${pages}`),
    el(
      'button',
      { type: 'button', class: 'btn', disabled: page === 0, onclick: () => onPage(page - 1) },
      'Previous',
    ),
    el(
      'button',
      {
        type: 'button',
        class: 'btn',
        disabled: page + 1 >= pages,
        onclick: () => onPage(page + 1),
      },
      'Next',
    ),
  );
}

/* ============================== Feedback: toasts & tooltip ============================== */

function toast(text, kind = 'ok') {
  const t = el(
    'div',
    { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    el('span', null, text),
  );
  $('toasts').append(t);
  setTimeout(
    () => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 300);
    },
    kind === 'error' ? 8000 : 4500,
  );
}

function showTip(rows, x, y) {
  const t = $('tip');
  put(t, rows);
  t.hidden = false;
  const r = t.getBoundingClientRect();
  let left = x + 14,
    top = y + 14;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${Math.max(8, top)}px`;
}
const hideTip = () => {
  $('tip').hidden = true;
};
const tipHead = (text) => el('div', { class: 'tip-head' }, text);
const tipRow = (k, v, tone) =>
  el(
    'div',
    { class: 'tip-row' },
    el('span', { class: tone ? `key ${tone}` : 'key' }, k),
    el('b', null, v),
  );

/* ============================== Charts ============================== */

/** Draws `draw(width)` into `box` now and whenever its width changes; returns a redraw function. */
function mount(box, draw) {
  let w = 0;
  const render = () => {
    if (w) box.replaceChildren(draw(w));
  };
  const ro = new ResizeObserver(() => {
    if (!box.isConnected) {
      ro.disconnect();
      return;
    }
    const nw = Math.floor(box.clientWidth);
    if (nw && nw !== w) {
      w = nw;
      render();
    }
  });
  ro.observe(box);
  return render;
}

function niceTicks(lo, hi, count = 4) {
  const span = hi - lo || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= step0) || step0;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(v);
  return out;
}

/** Interactive time series: line + wash, optional faint volume bars underneath, crosshair, keyboard. */
function seriesChart(o) {
  const box = el('div', { class: 'chart-box' });
  const pts = o.points.filter((p) => isNum(p.v));
  if (pts.length < 2) {
    box.append(
      el('div', { class: 'empty chart-empty' }, o.empty || 'Not enough data for a chart yet.'),
    );
    return box;
  }
  mount(box, (W) => drawSeries(W, o, pts));
  return box;
}

function drawSeries(W, o, pts) {
  const H = o.height || 220;
  const m = { l: 6, r: 62, t: 14, b: 26 };
  const bars = (o.bars || []).filter((b) => isNum(b.v));
  const plotB = H - m.b;
  const lineB = bars.length ? m.t + (plotB - m.t) * 0.72 : plotB;
  const t0 = pts[0].t,
    t1 = pts[pts.length - 1].t;
  const X = (t) => m.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - m.l - m.r);
  let lo = Math.min(...pts.map((p) => p.v)),
    hi = Math.max(...pts.map((p) => p.v));
  if (lo === hi) {
    lo = lo * 0.98;
    hi = hi * 1.02 || 1;
  }
  const pad = (hi - lo) * 0.1;
  lo -= pad;
  hi += pad;
  const Y = (v) => lineB - ((v - lo) / (hi - lo)) * (lineB - m.t);
  const root = svg('svg', {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    class: `chart tone-${o.tone || 'base'}`,
    role: 'img',
    tabindex: 0,
    'aria-label': `${o.label}: ${pts.length} values, latest ${o.fmt(pts[pts.length - 1].v)}. Use the arrow keys to read values.`,
  });
  const gid = uid('wash');
  root.append(
    svg(
      'defs',
      null,
      svg(
        'linearGradient',
        { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 },
        svg('stop', { offset: '0%', class: 'wash-top' }),
        svg('stop', { offset: '100%', class: 'wash-bottom' }),
      ),
    ),
  );
  for (const v of niceTicks(lo, hi, 3)) {
    if (Y(v) < m.t || Y(v) > lineB) continue;
    root.append(svg('line', { class: 'grid-line', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }));
    root.append(svg('text', { class: 'tick', x: W - m.r + 8, y: Y(v) + 4 }, o.fmt(v)));
  }
  const ticks = Math.max(2, Math.floor((W - m.l - m.r) / 110));
  for (let i = 0; i <= ticks; i++) {
    const t = t0 + ((t1 - t0) * i) / ticks;
    root.append(
      svg(
        'text',
        {
          class: 'tick',
          x: X(t),
          y: H - 7,
          'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle',
        },
        o.xfmt(t),
      ),
    );
  }
  if (bars.length) {
    const bmax = Math.max(...bars.map((b) => b.v)) || 1;
    const bw = Math.max(1.5, ((W - m.l - m.r) / Math.max(bars.length, 2)) * 0.62);
    const top = lineB + 10;
    for (const b of bars) {
      const h = Math.max(1, (b.v / bmax) * (plotB - top));
      root.append(
        svg('rect', {
          class: 'vol-bar',
          x: X(b.t) - bw / 2,
          y: plotB - h,
          width: bw,
          height: h,
          rx: Math.min(2, bw / 2),
        }),
      );
    }
  }
  let d = '';
  pts.forEach((p, i) => {
    d += `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`;
  });
  root.append(
    svg('path', {
      class: 'wash',
      fill: `url(#${gid})`,
      d: `${d}L${X(t1).toFixed(1)},${lineB}L${X(t0).toFixed(1)},${lineB}Z`,
    }),
  );
  root.append(svg('path', { class: 'series', d }));
  const last = pts[pts.length - 1];
  root.append(svg('circle', { class: 'end-dot', cx: X(last.t), cy: Y(last.v), r: 3.5 }));
  const cross = svg('line', { class: 'cross', y1: m.t, y2: plotB, visibility: 'hidden' });
  const dot = svg('circle', { class: 'cross-dot', r: 4.5, visibility: 'hidden' });
  root.append(cross, dot);
  const barAt = (t) => bars.find((b) => b.t === t);
  const show = (i, cx, cy) => {
    const p = pts[i];
    cross.setAttribute('x1', X(p.t));
    cross.setAttribute('x2', X(p.t));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', X(p.t));
    dot.setAttribute('cy', Y(p.v));
    dot.setAttribute('visibility', 'visible');
    const b = barAt(p.t);
    showTip(
      [
        tipHead(o.xfmtLong ? o.xfmtLong(p.t) : o.xfmt(p.t)),
        tipRow(o.label, o.fmt(p.v), 'tone-line'),
        b ? tipRow(o.barLabel || 'Volume', (o.barFmt || fmtUsd)(b.v), 'tone-bar') : null,
        p.note ? el('div', { class: 'tip-note' }, p.note) : null,
      ],
      cx,
      cy,
    );
  };
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    hideTip();
  };
  const nearest = (x) => {
    let best = 0,
      bd = Infinity;
    pts.forEach((p, i) => {
      const dd = Math.abs(X(p.t) - x);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    });
    return best;
  };
  const overlay = svg('rect', {
    class: 'hit',
    x: m.l,
    y: 0,
    width: Math.max(1, W - m.l - m.r),
    height: plotB,
  });
  overlay.addEventListener('pointermove', (e) => {
    const r = root.getBoundingClientRect();
    show(nearest(e.clientX - r.left), e.clientX, e.clientY);
  });
  overlay.addEventListener('pointerleave', hide);
  root.append(overlay);
  let idx = pts.length - 1;
  root.addEventListener('keydown', (e) => {
    const k = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }[e.key];
    if (k === undefined) return;
    e.preventDefault();
    idx = Math.max(0, Math.min(pts.length - 1, idx + k));
    const r = root.getBoundingClientRect();
    show(idx, r.left + X(pts[idx].t), r.top + Y(pts[idx].v));
  });
  root.addEventListener('blur', hide);
  return root;
}

/** Daily VMC bars for the completed UTC days, the selected window's mean and 1.5× line, and today's rolling-24h VMC. */
function drawVmc(W, days, cur, win) {
  const H = 250;
  const m = { l: 6, r: 96, t: 18, b: 30 };
  const n = days.length;
  const slots = n + 2;
  const step = (W - m.l - m.r) / slots;
  const bw = Math.max(2, step * 0.64);
  const pl = passLine();
  const mean = win ? num(win.mean) : null;
  const thr = isNum(mean) ? mean * pl : null;
  const vals = days.map((d) => num(d.vmc)).filter(isNum);
  if (isNum(cur)) vals.push(cur);
  if (isNum(thr)) vals.push(thr);
  const ymax = Math.max(...vals, 1e-9) * 1.12;
  const plotB = H - m.b;
  const Y = (v) => plotB - (v / ymax) * (plotB - m.t);
  const slotX = (i) => m.l + i * step + (step - bw) / 2;
  const inWin = new Set(win ? win.dates : []);
  const root = svg('svg', {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    class: 'chart vmc-chart',
    role: 'img',
    'aria-label': `Daily volume ÷ market cap for ${n} completed days and the current rolling-24h value ${fmtVmc(cur)}.`,
  });
  for (const v of niceTicks(0, ymax, 3)) {
    if (v === 0) continue;
    root.append(svg('line', { class: 'grid-line', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }));
  }
  root.append(svg('line', { class: 'axis-line', x1: m.l, x2: W - m.r, y1: plotB, y2: plotB }));
  const winIdx = days.map((d, i) => (inWin.has(d.dateUtc) ? i : -1)).filter((i) => i >= 0);
  if (winIdx.length) {
    const a = slotX(winIdx[0]) - (step - bw) / 2,
      b = slotX(winIdx[winIdx.length - 1]) + bw + (step - bw) / 2;
    root.append(
      svg('rect', {
        class: 'win-band',
        x: a,
        y: m.t - 8,
        width: b - a,
        height: plotB - m.t + 8,
        rx: 8,
      }),
    );
  }
  const hits = [];
  days.forEach((d, i) => {
    const v = num(d.vmc);
    const x = slotX(i);
    if (!isNum(v)) {
      root.append(
        svg('path', {
          class: 'missing-mark',
          d: `M${x + bw / 2 - 4},${plotB - 12}l8,8M${x + bw / 2 + 4},${plotB - 12}l-8,8`,
        }),
      );
    } else {
      const h = Math.max(1.5, plotB - Y(v));
      root.append(
        svg('rect', {
          class: `day-bar${inWin.has(d.dateUtc) ? ' in' : ''}`,
          x,
          y: plotB - h,
          width: bw,
          height: h,
          rx: Math.min(3, bw / 2),
        }),
      );
    }
    hits.push({
      x: x - (step - bw) / 2,
      w: step,
      rows: () => [
        tipHead(`${fmtDay(d.dateUtc)} (T−${d.daysAgo})`),
        tipRow(
          'VMC',
          isNum(v)
            ? fmtVmc(v)
            : d.valid === false
              ? `invalid: ${(d.invalidReasons || []).join(', ')}`
              : 'missing',
          'tone-base',
        ),
        tipRow('Volume', fmtUsd(d.volumeUsd)),
        tipRow('Market cap', fmtUsd(d.marketCapUsd)),
        tipRow('Close', fmtPrice(d.closeUsd)),
        inWin.has(d.dateUtc)
          ? el('div', { class: 'tip-note' }, `inside the ${win.days}-day window`)
          : null,
      ],
    });
  });
  const nowX = slotX(n + 1);
  if (isNum(cur)) {
    const hot = isNum(thr) && cur >= thr;
    const h = Math.max(1.5, plotB - Y(cur));
    root.append(
      svg('rect', {
        class: `now-bar${hot ? ' hot' : ''}`,
        x: nowX,
        y: plotB - h,
        width: bw,
        height: h,
        rx: Math.min(3, bw / 2),
      }),
    );
    root.append(
      svg(
        'text',
        {
          class: `now-label${hot ? ' hot' : ''}`,
          x: nowX + bw / 2,
          y: Math.max(m.t - 4, plotB - h - 6),
          'text-anchor': 'middle',
        },
        fmtVmc(cur),
      ),
    );
  }
  hits.push({
    x: nowX - (step - bw) / 2,
    w: step,
    rows: () => [
      tipHead('Now (rolling 24h)'),
      tipRow('Current VMC', fmtVmc(cur), 'tone-surge'),
      isNum(mean) ? tipRow(`${win.days}d mean`, fmtVmc(mean), 'tone-base') : null,
      isNum(mean) && isNum(cur) ? tipRow('Multiple', fmtMult(cur / mean)) : null,
    ],
  });
  if (isNum(mean) && winIdx.length) {
    const a = slotX(winIdx[0]);
    const b = nowX + bw;
    root.append(svg('line', { class: 'mean-line', x1: a, x2: b, y1: Y(mean), y2: Y(mean) }));
    root.append(svg('line', { class: 'thr-line', x1: a, x2: b, y1: Y(thr), y2: Y(thr) }));
    const ly1 = Y(mean),
      ly2 = Y(thr);
    const gap = Math.abs(ly1 - ly2) < 14 ? 7 : 0;
    root.append(
      svg(
        'text',
        { class: 'line-label base', x: W - m.r + 8, y: ly1 + 4 + gap },
        `${win.days}d mean ${fmtVmc(mean)}`,
      ),
    );
    root.append(
      svg(
        'text',
        { class: 'line-label surge', x: W - m.r + 8, y: ly2 + 4 - gap },
        `${pl}× ${fmtVmc(thr)}`,
      ),
    );
  }
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - m.l - m.r) / 64))));
  days.forEach((d, i) => {
    if ((n - 1 - i) % every) return;
    if (nowX + bw / 2 - (slotX(i) + bw / 2) < 40) return;
    root.append(
      svg(
        'text',
        { class: 'tick', x: slotX(i) + bw / 2, y: H - 9, 'text-anchor': 'middle' },
        fmtDay(d.dateUtc),
      ),
    );
  });
  root.append(
    svg(
      'text',
      { class: 'tick strong', x: nowX + bw / 2, y: H - 9, 'text-anchor': 'middle' },
      'Now',
    ),
  );
  for (const h of hits) {
    const r = svg('rect', { class: 'hit', x: h.x, y: 0, width: h.w, height: plotB });
    r.addEventListener('pointerenter', (e) => {
      r.classList.add('on');
      showTip(h.rows(), e.clientX, e.clientY);
    });
    r.addEventListener('pointermove', (e) => showTip(h.rows(), e.clientX, e.clientY));
    r.addEventListener('pointerleave', () => {
      r.classList.remove('on');
      hideTip();
    });
    root.append(r);
  }
  return root;
}

/** Donut with an interactive legend: hovering a slice or a legend row shows it in the centre. */
function donut(segs, opts = {}) {
  const total = segs.reduce((a, s) => a + (s.value || 0), 0);
  const size = opts.size || 156,
    sw = 16,
    r = (size - sw) / 2,
    C = 2 * Math.PI * r;
  const root = svg('svg', {
    width: size,
    height: size,
    viewBox: `0 0 ${size} ${size}`,
    class: 'donut',
    role: 'img',
    'aria-label': segs.map((s) => `${s.label} ${s.value}`).join(', '),
  });
  root.append(
    svg('circle', { class: 'donut-track', cx: size / 2, cy: size / 2, r, 'stroke-width': sw }),
  );
  const centerV = svg(
    'text',
    { class: 'donut-value', x: size / 2, y: size / 2 + 2, 'text-anchor': 'middle' },
    fmtInt(total),
  );
  const centerL = svg(
    'text',
    { class: 'donut-label', x: size / 2, y: size / 2 + 20, 'text-anchor': 'middle' },
    opts.totalLabel || 'total',
  );
  const arcs = [];
  let acc = 0;
  for (const s of segs) {
    const len = total ? (s.value / total) * C : 0;
    const gapLen = len > 4 ? 2 : 0;
    const c = svg('circle', {
      class: `donut-seg ${s.tone}`,
      cx: size / 2,
      cy: size / 2,
      r,
      'stroke-width': sw,
      'stroke-dasharray': `${Math.max(0, len - gapLen)} ${C}`,
      'stroke-dashoffset': -acc,
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
    });
    acc += len;
    arcs.push(c);
    root.append(c);
  }
  root.append(centerV, centerL);
  const focus = (i) => {
    arcs.forEach((a, j) => a.classList.toggle('dim', i !== null && i !== j));
    legend.querySelectorAll('li').forEach((li, j) => li.classList.toggle('on', i === j));
    centerV.textContent = i === null ? fmtInt(total) : fmtInt(segs[i].value);
    centerL.textContent =
      i === null
        ? opts.totalLabel || 'total'
        : `${total ? Math.round((segs[i].value / total) * 100) : 0}%`;
  };
  const legend = el(
    'ul',
    { class: 'legend' },
    segs.map((s, i) =>
      el(
        'li',
        {
          tabindex: 0,
          onpointerenter: () => focus(i),
          onpointerleave: () => focus(null),
          onfocus: () => focus(i),
          onblur: () => focus(null),
          onclick: s.onClick || null,
          class: s.onClick ? 'clickable' : null,
        },
        el('span', { class: `swatch ${s.tone}`, 'aria-hidden': 'true' }),
        el('span', { class: 'legend-label' }, s.label),
        el('b', null, fmtInt(s.value)),
      ),
    ),
  );
  arcs.forEach((a, i) => {
    a.addEventListener('pointerenter', () => focus(i));
    a.addEventListener('pointerleave', () => focus(null));
  });
  return el('div', { class: 'donut-wrap' }, root, legend);
}

/** Horizontal bars (HTML) with the value at the end; optional click per row. */
function hbars(items, opts = {}) {
  if (!items.length) return el('div', { class: 'empty' }, opts.empty || 'Nothing to show.');
  const max = Math.max(...items.map((i) => i.value), 1);
  return el(
    'div',
    { class: 'hbars' },
    items.map((it) => {
      const fill = el('i', { class: it.tone || opts.tone || 'base' });
      fill.style.width = `${Math.max(1.5, (it.value / max) * 100)}%`;
      return el(
        'div',
        { class: 'hbar', title: it.title },
        el('span', { class: 'hbar-label' }, it.label),
        el('span', { class: 'hbar-track' }, fill),
        el('b', null, (opts.fmt || fmtInt)(it.value)),
      );
    }),
  );
}

/** One horizontal stacked bar per row: [{ label, segs: [{ value, tone, label }] }]. */
function stackRows(rows) {
  return el(
    'div',
    { class: 'stacks' },
    rows.map((row) => {
      const total = row.segs.reduce((a, s) => a + s.value, 0) || 1;
      return el(
        'div',
        { class: 'stack-row' },
        el('span', { class: 'stack-label' }, row.label),
        el(
          'span',
          { class: 'stack-bar' },
          row.segs.map((s) => {
            const seg = el('i', { class: s.tone, title: `${s.label}: ${fmtInt(s.value)}` });
            seg.style.width = `${(s.value / total) * 100}%`;
            return seg;
          }),
        ),
        el(
          'span',
          { class: 'stack-nums' },
          row.segs.map((s) => el('span', { class: s.tone }, fmtInt(s.value))),
        ),
      );
    }),
  );
}

/** The screen as a narrowing band: widths use a square-root scale so 8,000 and 26 both stay visible. */
function drawFunnel(W, stages) {
  if (W < 560) return drawFunnelStacked(W, stages);
  const H = 210;
  const m = { l: 4, r: 4, t: 54, b: 34 };
  const n = stages.length;
  const max = Math.max(...stages.map((s) => s.value), 1);
  const cy = m.t + (H - m.t - m.b) / 2;
  const hMax = H - m.t - m.b;
  const xs = stages.map((_, i) => m.l + (i * (W - m.l - m.r)) / (n - 1));
  const hs = stages.map((s) => Math.max(4, Math.sqrt(s.value / max) * hMax));
  const root = svg('svg', {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    class: 'funnel',
    role: 'img',
    'aria-label': stages.map((s) => `${s.label}: ${s.value}`).join(', '),
  });
  const gid = uid('fun');
  root.append(
    svg(
      'defs',
      null,
      svg(
        'linearGradient',
        { id: gid, x1: 0, y1: 0, x2: 1, y2: 0 },
        svg('stop', { offset: '0%', class: 'fun-a' }),
        svg('stop', { offset: '70%', class: 'fun-b' }),
        svg('stop', { offset: '100%', class: 'fun-c' }),
      ),
    ),
  );
  let top = `M${xs[0]},${cy - hs[0] / 2}`,
    bot = '';
  for (let i = 1; i < n; i++) {
    const mx = (xs[i - 1] + xs[i]) / 2;
    top += `C${mx},${cy - hs[i - 1] / 2} ${mx},${cy - hs[i] / 2} ${xs[i]},${cy - hs[i] / 2}`;
  }
  bot = `L${xs[n - 1]},${cy + hs[n - 1] / 2}`;
  for (let i = n - 1; i > 0; i--) {
    const mx = (xs[i - 1] + xs[i]) / 2;
    bot += `C${mx},${cy + hs[i] / 2} ${mx},${cy + hs[i - 1] / 2} ${xs[i - 1]},${cy + hs[i - 1] / 2}`;
  }
  const shape = svg('path', {
    class: `funnel-shape${reduceMotion ? '' : ' draw'}`,
    d: `${top}${bot}Z`,
    fill: `url(#${gid})`,
  });
  root.append(shape);
  stages.forEach((s, i) => {
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    root.append(
      svg('line', { class: 'funnel-guide', x1: xs[i], x2: xs[i], y1: m.t - 8, y2: H - m.b + 8 }),
    );
    root.append(
      svg(
        'text',
        {
          class: `funnel-value${i === n - 1 ? ' surge' : ''}`,
          x: xs[i],
          y: 30,
          'text-anchor': anchor,
        },
        fmtInt(s.value),
      ),
    );
    root.append(
      svg('text', { class: 'funnel-label', x: xs[i], y: 46, 'text-anchor': anchor }, s.label),
    );
    if (s.sub)
      root.append(
        svg('text', { class: 'funnel-sub', x: xs[i], y: H - 10, 'text-anchor': anchor }, s.sub),
      );
  });
  return root;
}

/** Narrow screens: the same stages as stacked bars, so labels never collide. */
function drawFunnelStacked(W, stages) {
  const rowH = 52;
  const H = stages.length * rowH;
  const max = Math.max(...stages.map((s) => s.value), 1);
  const root = svg('svg', {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    class: 'funnel',
    role: 'img',
    'aria-label': stages.map((s) => `${s.label}: ${s.value}`).join(', '),
  });
  const gid = uid('fun');
  root.append(
    svg(
      'defs',
      null,
      svg(
        'linearGradient',
        { id: gid, x1: 0, y1: 0, x2: 1, y2: 0 },
        svg('stop', { offset: '0%', class: 'fun-a' }),
        svg('stop', { offset: '100%', class: 'fun-b' }),
      ),
    ),
  );
  stages.forEach((s, i) => {
    const y = i * rowH;
    const last = i === stages.length - 1;
    root.append(
      svg(
        'text',
        { class: `funnel-value${last ? ' surge' : ''}`, x: 0, y: y + 22 },
        fmtInt(s.value),
      ),
    );
    root.append(
      svg('text', { class: 'funnel-label', x: W, y: y + 22, 'text-anchor': 'end' }, s.label),
    );
    root.append(
      svg('rect', {
        class: `funnel-shape${last ? ' surge-fill' : ''}${reduceMotion ? '' : ' draw'}`,
        x: 0,
        y: y + 30,
        width: Math.max(6, Math.sqrt(s.value / max) * W),
        height: 10,
        rx: 5,
        fill: `url(#${gid})`,
      }),
    );
  });
  return root;
}

/** Progress ring: returns { node, set(fraction) }. */
function ring(size, fraction, tone) {
  const sw = 10,
    r = (size - sw) / 2,
    C = 2 * Math.PI * r;
  const arc = svg('circle', {
    class: `ring-arc ${tone || ''}`,
    cx: size / 2,
    cy: size / 2,
    r,
    'stroke-width': sw,
    'stroke-dasharray': C,
    transform: `rotate(-90 ${size / 2} ${size / 2})`,
  });
  const set = (f) =>
    arc.setAttribute('stroke-dashoffset', String(C * (1 - Math.max(0, Math.min(1, f)))));
  set(fraction);
  const node = svg(
    'svg',
    {
      width: size,
      height: size,
      viewBox: `0 0 ${size} ${size}`,
      class: 'ring',
      'aria-hidden': 'true',
    },
    svg('circle', { class: 'ring-track', cx: size / 2, cy: size / 2, r, 'stroke-width': sw }),
    arc,
  );
  return { node, set, arc };
}

/** Current VMC against its own 30-day mean (log–log), with the "equal" and 1.5× lines. */
function drawScatter(W, rows, onPick) {
  const H = Math.min(520, Math.max(340, W * 0.55));
  const m = { l: 72, r: 20, t: 18, b: 44 };
  const base = (r) => num(r.vmc30dAvg) ?? num(r.vmc7dAvg) ?? num(r.vmc3dAvg);
  const pts = rows
    .map((r) => ({ r, x: base(r), y: num(r.currentVmc) }))
    .filter((p) => isNum(p.x) && isNum(p.y) && p.x > 0 && p.y > 0);
  const root = svg('svg', {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    class: 'chart scatter',
    role: 'img',
    'aria-label': `Scatter of ${pts.length} coins: current VMC against the 30-day mean.`,
  });
  if (!pts.length)
    return el(
      'div',
      { class: 'empty chart-empty' },
      'No coin on this page has both a current VMC and a daily mean.',
    );
  const pl = passLine();
  const all = pts.flatMap((p) => [p.x, p.y]);
  const lo = Math.log10(Math.min(...all)) - 0.15,
    hi = Math.log10(Math.max(...all)) + 0.15;
  const X = (v) => m.l + ((Math.log10(v) - lo) / (hi - lo)) * (W - m.l - m.r);
  const Y = (v) => H - m.b - ((Math.log10(v) - lo) / (hi - lo)) * (H - m.t - m.b);
  for (let e = Math.ceil(lo); e <= Math.floor(hi); e++) {
    const v = 10 ** e;
    root.append(svg('line', { class: 'grid-line', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }));
    root.append(svg('line', { class: 'grid-line', x1: X(v), x2: X(v), y1: m.t, y2: H - m.b }));
    root.append(
      svg('text', { class: 'tick', x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, fmtVmc(v)),
    );
    root.append(
      svg('text', { class: 'tick', x: X(v), y: H - m.b + 16, 'text-anchor': 'middle' }, fmtVmc(v)),
    );
  }
  const a = 10 ** lo,
    b = 10 ** hi;
  const clip = uid('clip');
  root.append(
    svg(
      'defs',
      null,
      svg(
        'clipPath',
        { id: clip },
        svg('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b }),
      ),
    ),
  );
  root.append(
    svg(
      'g',
      { 'clip-path': `url(#${clip})` },
      svg('line', { class: 'eq-line', x1: X(a), y1: Y(a), x2: X(b), y2: Y(b) }),
      svg('line', { class: 'thr-line', x1: X(a / pl), y1: Y(a), x2: X(b / pl), y2: Y(b) }),
    ),
  );
  root.append(
    svg(
      'text',
      { class: 'line-label surge', x: X(b / pl) - 6, y: m.t + 12, 'text-anchor': 'end' },
      `${pl}× its mean`,
    ),
  );
  root.append(
    svg(
      'text',
      { class: 'axis-title', x: (m.l + W - m.r) / 2, y: H - 6, 'text-anchor': 'middle' },
      '30-day mean VMC',
    ),
  );
  root.append(
    svg(
      'text',
      {
        class: 'axis-title',
        x: 14,
        y: (m.t + H - m.b) / 2,
        'text-anchor': 'middle',
        transform: `rotate(-90 14 ${(m.t + H - m.b) / 2})`,
      },
      'Current VMC',
    ),
  );
  const caps = pts.map((p) => num(p.r.capUsd) || 0);
  const cmax = Math.max(...caps, 1);
  pts.sort((p, q) => (num(q.r.capUsd) || 0) - (num(p.r.capUsd) || 0));
  for (const p of pts) {
    const rr = 3.5 + Math.sqrt((num(p.r.capUsd) || 0) / cmax) * 10;
    const c = svg('circle', {
      class: `pt s${p.r.stars || 0}${p.r.inQueue ? ' q' : ''}`,
      cx: X(p.x),
      cy: Y(p.y),
      r: rr,
    });
    const rows = () => [
      tipHead(`${p.r.symbol} · ${p.r.name}`),
      tipRow('Current VMC', fmtVmc(p.y), 'tone-surge'),
      tipRow('30d mean', fmtVmc(p.x), 'tone-base'),
      tipRow('Multiple', fmtMult(p.y / p.x)),
      tipRow('Market cap', fmtUsd(p.r.capUsd)),
      el('div', { class: 'tip-note' }, 'Click to open'),
    ];
    c.addEventListener('pointerenter', (e) => showTip(rows(), e.clientX, e.clientY));
    c.addEventListener('pointermove', (e) => showTip(rows(), e.clientX, e.clientY));
    c.addEventListener('pointerleave', hideTip);
    c.addEventListener('click', () => {
      hideTip();
      onPick(p.r);
    });
    root.append(c);
  }
  return root;
}

/* ============================== Header, banners, pulse ============================== */

const PAGES = {
  overview: [
    'Overview',
    'Hourly Tier 1 screen of every listed coin. Research only: nothing here is a buy signal and no order is placed.',
  ],
  queue: [
    'Review queue',
    'Eligible coins whose rolling-24h VMC is at least 1.5× one of their own 3, 7 or 30-day means, ranked by stars, then weighted points (3d 60 · 7d 25 · 30d 15). For human chart review.',
  ],
  eligible: [
    'Eligible',
    'Every coin that passes all hard filters, including 0-star coins and windows that failed.',
  ],
  needs_review: [
    'Needs review',
    'Missing or ambiguous inputs are never silently eligible. Open a coin to resolve its LBank mapping.',
  ],
  excluded: [
    'Excluded',
    'Coins with at least one failed hard filter. Their windows are not evaluated.',
  ],
  forward: [
    'Forward test',
    'The first priced 1, 2 and 3-star detection per coin, UTC day and star count, followed to the end of the UTC day containing detection + 168 h. The return is the highest later High against the detection price: not a trade, not realized profit.',
  ],
  batches: ['Runs & health', "Crawl batches, pipeline runs and the source's request budget."],
  exports: [
    'Exports',
    'CSV per sheet and an Excel workbook for each scanned batch, with SHA-256 checksums in the manifest.',
  ],
  access: ['Telegram', 'Who receives the hourly report, and reports that did not arrive.'],
  users: ['Users', 'Who can sign in to this dashboard, and what each role may see and do.'],
  settings: [
    'Settings',
    'How the screen runs: schedule, source limits, retention, Telegram. Saved here and applied without editing .env; credentials and the database connection stay in the server environment.',
  ],
  account: ['My account', 'Your username, your password, and what your role allows.'],
};

function renderHeader() {
  const c = S.cfg;
  put(
    $('badges'),
    el(
      'span',
      {
        class: `badge ${c.isLiveData ? 'live' : 'fixture'}`,
        title: `Telegram ${c.telegramMode}; scheduler ${c.schedulerEnabled ? 'on' : 'off'}`,
      },
      el('span', { class: 'pulse-dot', 'aria-hidden': 'true' }),
      c.isLiveData ? c.providerName : 'Synthetic fixture data',
    ),
    el('span', { class: 'badge quiet' }, c.strategy.rulesetVersion),
  );
  put(
    $('footer'),
    `${c.attribution ? `${c.attribution}. ` : ''}Times in ${tz()}, stored in UTC. Research screening only: the review queue is a list for human chart review, never a buy signal, and no order is ever placed.`,
  );
}

function renderBanners(ov) {
  const msgs = [...(ov.banners || [])];
  if (!live())
    msgs.unshift(
      'Synthetic fixture market: every coin, price and volume here is invented for testing.',
    );
  const b = $('banner');
  b.hidden = !msgs.length;
  put(
    b,
    msgs.map((msg) => el('div', null, msg)),
    crawlRetryRow(ov),
  );
}

/** "Retry crawl now" under the banner when the newest crawl failed and no run is in progress. */
function crawlRetryRow(ov) {
  const crawlFailed =
    (ov.latestBatch && ov.latestBatch.status === 'FAILED') ||
    (ov.latestRun && ['failed', 'interrupted'].includes(ov.latestRun.status));
  if (!crawlFailed || !can('scan:operate') || (ov.latestRun && ov.latestRun.status === 'running'))
    return null;
  const h = ov.sourceHealth;
  const note = !h
    ? null
    : h.state === 'open'
      ? `The source is paused after ${fmtInt(h.consecutiveFailures)} failed requests${h.reopensAt ? ` until ${fmtClock(h.reopensAt)}` : ''}. Retrying resets that timer.`
      : h.state === 'suspended'
        ? `The source is suspended (${h.suspendedReason || 'access denied'}). Resolve the cause, then run npm run cli -- source:reset.`
        : null;
  return el(
    'div',
    { class: 'row-actions banner-actions' },
    el(
      'button',
      {
        type: 'button',
        class: 'btn small primary',
        disabled: h && h.state === 'suspended',
        title: "Reset the source's failure timer and crawl the current hour again",
        onclick: retryCrawl,
      },
      'Retry crawl now',
    ),
    note ? el('span', { class: 'muted small' }, note) : null,
  );
}

async function retryCrawl(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    const r = await apiPost('pipeline/retry', {});
    if (r.ok)
      toast(
        `Crawl restarted for the ${fmtClock(r.slot)} slot${r.circuitReset ? '; source timer reset' : ''}.`,
      );
    else toast(`Crawl not restarted: ${r.reason}`, 'warning');
    await refresh(true);
    watchRun();
  } catch (err) {
    toast(`Retry failed: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Retry crawl now';
  }
}

function countdownText(iso) {
  const left = (new Date(iso).getTime() - Date.now()) / 1000;
  if (left <= 0) return 'starting…';
  const mm = Math.floor(left / 60),
    ss = Math.floor(left % 60);
  return mm >= 60 ? fmtSpan(left) : `${mm}:${String(ss).padStart(2, '0')}`;
}

let pulseRing = null;
let countdownFired = null;
function tickCountdowns() {
  for (const node of document.querySelectorAll('[data-countdown]')) {
    const iso = node.getAttribute('data-countdown');
    node.textContent = countdownText(iso);
    if (Date.now() - new Date(iso).getTime() > 5_000 && countdownFired !== iso) {
      countdownFired = iso;
      void refresh()
        .then(watchRun)
        .catch(() => undefined);
    }
  }
  if (pulseRing && pulseRing.next) pulseRing.set(hourFraction(pulseRing.next));
}
/** Share of the interval to the next run that has passed (for the countdown ring). */
function hourFraction(nextIso) {
  const interval = ((S.cfg && S.cfg.strategy.crawlIntervalMinutes) || 60) * 60_000;
  const left = new Date(nextIso).getTime() - Date.now();
  return 1 - Math.max(0, Math.min(1, left / interval));
}

function renderPulse(ov) {
  const run = ov.latestRun,
    sch = ov.schedule || {};
  const box = $('pulse');
  const running = run && run.status === 'running';
  const p = running ? run.progress : null;
  let center, r;
  if (p) {
    r = ring(148, p.percent / 100, 'violet');
    pulseRing = null;
    center = el(
      'div',
      { class: 'ring-center' },
      el('b', null, `${p.percent}%`),
      el('span', null, run.currentStageLabel || run.currentStage || 'starting'),
    );
  } else if (sch.enabled && sch.nextRunAt) {
    r = ring(148, hourFraction(sch.nextRunAt), 'base');
    pulseRing = { set: r.set, next: sch.nextRunAt };
    center = el(
      'div',
      { class: 'ring-center' },
      el('b', { 'data-countdown': sch.nextRunAt }, countdownText(sch.nextRunAt)),
      el('span', null, `next run ${fmtClock(sch.nextRunAt)}`),
    );
  } else {
    r = ring(148, 0, '');
    pulseRing = null;
    center = el(
      'div',
      { class: 'ring-center' },
      el('b', null, 'Off'),
      el('span', null, 'automatic runs'),
    );
  }
  const ringBox = el('div', { class: 'ring-box' }, r.node, center);

  if (!run) {
    put(
      box,
      ringBox,
      el(
        'div',
        { class: 'pulse-body' },
        el('h2', null, 'Waiting for the first run'),
        el(
          'p',
          { class: 'muted' },
          S.cfg.schedulerEnabled
            ? 'The scheduler starts one at the next slot.'
            : 'Start one with npm run cli -- run-once.',
        ),
      ),
    );
    return;
  }
  const done = new Set(
    (run.stages || []).filter((s) => s.status === 'succeeded').map((s) => s.stage),
  );
  const failed = new Set(
    (run.stages || []).filter((s) => s.status === 'failed').map((s) => s.stage),
  );
  const metrics = run.metrics || {};
  const item = p && p.current;
  const elapsed = run.startedAt ? (Date.now() - new Date(run.startedAt).getTime()) / 1000 : null;
  const headline = running
    ? `${run.currentStageLabel || run.currentStage || 'Starting'}`
    : run.status === 'succeeded'
      ? 'Last run finished cleanly'
      : run.status === 'partial'
        ? 'Last run finished with gaps'
        : `Last run ${(RUN[run.status] || [0, run.status])[1].toLowerCase()}`;
  put(
    box,
    ringBox,
    el(
      'div',
      { class: 'pulse-body' },
      el(
        'div',
        { class: 'pulse-status' },
        lab(RUN, run.status),
        el('span', { class: 'muted' }, `slot ${fmtTime(run.slotTime)}`),
      ),
      el('h2', null, headline),
      el(
        'p',
        { class: 'muted small' },
        running
          ? `Step ${Math.min(p ? p.stagesDone + 1 : 1, p ? p.stagesTotal : 8)} of ${p ? p.stagesTotal : 8}${elapsed !== null ? `, ${fmtSpan(elapsed)} so far` : ''}`
          : `Finished ${fmtAgo(run.finishedAt)}${run.startedAt && run.finishedAt ? ` after ${fmtSpan((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000)}` : ''}`,
      ),
      item
        ? el(
            'div',
            { class: 'item-progress' },
            el(
              'div',
              { class: 'small' },
              `${fmtInt(item.done)} of ${fmtInt(item.total)} ${item.unit}${item.etaSeconds !== null && item.etaSeconds !== undefined ? `, about ${fmtSpan(item.etaSeconds)} left` : ''}`,
            ),
            el('progress', {
              class: 'bar',
              max: item.total,
              value: item.done,
              'aria-label': `${run.currentStage}: ${item.done} of ${item.total} ${item.unit}`,
            }),
          )
        : null,
      el(
        'ol',
        { class: 'steps', 'aria-label': 'Pipeline stages' },
        STAGES.map(([s, label]) =>
          el(
            'li',
            {
              class: `${done.has(s) ? 'done' : ''}${failed.has(s) ? ' failed' : ''}${run.currentStage === s ? ' active' : ''}`,
              title: metrics[`${s}Ms`] ? `${label}: ${fmtMs(metrics[`${s}Ms`])}` : label,
            },
            el('span', { class: 'step-dot', 'aria-hidden': 'true' }),
            el('span', { class: 'step-name' }, label),
          ),
        ),
      ),
      (metrics.degraded || []).length
        ? el(
            'ul',
            { class: 'notes small' },
            metrics.degraded.map((d) => el('li', null, d)),
          )
        : null,
      run.error ? el('div', { class: 'error small' }, run.error) : null,
      can('scan:operate')
        ? el(
            'div',
            { class: 'row-actions' },
            el(
              'button',
              {
                type: 'button',
                class: 'btn',
                title:
                  'Recompute the latest stored batch from saved data (no crawling) and export it again',
                onclick: rescan,
              },
              'Reprocess latest batch',
            ),
          )
        : null,
    ),
  );
}

async function rescan(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Reprocessing…';
  try {
    const r = await apiPost('scan/rescan', {});
    if (r.ok)
      toast(`Reprocessed. The queue now has ${r.counts ? fmtInt(r.counts.queue) : '?'} coins.`);
    else toast(`Not reprocessed: ${r.reason}`, 'warning');
    await refresh(true);
  } catch (err) {
    toast(`Reprocess failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Reprocess latest batch';
  }
}

async function refreshLbank(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Refreshing, about a minute…';
  try {
    const r = await apiPost('lbank/refresh', {});
    if (r.ok)
      toast(
        `LBank list refreshed: ${fmtInt(r.pairs)} pairs. Queue ${r.counts ? fmtInt(r.counts.queue) : '?'}.`,
      );
    else
      toast(
        `LBank list not refreshed: ${r.reason || `${r.status}${r.notes && r.notes.length ? `, ${r.notes[0]}` : ''}`}`,
        'warning',
      );
    await refresh(true);
  } catch (err) {
    toast(`LBank refresh failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh LBank list now';
  }
}

/* ============================== Overview ============================== */

function renderOverview(ov) {
  renderBanners(ov);
  renderPulse(ov);
  const b = ov.latestBatch,
    sc = ov.scan,
    c = (sc && sc.counts) || {};
  for (const [k, n] of [
    ['queue', c.queue],
    ['eligible', c.eligible],
    ['needs_review', c.needsReview],
    ['excluded', c.excluded],
  ])
    $(`count-${k}`).textContent = fmtInt(n ?? 0);

  $('scan-meta').textContent = sc ? `as of ${fmtTime(sc.asOf)}` : '';
  const funnel = $('funnel');
  if (!sc) put(funnel, el('div', { class: 'empty' }, 'No scan yet. The first run fills this in.'));
  else {
    const stages = [
      {
        label: 'Listed on CMC',
        value: c.assets || 0,
        sub: b ? `${fmtInt(b.collected)} of ${fmtInt(b.listedTotal)} collected` : '',
      },
      { label: 'Evaluated', value: c.evaluated || 0, sub: 'windows computed' },
      { label: 'Eligible', value: c.eligible || 0, sub: 'all hard filters pass' },
      {
        label: 'Review queue',
        value: c.queue || 0,
        sub: (QUEUE[sc.queueStatus] || [0, sc.queueStatus])[1],
      },
    ];
    const key = JSON.stringify(stages.map((s) => s.value));
    if (funnel.dataset.key !== key) {
      funnel.dataset.key = key;
      const boxF = el('div', { class: 'chart-box' });
      put(funnel, boxF);
      mount(boxF, (W) => drawFunnel(W, stages));
    }
  }

  const pass = (k) => (c.pass && c.pass[k]) || {};
  put(
    $('windows'),
    sc
      ? [
          stackRows(
            ['3d', '7d', '30d'].map((w) => {
              const p = pass(`pass${w}`);
              return {
                label: w,
                segs: [
                  { value: p.YES || 0, tone: 'surge', label: 'YES' },
                  { value: p.NO || 0, tone: 'muted', label: 'NO' },
                  { value: p['N/A'] || 0, tone: 'na', label: 'N/A' },
                ],
              };
            }),
          ),
          el(
            'div',
            { class: 'legend-inline' },
            el('span', null, el('i', { class: 'surge' }), 'YES'),
            el('span', null, el('i', { class: 'muted' }), 'NO'),
            el('span', null, el('i', { class: 'na' }), 'N/A'),
          ),
        ]
      : el('div', { class: 'empty' }, 'No scan yet.'),
  );

  put(
    $('split'),
    sc
      ? donut(
          [
            {
              label: 'Eligible',
              value: c.eligible || 0,
              tone: 'base',
              onClick: () => selectTab('eligible'),
            },
            {
              label: 'Needs review',
              value: c.needsReview || 0,
              tone: 'warn',
              onClick: () => selectTab('needs_review'),
            },
            {
              label: 'Excluded',
              value: c.excluded || 0,
              tone: 'muted',
              onClick: () => selectTab('excluded'),
            },
          ],
          { totalLabel: 'coins' },
        )
      : el('div', { class: 'empty' }, 'No scan yet.'),
  );

  const st = c.stars || {};
  put(
    $('stars'),
    sc
      ? hbars(
          ['3', '2', '1', '0'].map((k) => ({
            label: k === '0' ? 'No star' : `${k} ${k === '1' ? 'star' : 'stars'}`,
            value: st[k] || 0,
            tone: k === '0' ? 'muted' : `surge s${k}`,
          })),
        )
      : el('div', { class: 'empty' }, 'No scan yet.'),
  );

  const reasons = Object.entries(c.reasons || {}).sort((x, y) => y[1] - x[1]);
  put(
    $('reasons'),
    hbars(
      reasons.map(([k, v]) => ({ label: reasonText(k), value: v, tone: 'rose' })),
      { empty: 'No exclusions yet.' },
    ),
  );

  renderQuality(ov, sc, c);
  renderRules();
  void loadQueueStrip(sc);
}

function renderQuality(ov, sc, c) {
  $('quality-meta').textContent =
    ov.crawlAgeMinutes !== undefined && ov.crawlAgeMinutes !== null
      ? `crawled ${fmtInt(ov.crawlAgeMinutes)} min ago`
      : '';
  if (!sc) return put($('quality'), el('div', { class: 'empty' }, 'No scan yet.'));
  const segsOf = (obj, map, tones) =>
    Object.entries(obj || {}).map(([k, v]) => ({
      value: v,
      tone: tones[k] || 'muted',
      label: (map[k] || [0, k])[1],
    }));
  const curTones = {
    OK: 'base',
    STALE: 'warn',
    TIMESTAMP_UNVERIFIED: 'warn',
    MISMATCHED: 'rose',
    MISSING: 'rose',
    INVALID: 'rose',
  };
  const lbTones = {
    VERIFIED: 'base',
    PAIR_LISTED_UNVERIFIED: 'warn',
    NOT_LISTED: 'muted',
    NOT_TRADABLE: 'rose',
    UNKNOWN: 'warn',
  };
  const lbankRows = (rows) =>
    el(
      'div',
      { class: 'quality-stack' },
      rows.map((r) =>
        el(
          'div',
          { class: 'q-row' },
          el('span', { class: 'q-label' }, r.label),
          stackRows([{ label: '', segs: r.segs }]).firstChild.children[1],
          el(
            'span',
            { class: 'q-legend' },
            r.segs.map((s) => el('span', { class: s.tone }, `${s.label} ${fmtInt(s.value)}`)),
          ),
        ),
      ),
    );
  const l = S.lbank && S.lbank.list;
  const lbButton = can('scan:operate')
    ? el(
        'button',
        {
          type: 'button',
          class: 'btn',
          title: "Fetch the Markets list of CMC's LBank page now, then recompute the latest batch",
          onclick: refreshLbank,
        },
        'Refresh LBank list now',
      )
    : null;
  put(
    $('quality'),
    lbankRows([
      { label: 'Current quotes', segs: segsOf(c.current, CURRENT, curTones) },
      { label: 'LBank status', segs: segsOf(c.lbank, LBANK, lbTones) },
    ]),
    el(
      'div',
      { class: 'lbank-line' },
      l
        ? el(
            'div',
            null,
            el('b', null, `${fmtInt(l.pairs)} LBank spot pairs`),
            el(
              'span',
              { class: 'muted' },
              ` fetched ${fmtAgo(l.fetchedAt)}, next refresh ${fmtTime(l.nextRefreshAt)}`,
            ),
            l.stale
              ? el(
                  'div',
                  { class: 'error small' },
                  `Older than ${S.lbank.maxAgeDays} days: LBank status is unknown and the queue is withheld until it is refreshed.`,
                )
              : null,
            l.lastAttempt && l.lastAttempt.status !== 'COMPLETE'
              ? el(
                  'div',
                  { class: 'error small' },
                  `Last refresh ${fmtTime(l.lastAttempt.at)} ${l.lastAttempt.status}${l.lastAttempt.error ? `: ${l.lastAttempt.error}` : ''}. The list above stays in use.`,
                )
              : null,
          )
        : el('span', { class: 'muted' }, 'No complete LBank list yet. The next run fetches it.'),
      lbButton,
    ),
    sc.warnings.length
      ? el(
          'ul',
          { class: 'notes warnings' },
          sc.warnings.map((w) => el('li', null, w)),
        )
      : el('p', { class: 'muted small' }, 'No warnings for the latest scan.'),
    ov.export
      ? el(
          'p',
          { class: 'muted small' },
          `Last export ${fmtTime(ov.export.exportedAt)}, batch ${shortId(ov.export.batchId)}.`,
        )
      : null,
  );
}

function renderRules() {
  const st = S.cfg.strategy,
    r = st.rules;
  $('rules-version').textContent =
    `${st.rulesetVersion}, overrides ${st.overrides.version || st.overrides.error || '—'}`;
  put(
    $('rules'),
    el(
      'ol',
      { class: 'rule-list' },
      [
        `Rank ${r.rankMin}–${r.rankMax} (current CMC rank, inclusive).`,
        `Circulating market cap at least ${fmtUsd(r.minMarketCapUsd)}.`,
        "Listed at least 60 × 24 h since CMC's date added (exactly 60 days qualifies).",
        'Not a stablecoin or tokenized stock or asset (CMC tags plus versioned overrides). Fan tokens stay eligible.',
        st.lbank && st.lbank.requireManualVerification
          ? 'An LBank Spot pair (any quote currency), unambiguously mapped and verified tradable by you.'
          : `An LBank Spot pair (any quote currency) in the Markets list of CMC's LBank page, unambiguously mapped. The list refreshes every ${st.lbank ? st.lbank.refreshDays : 30} days or on demand.`,
        `VMC = volume ÷ market cap. Current = the rolling-24h quote, stale after ${st.maxQuoteAgeMinutes} min.`,
        'Means of completed UTC daily ratios over exactly the last 3, 7, 14 and 30 days. A missing or invalid day makes only its windows N/A.',
        `YES when current ≥ ${r.passMultiple} × the mean (3d, 7d, 30d; 14d is context only). Stars = number of YES.`,
        st.ranking
          ? `Queue order (${st.ranking.version}): stars, then weighted points (3d ${st.ranking.points[3]} · 7d ${st.ranking.points[7]} · 30d ${st.ranking.points[30]} per YES; an N/A earns none and makes the score a lower bound), complete scores first, then weighted strength (multiples capped at ${st.ranking.strengthCap}), then the 3-day multiple, then CMC id. Weights are a product choice, not a probability.`
          : null,
      ]
        .filter(Boolean)
        .map((t) => el('li', null, t)),
    ),
  );
}

async function loadQueueStrip(sc) {
  const box = $('queue-strip');
  if (!sc) return put(box, el('div', { class: 'empty' }, 'No scan yet.'));
  const key = `${sc.batchId}:${sc.finishedAt}`;
  if (box.dataset.key === key) return;
  try {
    const data = await api('scan?sheet=queue&limit=12');
    box.dataset.key = key;
    if (!data.rows.length)
      return put(
        box,
        el(
          'div',
          { class: 'empty' },
          'No eligible coin has a current VMC at least 1.5× any of its own 3, 7 or 30-day means right now.',
        ),
      );
    put(
      box,
      data.rows.map((r) =>
        el(
          'button',
          {
            type: 'button',
            class: 'qcard',
            onclick: (e) => openAsset(r.cmcId, data.batchId, e.currentTarget),
          },
          el(
            'div',
            { class: 'qcard-head' },
            logo(r.cmcId, 28),
            el('div', { class: 'coin-text' }, el('b', null, r.symbol), el('span', null, r.name)),
            stars(r.stars),
          ),
          el(
            'div',
            { class: 'qcard-vmc' },
            el('b', null, fmtVmc(r.currentVmc)),
            el('span', null, 'current VMC'),
          ),
          el(
            'div',
            { class: 'qcard-mults' },
            [
              ['3d', r.pass3d, r.multiple3d],
              ['7d', r.pass7d, r.multiple7d],
              ['30d', r.pass30d, r.multiple30d],
            ].map(([w, s, mm]) =>
              el(
                'div',
                { class: 'qm' },
                el('span', null, w),
                s === 'N/A' ? el('span', { class: 'pass na' }, 'N/A') : multBar(num(mm), s),
                el('b', { class: s === 'YES' ? 'yes' : null }, s === 'N/A' ? '' : fmtMult(mm)),
              ),
            ),
          ),
          el(
            'div',
            { class: 'qcard-foot' },
            el('span', null, `#${r.queueOrder}`),
            el('span', null, `cap ${fmtUsd(r.capUsd)}`),
            r.review ? chip(r.review.finalDecision, { tone: 'violet' }) : null,
          ),
        ),
      ),
    );
  } catch (e) {
    put(box, el('div', { class: 'error' }, `Could not load the queue: ${e.message}`));
  }
}

/* ============================== Sheets ============================== */

const pointsCol = {
  label: 'Points',
  num: true,
  title: 'Weighted points: 3d 60, 7d 25, 30d 15 per YES. The queue is ranked by stars, then points.',
  render: (r) => pointsCell(r.weightedPassPoints, r.scoreComplete, r.weightedStrength),
};
const sheetCols = (sheet) =>
  [
    sheet === 'queue'
      ? { label: '#', num: true, render: (r) => r.queueOrder }
      : { label: 'Rank', num: true, render: (r) => r.rank ?? '—' },
    { label: 'Coin', render: coinCell },
    // On the queue, stars and weighted points are the ranking: show them first.
    sheet === 'queue' ? { label: 'Stars', render: (r) => stars(r.stars) } : null,
    sheet === 'queue' ? pointsCol : null,
    sheet === 'queue' ? { label: 'Rank', num: true, render: (r) => r.rank ?? '—' } : null,
    { label: 'Market cap', num: true, render: (r) => fmtUsd(r.capUsd) },
    {
      label: 'Vol 24h',
      num: true,
      title: 'rolling 24h volume (not this hour)',
      render: (r) => fmtUsd(r.volume24hUsd),
    },
    {
      label: 'Current VMC',
      num: true,
      title: 'rolling 24h volume ÷ market cap',
      render: (r) =>
        el(
          'span',
          {
            title: r.currentStatus !== 'OK' ? reasonText(r.currentReason) : null,
            class: r.currentStatus !== 'OK' ? 'muted' : 'vmc-now',
          },
          fmtVmc(r.currentVmc),
          r.currentStatus !== 'OK'
            ? ` ${(CURRENT[r.currentStatus] || [0, r.currentStatus])[1].toLowerCase()}`
            : '',
        ),
    },
    { label: '3d', render: (r) => passCell(r.pass3d, r.multiple3d, r.reason3d) },
    { label: '7d', render: (r) => passCell(r.pass7d, r.multiple7d, r.reason7d) },
    { label: '30d', render: (r) => passCell(r.pass30d, r.multiple30d, r.reason30d) },
    {
      label: '14d mean',
      num: true,
      title: 'context only',
      render: (r) =>
        r.vmc14dAvg === null
          ? el('span', { class: 'muted', title: reasonText(r.avg14dReason) }, 'N/A')
          : fmtVmc(r.vmc14dAvg),
    },
    sheet === 'queue' ? null : { label: 'Stars', render: (r) => stars(r.stars) },
    sheet === 'eligible' ? pointsCol : null,
    sheet === 'eligible' || sheet === 'queue'
      ? null
      : {
          label: 'Reasons',
          render: (r) =>
            el(
              'span',
              { class: 'chips' },
              (r.eligibilityReasons || []).map((x) => chip(reasonText(x))),
            ),
        },
    {
      label: 'LBank',
      render: (r) =>
        el(
          'span',
          { title: (r.lbankPairs || []).map((p) => p.marketPair).join(', ') },
          lab(LBANK, r.lbankStatus),
        ),
    },
    {
      label: 'Venue',
      render: (r) =>
        el(
          'span',
          { class: 'chips' },
          (r.venueFlags || []).map((f) => chip(f.replace(/_/g, ' ').toLowerCase())),
        ),
    },
    {
      label: 'Review',
      render: (r) =>
        r.review
          ? chip(
              `${r.review.finalDecision}${r.review.planStatus ? ` (${r.review.planStatus})` : ''}`,
              {
                tone: 'violet',
                title: `${r.review.reviewer}, ${fmtTime(r.review.reviewedAt)}; venue ${r.review.venueDecision}; day ${r.review.eventDay}`,
              },
            )
          : el('span', { class: 'muted' }, '—'),
    },
  ].filter(Boolean);

async function loadSheet(sheet) {
  const sec = $(`tab-${sheet}`);
  const st = S.sheets[sheet];
  const size = Number(sec.querySelector('.sheet-rows').value);
  const q = new URLSearchParams({ sheet, limit: String(size), offset: String(st.page * size) });
  if (st.search) q.set('search', st.search);
  const data = await api(`scan?${q}`);
  $('page-sub').textContent =
    `${PAGES[sheet][1]}${data.batchId ? ` Batch ${shortId(data.batchId)}, as of ${fmtTime(data.asOf)}.` : ''}`;
  const status = sec.querySelector('.sheet-status');
  if (status) {
    const qs = data.queueStatus;
    put(
      status,
      qs && qs !== 'PUBLISHED' && qs !== 'EMPTY'
        ? el(
            'div',
            { class: 'banner inline' },
            `${(QUEUE[qs] || [0, qs])[1]}. These rows are shown for inspection only and are not a complete queue.`,
          )
        : null,
    );
  }
  const open = (r, from) => openAsset(r.cmcId, data.batchId, from);
  put(
    sec.querySelector('.sheet-table'),
    table(sheetCols(sheet), data.rows, {
      empty: data.batchId
        ? sheet === 'queue'
          ? 'No eligible coin has a current VMC at least 1.5× any of its own 3, 7 or 30-day means.'
          : st.search
            ? `No coin matches “${st.search}”.`
            : 'No coins in this list.'
        : 'No scan yet.',
      onRow: open,
    }),
  );
  const sc = sec.querySelector('.sheet-scatter');
  if (sc) {
    const boxS = el('div', { class: 'chart-box' });
    put(
      sc,
      el(
        'p',
        { class: 'muted small scatter-note' },
        'Each dot is a coin on this page: further above the amber line means a bigger surge against its own 30-day mean. Dot size is market cap; colour is stars.',
      ),
      boxS,
    );
    if (st.view === 'scatter') mount(boxS, (W) => drawScatter(W, data.rows, (r) => open(r, null)));
    else sc.dataset.pending = '1';
    sc._rows = data.rows;
    sc._open = open;
  }
  pager(sec.querySelector('.sheet-pager'), {
    page: st.page,
    pageSize: size,
    total: data.total,
    onPage: (pg) => {
      st.page = pg;
      void loadSheet(sheet).catch(showError(sheet));
    },
  });
}

function setSheetView(sheet, view) {
  const sec = $(`tab-${sheet}`);
  S.sheets[sheet].view = view;
  sec
    .querySelectorAll('.view-seg button')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  const tableBox = sec.querySelector('.sheet-table'),
    sc = sec.querySelector('.sheet-scatter');
  if (!sc) return;
  tableBox.hidden = view !== 'table';
  sc.hidden = view !== 'scatter';
  if (view === 'scatter' && sc.dataset.pending && sc._rows) {
    delete sc.dataset.pending;
    const boxS = sc.querySelector('.chart-box');
    mount(boxS, (W) => drawScatter(W, sc._rows, (r) => sc._open(r, null)));
  }
}

/* ============================== Coin detail drawer ============================== */

async function openAsset(cmcId, batchId, returnFocus) {
  S.drawer = { cmcId, batchId, returnFocus: returnFocus || document.activeElement };
  setCoinParam(cmcId);
  $('drawer').hidden = false;
  $('drawer-backdrop').hidden = false;
  document.body.classList.add('drawer-open');
  $('drawer-title').textContent = 'Loading…';
  $('drawer-sub').textContent = `CMC id ${cmcId}`;
  put($('drawer-logo'), logo(cmcId, 40));
  put($('drawer-body'), el('div', { class: 'skeleton' }, el('i'), el('i'), el('i')));
  $('drawer-close').focus();
  try {
    const t = await api(`assets/${cmcId}/trace${batchId ? `?batchId=${batchId}` : ''}`);
    renderTrace(t);
  } catch (e) {
    $('drawer-title').textContent = `CMC id ${cmcId}`;
    put(
      $('drawer-body'),
      el(
        'div',
        { class: 'panel' },
        el(
          'p',
          null,
          e.status === 404
            ? 'This coin has no Tier 1 record in the latest scan, so there is nothing to trace yet. Coins appear here after a run collects them.'
            : `Could not load the coin: ${e.message}`,
        ),
      ),
    );
  }
}

/** Keeps `?coin=<cmcId>` in the address bar while a coin is open, so the view can be shared or reloaded. */
function setCoinParam(cmcId) {
  const u = new URL(location.href);
  if (cmcId === null) u.searchParams.delete('coin');
  else u.searchParams.set('coin', String(cmcId));
  history.replaceState(null, '', u);
}

function closeDrawer() {
  setCoinParam(null);
  $('drawer').hidden = true;
  $('drawer-backdrop').hidden = true;
  document.body.classList.remove('drawer-open');
  hideTip();
  const back = S.drawer.returnFocus;
  S.drawer = { cmcId: null, batchId: null, returnFocus: null };
  if (back && document.contains(back)) back.focus();
}

function vmcPanel(t) {
  const r = t.record;
  const days = [...t.daily.used].sort((a, b) => (a.dateUtc < b.dateUtc ? -1 : 1));
  const wins = t.windows || [];
  const cur = num(r.currentVmc);
  let sel = (
    wins.find((w) => w.pass && w.pass.status === 'YES') ||
    wins.find((w) => w.pass) ||
    wins[0] ||
    {}
  ).days;
  const seg = el('div', {
    class: 'seg win-seg',
    role: 'group',
    'aria-label': 'Compare with window',
  });
  const box = el('div', { class: 'chart-box' });
  const caption = el('p', { class: 'chart-caption' });
  let redraw = () => undefined;
  const winOf = () => wins.find((w) => w.days === sel);
  const renderSeg = () =>
    put(
      seg,
      wins.map((w) => {
        const p = w.pass;
        const cls = p ? (p.status === 'YES' ? 'yes' : p.status === 'NO' ? 'no' : 'na') : 'ctx';
        return el(
          'button',
          {
            type: 'button',
            class: `win ${cls}`,
            'aria-pressed': String(w.days === sel),
            onclick: () => {
              sel = w.days;
              renderSeg();
              renderCaption();
              redraw();
            },
          },
          el('span', { class: 'win-days' }, `${w.days} days`),
          el(
            'span',
            { class: 'win-val' },
            p
              ? p.status === 'N/A'
                ? 'N/A'
                : `${p.status} ${fmtMult(p.multiple)}`
              : w.mean === null
                ? 'N/A'
                : 'context',
          ),
        );
      }),
    );
  const renderCaption = () => {
    const w = winOf();
    if (!w) return put(caption, '');
    const mean = num(w.mean);
    if (!isNum(mean))
      return put(caption, `The ${w.days}-day mean is not available: ${reasonText(w.reason)}.`);
    if (!isNum(cur))
      return put(
        caption,
        `The ${w.days}-day mean is ${fmtVmc(mean)}, but there is no valid current quote to compare.`,
      );
    const mult = cur / mean;
    put(
      caption,
      el(
        'span',
        null,
        'Current VMC ',
        el('b', { class: 'surge-text' }, fmtVmc(cur)),
        ` is ${fmtMult(mult)} the ${w.days}-day mean of `,
        el('b', { class: 'base-text' }, fmtVmc(mean)),
        w.pass
          ? `. YES needs at least ${passLine()}×, so this window is ${w.pass.status}.`
          : '. The 14-day window is context only.',
      ),
    );
  };
  renderSeg();
  renderCaption();
  if (days.length) redraw = mount(box, (W) => drawVmc(W, days, cur, winOf()));
  else
    box.append(
      el('div', { class: 'empty chart-empty' }, 'No daily rows: excluded coins are not evaluated.'),
    );
  return el(
    'section',
    { class: 'panel' },
    el(
      'div',
      { class: 'panel-head' },
      el('h3', null, 'Volume ÷ market cap'),
      el('span', { class: 'hint' }, 'completed UTC days, then now'),
    ),
    seg,
    box,
    caption,
  );
}

function pricePanel(t) {
  const r = t.record;
  const days = [...t.daily.used].sort((a, b) => (a.dateUtc < b.dateUtc ? -1 : 1));
  const ranges = [
    ['daily', '30 days, daily'],
    ['72', '72 h'],
    ['168', '7 days'],
    ['720', '30 days, hourly'],
  ];
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Price range' });
  const body = el('div');
  const t0 = (ymd) => new Date(`${ymd}T00:00:00Z`).getTime();
  const renderSeg = () =>
    put(
      seg,
      ranges.map(([k, label]) =>
        el(
          'button',
          {
            type: 'button',
            'aria-pressed': String(S.priceRange === k),
            onclick: () => {
              S.priceRange = k;
              renderSeg();
              void draw();
            },
          },
          label,
        ),
      ),
    );
  async function draw() {
    if (S.priceRange === 'daily') {
      put(
        body,
        seriesChart({
          label: 'Close',
          barLabel: 'Daily volume',
          tone: 'violet',
          height: 230,
          fmt: fmtPrice,
          barFmt: fmtUsd,
          xfmt: (ts) =>
            new Date(ts).toLocaleDateString('en-GB', {
              timeZone: 'UTC',
              month: 'short',
              day: 'numeric',
            }),
          xfmtLong: (ts) =>
            `${new Date(ts).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })} (UTC close)`,
          points: days.map((d) => ({ t: t0(d.dateUtc), v: num(d.closeUsd) })),
          bars: days.map((d) => ({ t: t0(d.dateUtc), v: num(d.volumeUsd) })),
          empty: 'No daily closes stored for this coin yet.',
        }),
      );
      return;
    }
    put(body, el('div', { class: 'skeleton short' }, el('i')));
    try {
      const s = await api(`assets/${r.cmcId}/snapshots?hours=${S.priceRange}`);
      const snaps = s.snapshots || [];
      const note = (x) =>
        (x.qualityFlags || []).includes('historical_backfill')
          ? 'backfilled from genuine chart history'
          : null;
      put(
        body,
        seriesChart({
          label: 'Price',
          barLabel: 'Rolling 24h volume',
          tone: 'violet',
          height: 230,
          fmt: fmtPrice,
          xfmt: (ts) =>
            new Date(ts).toLocaleString('en-GB', {
              timeZone: tz(),
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              hour12: false,
            }),
          xfmtLong: (ts) => fmtTime(new Date(ts).toISOString()),
          points: snaps.map((x) => ({
            t: new Date(x.slotTime).getTime(),
            v: num(x.price),
            note: note(x),
          })),
          bars: snaps.map((x) => ({
            t: new Date(x.slotTime).getTime(),
            v: num(x.volumeRolling24h),
          })),
          empty: `Hourly snapshots build up with each run: ${snaps.length} stored for this coin so far. Use the daily view meanwhile.`,
        }),
      );
    } catch (e) {
      put(body, el('div', { class: 'error' }, `Could not load snapshots: ${e.message}`));
    }
  }
  renderSeg();
  void draw();
  return el(
    'section',
    { class: 'panel' },
    el(
      'div',
      { class: 'panel-head' },
      el('h3', null, 'Price and volume'),
      el('span', { class: 'hint' }, `now ${fmtPrice(r.priceUsd)}`),
    ),
    seg,
    body,
  );
}

function venuePanel(t) {
  const v = t.venues && t.venues.summary;
  const head = el(
    'div',
    { class: 'panel-head' },
    el('h3', null, 'Where it trades'),
    el(
      'span',
      { class: 'hint' },
      v
        ? `${v.pairsUsed} of ${v.expectedCount ?? '?'} spot pairs, ${fmtAgo(v.observedAt)}`
        : 'not collected',
    ),
  );
  if (!v || !v.exchanges.length)
    return el(
      'section',
      { class: 'panel' },
      head,
      el(
        'div',
        { class: 'empty' },
        'Venue rows are collected for review candidates (the queue, or needs review with a YES).',
      ),
    );
  const ex = [...v.exchanges].sort((a, b) => num(b.volumeUsd) - num(a.volumeUsd));
  const top = ex.slice(0, 5);
  const rest = ex.slice(5).reduce((a, e) => a + (num(e.volumeUsd) || 0), 0);
  const tones = ['violet', 'base', 'surge', 'rose', 'warn'];
  const segs = top.map((e, i) => ({
    label: e.name,
    value: Math.round(num(e.volumeUsd) || 0),
    tone: tones[i],
  }));
  if (rest > 0)
    segs.push({ label: `${ex.length - 5} others`, value: Math.round(rest), tone: 'muted' });
  const d = donut(segs, { size: 140, totalLabel: '24h volume' });
  d.querySelector('.donut-value').textContent = fmtUsd(segs.reduce((a, s) => a + s.value, 0));
  d.querySelectorAll('.legend b').forEach((b, i) => {
    b.textContent = fmtUsd(segs[i].value);
  });
  return el(
    'section',
    { class: 'panel' },
    head,
    d,
    (v.flags || []).length
      ? el(
          'div',
          { class: 'chips' },
          v.flags.map((f) => chip(f.replace(/_/g, ' ').toLowerCase(), { tone: 'warn' })),
        )
      : null,
    el(
      'p',
      { class: 'muted small' },
      'CMC-reported spot volume by exchange. Upbit-dominant or single-venue activity is flagged for your judgment; there is no share cutoff.',
    ),
  );
}

function renderTrace(t) {
  const r = t.record,
    b = t.batch,
    elig = t.eligibility;
  $('drawer-title').textContent = r.symbol;
  $('drawer-sub').textContent =
    `${r.name}${r.rank ? `, rank ${r.rank}` : ''}, CMC id ${r.cmcId}${b.isLive ? '' : ', synthetic'}`;
  put($('drawer-logo'), logo(r.cmcId, 40));

  const summary = el(
    'section',
    { class: 'coin-hero' },
    el(
      'div',
      { class: 'coin-price' },
      el('b', null, fmtPrice(r.priceUsd)),
      el('span', null, `cap ${fmtUsd(r.capUsd)}, 24h volume ${fmtUsd(r.volume24hUsd)}`),
    ),
    el(
      'div',
      { class: 'coin-vmc' },
      el('span', null, 'current VMC'),
      el('b', null, fmtVmc(r.currentVmc)),
      stars(r.stars),
    ),
    el(
      'div',
      { class: 'chips' },
      r.inQueue ? chip(`Review queue #${r.queueOrder}`, { strong: true, dot: 'accent' }) : null,
      chip((ELIG[elig.status] || [0, elig.status])[1], { dot: (ELIG[elig.status] || [])[0] }),
      chip((LBANK[r.lbankStatus] || [0, r.lbankStatus])[1], {
        dot: (LBANK[r.lbankStatus] || [])[0],
      }),
      chip((CURRENT[r.currentStatus] || [0, r.currentStatus])[1], {
        dot: (CURRENT[r.currentStatus] || [])[0],
      }),
      live() && r.slug
        ? el(
            'a',
            {
              class: 'chip link-chip',
              href: `https://coinmarketcap.com/currencies/${r.slug}/`,
              target: '_blank',
              rel: 'noopener noreferrer',
            },
            'CoinMarketCap',
          )
        : null,
    ),
    elig.reasons.length
      ? el(
          'div',
          { class: 'chips' },
          el('span', { class: 'muted small' }, 'Left out because:'),
          elig.reasons.map((x) => chip(reasonText(x), { tone: 'rose' })),
        )
      : null,
    r.flags.length || r.venueFlags.length
      ? el(
          'div',
          { class: 'chips' },
          el('span', { class: 'muted small' }, 'Flags:'),
          [...r.flags, ...r.venueFlags].map((x) =>
            chip(String(x).replace(/_/g, ' ').toLowerCase(), { tone: 'warn' }),
          ),
        )
      : null,
  );

  const lb = t.lbank;
  const canWrite = can('review:write');
  const decide = (decision, marketPair) => venueDecision(r, decision, marketPair);
  const lbank = el(
    'section',
    { class: 'panel' },
    el(
      'div',
      { class: 'panel-head' },
      el('h3', null, 'LBank Spot pairs'),
      el(
        'span',
        { class: 'hint' },
        lb.crawl
          ? `list ${lb.crawl.status.toLowerCase()}, ${fmtTime(lb.crawl.finishedAt)}`
          : 'no list',
      ),
    ),
    el(
      'div',
      { class: 'table-wrap' },
      table(
        [
          {
            label: 'Pair',
            render: (p) =>
              p.marketUrl
                ? el(
                    'a',
                    { href: p.marketUrl, target: '_blank', rel: 'noopener noreferrer' },
                    el('b', null, p.marketPair),
                  )
                : el('b', null, p.marketPair),
          },
          {
            label: 'Mapping',
            render: (p) =>
              chip(p.mapping.toLowerCase(), {
                dot:
                  p.mapping === 'OK' || p.mapping === 'CONFIRMED'
                    ? 'good'
                    : p.mapping === 'AMBIGUOUS'
                      ? 'serious'
                      : 'critical',
              }),
          },
          {
            label: 'Trading',
            render: (p) =>
              chip(`${p.trading.toLowerCase()}${p.tradingSource ? ` (${p.tradingSource})` : ''}`, {
                dot:
                  p.trading === 'TRADING'
                    ? 'good'
                    : p.trading === 'UNVERIFIED'
                      ? 'warning'
                      : 'critical',
              }),
          },
          { label: 'Vol 24h', num: true, render: (p) => fmtUsd(p.volumeUsd) },
          {
            label: '',
            render: (p) =>
              canWrite
                ? el(
                    'div',
                    { class: 'row-actions' },
                    p.mapping === 'AMBIGUOUS'
                      ? [
                          el(
                            'button',
                            {
                              type: 'button',
                              class: 'btn small',
                              onclick: () => decide('MAPPING_CONFIRMED', p.marketPair),
                            },
                            'Mapping correct',
                          ),
                          el(
                            'button',
                            {
                              type: 'button',
                              class: 'btn small danger',
                              onclick: () => decide('MAPPING_REJECTED', p.marketPair),
                            },
                            'Wrong asset',
                          ),
                        ]
                      : null,
                    p.trading !== 'TRADING'
                      ? el(
                          'button',
                          {
                            type: 'button',
                            class: 'btn small primary',
                            onclick: () => decide('VERIFIED_TRADABLE', p.marketPair),
                          },
                          'Verified tradable',
                        )
                      : null,
                    el(
                      'button',
                      {
                        type: 'button',
                        class: 'btn small danger',
                        onclick: () => decide('NOT_TRADABLE', p.marketPair),
                      },
                      'Not tradable',
                    ),
                  )
                : null,
          },
        ],
        lb.pairs,
        {
          empty: `No LBank Spot pair maps to this CMC id (${lb.status}${lb.reason ? `: ${lb.reason}` : ''}).`,
        },
      ),
    ),
    lb.status === 'UNKNOWN' && lb.reason === 'PAIR_DISAPPEARED' && canWrite
      ? el(
          'button',
          { type: 'button', class: 'btn danger', onclick: () => decide('NOT_TRADABLE', null) },
          'Confirm: no tradable LBank pair',
        )
      : null,
    lb.tasks.length
      ? el(
          'div',
          { class: 'chips' },
          el('span', { class: 'muted small' }, 'Mapping tasks:'),
          lb.tasks.map((x) =>
            chip(`${x.marketPair} ${x.kind} ${x.status}`, {
              dot: x.status === 'OPEN' ? 'serious' : 'good',
            }),
          ),
        )
      : null,
    lb.decisions.length
      ? el(
          'p',
          { class: 'muted small' },
          `${lb.decisions.length} LBank decision${lb.decisions.length === 1 ? '' : 's'} recorded; see the History tab.`,
        )
      : null,
    el(
      'p',
      { class: 'muted small' },
      S.cfg.strategy.lbank && S.cfg.strategy.lbank.requireManualVerification
        ? "Pairs come from the Markets section of CMC's LBank page, mapped by CMC coin id. That list has no trading status, so a pair counts as tradable only after you verify it on LBank."
        : "Pairs come from the Markets section of CMC's LBank page, mapped by CMC coin id. A listed, unambiguous pair counts as tradable; mark it not tradable if LBank shows otherwise.",
    ),
  );

  const cur = t.current;
  const calc = el(
    'section',
    { class: 'panel' },
    el(
      'div',
      { class: 'panel-head' },
      el('h3', null, 'Current observation'),
      el('span', { class: 'hint' }, 'rolling 24h, not volume traded this hour'),
    ),
    el('p', { class: 'formula' }, cur.formula),
    kv([
      ['Provider update time', utc(r.observedAt)],
      ['Crawl time', utc(r.crawledAt)],
      ['Scan time', utc(r.computedAt)],
      [
        'Listed',
        `${utc(r.dateAdded)} (${r.ageDays === null ? '?' : Number(r.ageDays).toFixed(2)} days)`,
      ],
      ['Class', `${elig.assetClass} [${elig.classSource}]`],
      ['Batch', `${shortId(b.id)}, slot ${fmtTime(b.slotTime)}`],
    ]),
  );
  const calcWindows = el(
    'section',
    { class: 'panel' },
    el(
      'div',
      { class: 'panel-head' },
      el('h3', null, 'Windows'),
      el('span', { class: 'hint' }, 'mean of daily ratios, never Σvolume ÷ Σcap'),
    ),
    el(
      'div',
      { class: 'table-wrap' },
      table(
        [
          { label: 'Window', render: (w) => `${w.days}d` },
          {
            label: 'Dates',
            render: (w) =>
              w.dates.length ? `${w.dates[w.dates.length - 1]} → ${w.dates[0]}` : '—',
          },
          {
            label: 'Mean VMC',
            num: true,
            render: (w) =>
              w.mean === null
                ? el(
                    'span',
                    { class: 'muted', title: reasonText(w.reason) },
                    `N/A, ${reasonText(w.reason)}`,
                  )
                : fmtVmc(w.mean, true),
          },
          {
            label: 'Result',
            render: (w) =>
              w.pass
                ? passCell(w.pass.status, w.pass.multiple, w.pass.reason)
                : el('span', { class: 'muted' }, 'context only'),
          },
        ],
        t.windows,
      ),
    ),
    el(
      'ul',
      { class: 'notes mono formulas' },
      t.windows.flatMap((w) => [
        el('li', null, w.formula),
        w.comparison ? el('li', null, w.comparison) : null,
      ]),
    ),
  );
  const calcDaily = el(
    'section',
    { class: 'panel' },
    el(
      'div',
      { class: 'panel-head' },
      el('h3', null, 'Completed UTC daily rows used'),
      el('span', { class: 'hint' }, `as of ${t.daily.asOfDate}; the open day is never used`),
    ),
    el(
      'div',
      { class: 'table-wrap' },
      table(
        [
          { label: 'Day', render: (d) => `T−${d.daysAgo}` },
          { label: 'Date', render: (d) => d.dateUtc },
          {
            label: 'Volume (USD)',
            num: true,
            render: (d) =>
              d.volumeUsd === null ? '—' : Number(d.volumeUsd).toLocaleString('en-US'),
          },
          {
            label: 'Market cap (USD)',
            num: true,
            render: (d) =>
              d.marketCapUsd === null ? '—' : Number(d.marketCapUsd).toLocaleString('en-US'),
          },
          {
            label: 'VMC',
            num: true,
            render: (d) =>
              d.vmc === null
                ? el(
                    'span',
                    { class: 'error' },
                    d.valid === false ? `invalid: ${d.invalidReasons.join(', ')}` : 'missing',
                  )
                : fmtVmc(d.vmc),
          },
          { label: 'Close', num: true, render: (d) => fmtPrice(d.closeUsd) },
          {
            label: 'Rev.',
            num: true,
            render: (d) =>
              d.revision === null
                ? '—'
                : `${d.revision}${d.revisedSinceScan ? ' (revised since)' : ''}`,
          },
        ],
        t.daily.used,
        { empty: 'Not evaluated: no daily rows are requested for excluded coins.' },
      ),
    ),
  );

  const reviews = el(
    'section',
    { class: 'panel' },
    el(
      'div',
      { class: 'panel-head' },
      el('h3', null, 'Review history'),
      el('span', { class: 'hint' }, 'every save is a new revision'),
    ),
    el(
      'div',
      { class: 'table-wrap' },
      table(
        [
          { label: 'When', render: (x) => fmtTime(x.reviewedAt) },
          { label: 'Batch', render: (x) => `${shortId(x.batchId)} r${x.revision}` },
          { label: 'Reviewer', render: (x) => x.reviewer },
          { label: 'Venue, day', render: (x) => `${x.venueDecision}, ${x.eventDay}` },
          {
            label: 'Decision',
            render: (x) =>
              chip(`${x.finalDecision}${x.planStatus ? ` (${x.planStatus})` : ''}`, {
                tone: 'violet',
              }),
          },
          {
            label: 'Validation',
            render: (x) =>
              el(
                'span',
                { class: 'small' },
                [
                  ...((x.validation && x.validation.errors) || []),
                  ...((x.validation && x.validation.warnings) || []),
                ].join('; '),
              ),
          },
          {
            label: '',
            render: (x) =>
              el(
                'a',
                { href: `/api/reviews/${x.id}/export`, target: '_blank', rel: 'noopener' },
                'Export',
              ),
          },
        ],
        t.reviews,
        { empty: 'No review yet.' },
      ),
    ),
  );

  const decisions = el(
    'section',
    { class: 'panel' },
    el(
      'div',
      { class: 'panel-head' },
      el('h3', null, 'LBank decisions'),
      el('span', { class: 'hint' }, 'mapping and tradability decisions, newest first'),
    ),
    el(
      'div',
      { class: 'table-wrap' },
      table(
        [
          { label: 'When', render: (d) => fmtTime(d.decidedAt) },
          {
            label: 'Decision',
            render: (d) =>
              chip(d.decision.replace(/_/g, ' ').toLowerCase(), {
                tone:
                  d.decision === 'NOT_TRADABLE' || d.decision === 'MAPPING_REJECTED'
                    ? 'rose'
                    : 'violet',
              }),
          },
          { label: 'Pair', render: (d) => d.marketPair || '(coin)' },
          { label: 'Reviewer', render: (d) => d.reviewer },
          { label: 'Note', render: (d) => el('span', { class: 'small' }, d.note || '') },
        ],
        lb.decisions,
        { empty: 'No LBank decision recorded.' },
      ),
    ),
  );

  const changes = t.metadataChanges || [];
  const metadata = el(
    'section',
    { class: 'panel' },
    el(
      'div',
      { class: 'panel-head' },
      el('h3', null, 'CMC metadata changes'),
      el('span', { class: 'hint' }, 'name, symbol, tags or platform changes seen between crawls'),
    ),
    el(
      'div',
      { class: 'table-wrap' },
      table(
        [
          { label: 'Seen', render: (x) => fmtTime(x.observedAt) },
          { label: 'Field', render: (x) => x.field },
          {
            label: 'Before',
            render: (x) => el('span', { class: 'small muted' }, x.oldValue ?? '—'),
          },
          { label: 'After', render: (x) => el('span', { class: 'small' }, x.newValue ?? '—') },
        ],
        changes,
        { empty: 'No metadata change since the coin was first seen.' },
      ),
    ),
  );

  const historyCount = t.reviews.length + lb.decisions.length + changes.length;
  const tabs = [
    [
      'review',
      'Review',
      null,
      [
        vmcPanel(t),
        el('div', { class: 'grid-2 tight' }, pricePanel(t), venuePanel(t)),
        lbank,
        reviewForm(t),
      ],
    ],
    ['history', 'History', historyCount, [reviews, decisions, metadata]],
    ['calc', 'Calculation details', null, [calc, calcWindows, calcDaily]],
  ];
  if (!tabs.some(([k]) => k === S.detailTab)) S.detailTab = 'review';
  const bar = el('div', {
    class: 'detail-tabs',
    role: 'tablist',
    'aria-label': 'Coin detail sections',
  });
  const panels = tabs.map(([k, , , content]) =>
    el(
      'div',
      {
        class: 'detail-panel',
        role: 'tabpanel',
        id: `dp-${k}`,
        'aria-labelledby': `dt-${k}`,
        hidden: k !== S.detailTab,
      },
      content,
    ),
  );
  const show = (k, focus) => {
    S.detailTab = k;
    bar.querySelectorAll('[role=tab]').forEach((b) => {
      const on = b.dataset.k === k;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
      // Narrow screens scroll the tab strip sideways: keep the chosen tab in view.
      if (on) bar.scrollTo({ left: b.offsetLeft - 16, behavior: 'smooth' });
    });
    panels.forEach((p) => {
      p.hidden = p.id !== `dp-${k}`;
    });
    hideTip();
  };
  put(
    bar,
    tabs.map(([k, label, count]) =>
      el(
        'button',
        {
          type: 'button',
          role: 'tab',
          id: `dt-${k}`,
          'data-k': k,
          'aria-controls': `dp-${k}`,
          'aria-selected': String(k === S.detailTab),
          tabindex: k === S.detailTab ? 0 : -1,
          onclick: () => show(k),
        },
        label,
        count ? el('b', { class: 'count' }, fmtInt(count)) : null,
      ),
    ),
  );
  bar.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const i = tabs.findIndex(([k]) => k === S.detailTab);
    show(tabs[(i + dir + tabs.length) % tabs.length][0], true);
  });
  put($('drawer-body'), summary, bar, panels);
}

async function venueDecision(r, decision, marketPair) {
  const reviewer = savedReviewer();
  try {
    await apiPost('venue-decisions', {
      cmcId: r.cmcId,
      batchId: r.batchId,
      marketPair: marketPair || null,
      decision,
      reviewer,
      note: ($('rv-venueNote') && $('rv-venueNote').value) || undefined,
    });
    toast(
      `${decision.replace(/_/g, ' ').toLowerCase()} recorded for ${marketPair || 'the coin'}. It applies from the next scan, or now with “Reprocess latest batch”.`,
    );
    renderTrace(await api(`assets/${r.cmcId}/trace?batchId=${r.batchId}`));
  } catch (e) {
    toast(`Decision not saved: ${e.message}`, 'error');
  }
}

/** The signed-in user is the reviewer of record (the server sets it from the session, too). */
const savedReviewer = () => (S.me ? S.me.username : '');

function select(id, options, value, allowEmpty = true) {
  return el(
    'select',
    { id },
    allowEmpty ? el('option', { value: '' }, '—') : null,
    options.map((o) => el('option', { value: o, selected: o === value }, o)),
  );
}
const field = (label, control, hint) =>
  el(
    'label',
    { class: 'field' },
    el('span', null, label),
    control,
    hint ? el('small', { class: 'hint' }, hint) : null,
  );
const input = (id, attrs = {}) => el('input', { id, ...attrs });

/** Tier 1 decisions (venue, event day) and Tier 2 chart review + manual Spot trade plan (PDF p.15, p.24–27). */
function reviewForm(t) {
  const r = t.record,
    R = S.cfg.review;
  const last = t.reviews.find((x) => x.batchId === r.batchId) || null;
  const pairs = t.lbank.pairs.map((p) => p.marketPair);
  let reviewer = '';
  try {
    reviewer = localStorage.getItem('reviewer') || '';
  } catch {
    /* storage unavailable */
  }
  const plan = (last && last.plan) || {};
  const tp = (i, k) => (plan.targets && plan.targets[i] && plan.targets[i][k]) || '';
  const out = el('div', { id: 'rv-result', class: 'small', 'aria-live': 'polite' });
  const form = el(
    'form',
    { class: 'review-form', autocomplete: 'off' },
    el(
      'fieldset',
      null,
      el('legend', null, 'Tier 1: venue and event day'),
      field(
        'Reviewer',
        input('rv-reviewer', {
          value: savedReviewer(),
          readonly: true,
          title: 'Recorded from your sign-in',
        }),
      ),
      field(
        'Venue decision',
        select(
          'rv-venueDecision',
          R.venueDecisions,
          (last && last.venueDecision) || 'PENDING',
          false,
        ),
      ),
      field(
        'Venue note',
        input('rv-venueNote', {
          value: (last && last.venueNote) || '',
          maxlength: 1000,
          placeholder: 'e.g. only Upbit active',
        }),
      ),
      field(
        'Event day',
        select('rv-eventDay', R.eventDays, (last && last.eventDay) || 'UNKNOWN', false),
        'first or second day of unusual volume, judged from the VMC chart',
      ),
    ),
    el(
      'fieldset',
      null,
      el('legend', null, 'Tier 2: 1D chart review'),
      field('Verified LBank pair', select('rv-lbankPair', pairs, last && last.lbankPair)),
      field(
        'Chart exchange',
        input('rv-chartExchange', {
          value: (last && last.chartExchange) || '',
          placeholder: 'LBank (preferred) or proxy',
        }),
      ),
      field(
        'Chart symbol',
        input('rv-chartSymbol', {
          value: (last && last.chartSymbol) || '',
          placeholder: `${r.symbol}USDT`,
        }),
      ),
      field('Quote currency', input('rv-chartQuote', { value: (last && last.chartQuote) || '' })),
      field(
        'Chart URL',
        input('rv-chartUrl', { type: 'url', value: (last && last.chartUrl) || '' }),
      ),
      field(
        'Candle-close timezone',
        input('rv-chartTimezone', {
          value: (last && last.chartTimezone) || '',
          placeholder: 'e.g. UTC',
        }),
        'CMC daily rows close at 00:00 UTC',
      ),
      field(
        'Proxy reason (non-LBank chart)',
        input('rv-chartProxyReason', { value: (last && last.chartProxyReason) || '' }),
      ),
      field('Range low vs. top', select('rv-rangeLow', R.judgments, last && last.rangeLow)),
      field(
        'Chart history (real upward waves)',
        select('rv-chartHistory', R.judgments, last && last.chartHistory),
      ),
      field(
        'Prior pump response',
        select('rv-priorPumpResponse', R.judgments, last && last.priorPumpResponse),
      ),
      field('Candle state', select('rv-candleState', R.candleStates, last && last.candleState)),
      field(
        'BTC/ETH regime',
        select('rv-marketRegime', R.marketRegimes, last && last.marketRegime),
      ),
      field(
        'Final decision',
        select(
          'rv-finalDecision',
          R.finalDecisions,
          (last && last.finalDecision) || 'REVIEW',
          false,
        ),
      ),
      field(
        'Rationale',
        el(
          'textarea',
          { id: 'rv-rationale', rows: 3, maxlength: 4000 },
          (last && last.rationale) || '',
        ),
      ),
    ),
    el(
      'fieldset',
      null,
      el('legend', null, 'Manual LBank Spot trade plan (PLAN_READY only)'),
      el(
        'p',
        { class: 'small muted wide' },
        'You choose every price. Validation only checks completeness and stop < entry < TP1 < TP2 < TP3; the stop % and the 7 × 24 h time exit are derived. No sizing, order type or execution exists here.',
      ),
      field(
        'Entry price (USD)',
        input('rv-entryPrice', { inputmode: 'decimal', value: plan.entryPrice || '' }),
      ),
      field(
        'Entry time (UTC)',
        input('rv-entryTime', {
          type: 'datetime-local',
          value: plan.entryTime ? plan.entryTime.slice(0, 16) : '',
        }),
      ),
      field(
        'Stop price (USD)',
        input('rv-stopPrice', { inputmode: 'decimal', value: plan.stopPrice || '' }),
        plan.stopPct ? `stop ${Number(plan.stopPct).toFixed(2)}% below entry` : null,
      ),
      [0, 1, 2].map((i) => [
        field(
          `TP${i + 1} price`,
          input(`rv-tp${i}-price`, { inputmode: 'decimal', value: tp(i, 'price') }),
        ),
        field(
          `TP${i + 1} allocation %`,
          input(`rv-tp${i}-alloc`, { inputmode: 'decimal', value: tp(i, 'allocationPct') }),
        ),
      ]),
      field(
        'Plan notes',
        el('textarea', { id: 'rv-notes', rows: 2, maxlength: 2000 }, plan.notes || ''),
      ),
      plan.deadline ? el('div', { class: 'small wide' }, `Time exit: ${utc(plan.deadline)}`) : null,
    ),
    el(
      'div',
      { class: 'row-actions' },
      el(
        'button',
        { type: 'submit', class: 'btn primary', disabled: !can('review:write') },
        last ? 'Save new revision' : 'Save review',
      ),
      can('review:write')
        ? null
        : el('span', { class: 'muted small' }, 'Your role can read reviews but not record them.'),
    ),
    out,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void submitReview(t);
  });
  return el(
    'section',
    { class: 'panel review-panel' },
    el(
      'div',
      { class: 'panel-head' },
      el('h3', null, 'Your review'),
      el(
        'span',
        { class: 'hint' },
        last ? `revision ${last.revision} saved for this batch` : `for batch ${shortId(r.batchId)}`,
      ),
    ),
    form,
  );
}

async function submitReview(t) {
  const r = t.record;
  const v = (id) => {
    const e = $(id);
    return e && e.value.trim() ? e.value.trim() : undefined;
  };
  const reviewer = savedReviewer();
  const targets = [0, 1, 2]
    .map((i) => ({ price: v(`rv-tp${i}-price`), allocationPct: v(`rv-tp${i}-alloc`) }))
    .filter((x) => x.price || x.allocationPct);
  const entryTime = v('rv-entryTime');
  const plan = {
    entryPrice: v('rv-entryPrice'),
    entryTime: entryTime ? new Date(`${entryTime}:00Z`).toISOString() : undefined,
    stopPrice: v('rv-stopPrice'),
    targets: targets.length ? targets : undefined,
    notes: v('rv-notes'),
  };
  const hasPlan = Object.values(plan).some((x) => x !== undefined);
  const body = {
    cmcId: r.cmcId,
    batchId: r.batchId,
    reviewer,
    venueDecision: v('rv-venueDecision'),
    venueNote: v('rv-venueNote'),
    eventDay: v('rv-eventDay'),
    lbankPair: v('rv-lbankPair'),
    chartExchange: v('rv-chartExchange'),
    chartSymbol: v('rv-chartSymbol'),
    chartQuote: v('rv-chartQuote'),
    chartUrl: v('rv-chartUrl'),
    chartTimezone: v('rv-chartTimezone'),
    chartProxyReason: v('rv-chartProxyReason'),
    rangeLow: v('rv-rangeLow'),
    chartHistory: v('rv-chartHistory'),
    priorPumpResponse: v('rv-priorPumpResponse'),
    candleState: v('rv-candleState'),
    marketRegime: v('rv-marketRegime'),
    finalDecision: v('rv-finalDecision'),
    rationale: v('rv-rationale'),
    plan: hasPlan ? plan : undefined,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  try {
    const res = await apiPost('reviews', body);
    const val = res.validation;
    const msg = `Saved revision ${res.review.revision}${val.planStatus ? `, plan ${val.planStatus}` : ''}`;
    renderTrace(await api(`assets/${r.cmcId}/trace?batchId=${r.batchId}`));
    put(
      $('rv-result'),
      el(
        'div',
        {
          class: val.planStatus === 'INCOMPLETE' || val.errors.length ? 'banner inline' : 'note-ok',
        },
        `${msg}.`,
        val.errors.length
          ? el(
              'ul',
              { class: 'notes' },
              val.errors.map((x) => el('li', null, x)),
            )
          : null,
        val.warnings.length
          ? el(
              'ul',
              { class: 'notes' },
              val.warnings.map((x) => el('li', null, x)),
            )
          : null,
      ),
    );
    toast(`${msg}.`, val.errors.length ? 'warning' : 'ok');
  } catch (e) {
    put($('rv-result'), el('div', { class: 'error' }, `Not saved: ${e.message}`));
    toast(`Review not saved: ${e.message}`, 'error');
  }
}

/* ============================== Coin search (⌘K) ============================== */

const P = { open: false, items: [], active: 0, timer: null, seq: 0 };

function openPalette() {
  P.open = true;
  P.returnFocus = document.activeElement;
  $('palette').hidden = false;
  const inp = $('palette-input');
  inp.value = '';
  renderPalette([], 'Type a symbol, a name or a CMC id.');
  inp.focus();
}
function closePalette() {
  P.open = false;
  $('palette').hidden = true;
  if (P.returnFocus && document.contains(P.returnFocus)) P.returnFocus.focus();
}
function renderPalette(items, hint) {
  P.items = items;
  P.active = 0;
  const list = $('palette-list');
  if (!items.length)
    return put(list, el('li', { class: 'palette-hint' }, hint || 'No coin matches.'));
  put(
    list,
    items.map((a, i) =>
      el(
        'li',
        {
          role: 'option',
          id: `pal-${i}`,
          'aria-selected': String(i === 0),
          onclick: () => pickPalette(i),
          onpointerenter: () => setActive(i),
        },
        logo(a.cmcId, 24),
        el('div', { class: 'coin-text' }, el('b', null, a.symbol), el('span', null, a.name)),
        el('span', { class: 'muted small' }, `CMC ${a.cmcId}`),
      ),
    ),
  );
  $('palette-input').setAttribute('aria-activedescendant', 'pal-0');
}
function setActive(i) {
  P.active = i;
  $('palette-list')
    .querySelectorAll('[role=option]')
    .forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
  $('palette-input').setAttribute('aria-activedescendant', `pal-${i}`);
  const li = $(`pal-${i}`);
  if (li) li.scrollIntoView({ block: 'nearest' });
}
function pickPalette(i) {
  const a = P.items[i];
  if (!a) return;
  closePalette();
  void openAsset(a.cmcId, null, $('search-open'));
}
async function searchPalette(q) {
  const seq = ++P.seq;
  if (!q) return renderPalette([], 'Type a symbol, a name or a CMC id.');
  try {
    const d = await api(`assets?search=${encodeURIComponent(q)}&limit=8`);
    if (seq === P.seq) renderPalette(d.assets || [], `No coin matches “${q}”.`);
  } catch (e) {
    if (seq === P.seq) renderPalette([], `Search failed: ${e.message}`);
  }
}

/* ============================== Runs & health, exports ============================== */

function drawBatchBars(W, batches) {
  const H = 120;
  const m = { l: 4, r: 4, t: 10, b: 22 };
  const rows = [...batches].reverse();
  const n = rows.length;
  const step = (W - m.l - m.r) / Math.max(n, 1);
  const bw = Math.max(3, Math.min(26, step * 0.66));
  const max = Math.max(...rows.map((b) => b.listedTotal || b.collected || 0), 1);
  const root = svg('svg', {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    class: 'chart batch-bars',
    role: 'img',
    'aria-label': `${n} hourly batches.`,
  });
  rows.forEach((b, i) => {
    const x = m.l + i * step + (step - bw) / 2;
    const full = ((b.listedTotal || 0) / max) * (H - m.t - m.b);
    const got = ((b.collected || 0) / max) * (H - m.t - m.b);
    root.append(
      svg('rect', {
        class: 'bb-track',
        x,
        y: H - m.b - full,
        width: bw,
        height: Math.max(1, full),
        rx: 3,
      }),
    );
    root.append(
      svg('rect', {
        class: `bb-fill ${(b.status || '').toLowerCase()}`,
        x,
        y: H - m.b - got,
        width: bw,
        height: Math.max(1, got),
        rx: 3,
      }),
    );
    const hit = svg('rect', {
      class: 'hit',
      x: m.l + i * step,
      y: 0,
      width: step,
      height: H - m.b,
    });
    const tipRows = () => [
      tipHead(fmtTime(b.slotTime)),
      tipRow('Status', (BATCH[b.status] || [0, b.status])[1]),
      tipRow('Collected', `${fmtInt(b.collected)} of ${fmtInt(b.listedTotal)}`),
      b.scan && b.scan.counts ? tipRow('Queue', fmtInt(b.scan.counts.queue)) : null,
    ];
    hit.addEventListener('pointerenter', (e) => showTip(tipRows(), e.clientX, e.clientY));
    hit.addEventListener('pointermove', (e) => showTip(tipRows(), e.clientX, e.clientY));
    hit.addEventListener('pointerleave', hideTip);
    root.append(hit);
  });
  if (n) {
    root.append(svg('text', { class: 'tick', x: m.l, y: H - 6 }, fmtTime(rows[0].slotTime)));
    if (n > 1)
      root.append(
        svg(
          'text',
          { class: 'tick', x: W - m.r, y: H - 6, 'text-anchor': 'end' },
          fmtTime(rows[n - 1].slotTime),
        ),
      );
  }
  return root;
}

function renderGantt(run) {
  const stages = ((run && run.stages) || []).filter((s) => s.startedAt);
  if (!stages.length) return put($('gantt'), el('div', { class: 'empty' }, 'No run yet.'));
  const t0 = Math.min(...stages.map((s) => new Date(s.startedAt).getTime()));
  const t1 = Math.max(...stages.map((s) => new Date(s.finishedAt || Date.now()).getTime()));
  const span = Math.max(1, t1 - t0);
  $('gantt-meta').textContent = `slot ${fmtTime(run.slotTime)}, ${fmtSpan(span / 1000)} in total`;
  const order = STAGES.map(([s]) => s);
  stages.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
  put(
    $('gantt'),
    el(
      'div',
      { class: 'gantt' },
      stages.map((s) => {
        const a = new Date(s.startedAt).getTime(),
          b = new Date(s.finishedAt || Date.now()).getTime();
        const bar = el('i', { class: s.status });
        bar.style.left = `${((a - t0) / span) * 100}%`;
        bar.style.width = `${Math.max(0.6, ((b - a) / span) * 100)}%`;
        return el(
          'div',
          { class: 'gantt-row', title: s.error || '' },
          el(
            'span',
            { class: 'gantt-name' },
            (STAGES.find(([k]) => k === s.stage) || [0, s.stage])[1],
          ),
          el('span', { class: 'gantt-track' }, bar),
          el('span', { class: 'gantt-dur' }, s.finishedAt ? fmtMs(b - a) : 'running'),
        );
      }),
    ),
  );
}

async function loadBatches() {
  const [batches, health, tasks] = await Promise.all([
    api('batches'),
    api('health'),
    api('mapping-tasks?status=OPEN'),
  ]);
  const cov = health.coverage,
    h = cov.sourceHealth || {};
  const budget = cov.monthlyRequestBudget || 0;
  const used = h.budgetUsed || 0;
  const budgetRing = ring(
    64,
    budget ? used / budget : 0,
    used / (budget || 1) > 0.85 ? 'rose' : 'base',
  );
  put(
    $('health-tiles'),
    el(
      'div',
      { class: 'tile' },
      el('span', { class: 'tile-label' }, 'Source'),
      el('b', null, cov.provider ? cov.provider.name : '—'),
      el('span', { class: 'muted small' }, cov.isLiveData ? 'live data' : 'synthetic'),
    ),
    el(
      'div',
      { class: 'tile' },
      el('span', { class: 'tile-label' }, 'Circuit'),
      el(
        'b',
        null,
        lab(
          {
            CLOSED: ['good', 'Closed'],
            OPEN: ['critical', 'Open'],
            HALF_OPEN: ['warning', 'Half open'],
          },
          String(h.state || '').toUpperCase(),
        ),
      ),
      el(
        'span',
        { class: 'muted small' },
        h.lastSuccessAt ? `last success ${fmtAgo(h.lastSuccessAt)}` : '',
      ),
    ),
    el(
      'div',
      { class: 'tile with-ring' },
      budgetRing.node,
      el(
        'div',
        null,
        el('span', { class: 'tile-label' }, 'Requests this month'),
        el('b', null, fmtInt(used)),
        el(
          'span',
          { class: 'muted small' },
          budget ? `of ${fmtInt(budget)} local budget` : 'no budget',
        ),
      ),
    ),
    el(
      'div',
      { class: 'tile' },
      el('span', { class: 'tile-label' }, 'Known CMC coins'),
      el('b', null, fmtInt(cov.knownAssets)),
      el(
        'span',
        { class: 'muted small' },
        cov.lastDiscovery
          ? `discovered ${fmtAgo(cov.lastDiscovery.finishedAt || cov.lastDiscovery.startedAt)}`
          : '',
      ),
    ),
  );
  renderGantt(S.overview && S.overview.latestRun);
  const bc = el('div', { class: 'chart-box' });
  put($('batch-chart'), bc);
  if (batches.length) mount(bc, (W) => drawBatchBars(W, batches));
  put(
    $('batches'),
    table(
      [
        { label: 'Slot', render: (b) => fmtTime(b.slotTime) },
        { label: 'Batch', render: (b) => lab(BATCH, b.status) },
        {
          label: 'Collected',
          num: true,
          render: (b) => `${fmtInt(b.collected)} / ${fmtInt(b.listedTotal)}`,
        },
        {
          label: 'Ranks 1–1200',
          render: (b) =>
            b.missingRanks.length || b.duplicateRanks.length
              ? `${b.missingRanks.length} missing, ${b.duplicateRanks.length} duplicate`
              : 'contiguous',
        },
        { label: 'Scan', render: (b) => (b.scan ? lab(RUN, b.scan.status) : '—') },
        {
          label: 'Queue',
          render: (b) =>
            b.scan && b.scan.queueStatus
              ? `${(QUEUE[b.scan.queueStatus] || [0, b.scan.queueStatus])[1]}, ${fmtInt((b.scan.counts || {}).queue)}`
              : '—',
        },
        {
          label: 'Eligible / review / excluded',
          render: (b) =>
            b.scan && b.scan.counts
              ? `${fmtInt(b.scan.counts.eligible)} / ${fmtInt(b.scan.counts.needsReview)} / ${fmtInt(b.scan.counts.excluded)}`
              : '—',
        },
        { label: 'Export', render: (b) => (b.scan ? b.scan.exportStatus || '—' : '—') },
        {
          label: 'Notes',
          render: (b) =>
            el(
              'span',
              { class: 'small' },
              [
                ...(b.statusReasons || []),
                ...((b.scan && b.scan.warnings) || []).map((w) => w.split(':')[0]),
              ].join(', '),
            ),
        },
      ],
      batches,
      { empty: 'No crawl batches yet.' },
    ),
  );
  put(
    $('tasks'),
    table(
      [
        {
          label: 'Coin',
          render: (x) =>
            el(
              'button',
              {
                type: 'button',
                class: 'linkish',
                onclick: (e) => openAsset(x.cmcId, null, e.currentTarget),
              },
              `CMC ${x.cmcId}`,
            ),
        },
        { label: 'LBank pair', render: (x) => x.marketPair },
        { label: 'Kind', render: (x) => x.kind },
        {
          label: 'Evidence',
          render: (x) => el('span', { class: 'small' }, JSON.stringify(x.evidence)),
        },
        { label: 'Since', render: (x) => fmtTime(x.createdAt) },
      ],
      tasks,
      { empty: 'No open mapping tasks.' },
    ),
  );
  put(
    $('runs'),
    table(
      [
        { label: 'Slot', render: (r) => fmtTime(r.slotTime) },
        { label: 'Kind', render: (r) => r.kind },
        { label: 'Status', render: (r) => lab(RUN, r.status) },
        {
          label: 'Stages',
          render: (r) =>
            el(
              'span',
              { class: 'stage-dots' },
              STAGES.map(([s, label]) => {
                const st = (r.stages || []).find((x) => x.stage === s);
                return el('i', {
                  class: st ? st.status : 'none',
                  title: `${label}: ${st ? st.status : 'not run'}`,
                });
              }),
            ),
        },
        { label: 'Error', render: (r) => el('span', { class: 'small error' }, r.error || '') },
      ],
      health.runs,
      { empty: 'No runs yet.' },
    ),
  );
}

async function loadExports() {
  const rows = await api('exports');
  $('exports-meta').textContent = rows.length ? `${rows.length} batches` : '';
  put(
    $('exports'),
    table(
      [
        {
          label: 'Batch',
          render: (x) =>
            `${fmtTime(x.asOf)}, ${shortId(x.batchId)}${x.isLive ? '' : ', synthetic'}`,
        },
        {
          label: 'Status',
          render: (x) =>
            x.exportStatus === 'succeeded'
              ? statusLabel('good', 'Exported')
              : statusLabel('critical', `Failed: ${x.error || ''}`),
        },
        { label: 'Queue', render: (x) => (QUEUE[x.queueStatus] || [0, x.queueStatus || '—'])[1] },
        {
          label: 'Files',
          render: (x) =>
            x.available
              ? el(
                  'span',
                  { class: 'files' },
                  (x.exportFiles || []).map((f) =>
                    el(
                      'a',
                      {
                        class: 'chip link-chip',
                        href: `/api/exports/${x.batchId}/${f.name}`,
                        title: `sha256 ${f.sha256}`,
                      },
                      `${f.name} (${fmtInt(f.rows)})`,
                    ),
                  ),
                  el(
                    'a',
                    { class: 'chip link-chip', href: `/api/exports/${x.batchId}/manifest.json` },
                    'manifest.json',
                  ),
                )
              : el('span', { class: 'muted' }, 'files pruned (the database keeps the results)'),
        },
      ],
      rows,
      { empty: 'No exports yet.' },
    ),
  );
}

/* ============================== Forward test ============================== */

const FWD_STATUS = {
  OPEN: ['', 'Open'],
  TRACKING: ['accent', 'Tracking'],
  AWAITING_FINAL_DAY: ['warning', 'Awaiting final day'],
  FINAL: ['good', 'Final'],
  INCOMPLETE: ['serious', 'Incomplete'],
};
const FWD_PAGE = 100;
const FWD_FLAG_TEXT = {
  INCOMPLETE_DAY0: 'day 0 not provable',
  DAY0_UNRESOLVED: 'day 0 open',
  FINAL_DAY_PENDING: 'final day pending',
  HIGH_MISSING: 'High missing',
  HIGH_INVALID: 'High invalid',
  PEAK_TIE_UNOBSERVED_DAY0: 'tie with day 0',
  CONTRACT_EVIDENCE_CHANGED: 'contract changed',
};

/** Percent for display only (the API and exports keep every digit). */
function fmtPct(x) {
  x = num(x);
  if (!isNum(x)) return '—';
  const a = Math.abs(x);
  return `${x > 0 ? '+' : ''}${x.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2)}%`;
}
function fwdFlag(code) {
  const [k, ...rest] = String(code).split(':');
  return `${FWD_FLAG_TEXT[k] || k.replace(/_/g, ' ').toLowerCase()}${rest.length ? ` ${rest.join(':')}` : ''}`;
}
function fwdReturn(r) {
  const o = r.outcome;
  if (!o || o.peakReturnPct === null) return el('span', { class: 'muted' }, '—');
  const exact = o.peakKind === 'EXACT';
  return el(
    'span',
    {
      class: exact ? 'fwd-ret' : 'fwd-ret provisional',
      title: exact
        ? 'Final: every included day covered. Highest later High ÷ detection price − 1.'
        : 'Provisional lower bound: the window is still open, the final day is pending or a day is not covered.',
    },
    `${exact ? '' : '≥ '}${fmtPct(o.peakReturnPct)}`,
  );
}
function fwdPeak(r) {
  const o = r.outcome;
  if (!o || !o.peakHighUsd) return el('span', { class: 'muted' }, '—');
  return el(
    'div',
    { class: 'fwd-peak' },
    el('b', null, fmtPrice(o.peakHighUsd)),
    el(
      'span',
      {
        class: 'muted small',
        title:
          o.peakTimePrecision === 'UTC_DAY'
            ? 'Only the UTC day of this High is known.'
            : 'Time of the High as published by the source.',
      },
      o.peakAt ? fmtTime(o.peakAt) : `${fmtDay(o.peakDate)}, time unknown`,
    ),
    o.extensionPeakFlag === 'TRUE'
      ? chip('after 168 h', { title: 'Inside the end-of-day extension.' })
      : o.extensionPeakFlag === 'UNKNOWN'
        ? chip('168 h?', { title: 'The time precision cannot show whether this came after 168 h.' })
        : null,
  );
}
/** The scanner's 3d / 7d / 30d results at detection, compact (multiples, YES in colour). */
function fwdWindows(r) {
  return el(
    'span',
    { class: 'fwd-windows' },
    [
      ['3d', r.pass3d, r.multiple3d],
      ['7d', r.pass7d, r.multiple7d],
      ['30d', r.pass30d, r.multiple30d],
    ].map(([d, status, m]) =>
      el(
        'span',
        { class: `pass ${status === 'YES' ? 'yes' : status === 'NO' ? 'no' : 'na'}`, title: `${d}: ${status}` },
        el('b', null, status === 'N/A' ? 'N/A' : fmtMult(m)),
      ),
    ),
  );
}
const fwdCols = () => [
  { label: 'Coin', render: coinCell },
  { label: 'Stars', render: (r) => stars(r.starCount) },
  {
    label: 'Points',
    num: true,
    title: 'Weighted points at detection (weighted_star_v1)',
    render: (r) => pointsCell(r.weightedPassPoints, r.scoreComplete, r.weightedStrength),
  },
  {
    label: 'Detected',
    render: (r) =>
      el('span', { title: `${utc(r.detectedAt)} (UTC date ${r.detectedUtcDate})` }, fmtTime(r.detectedAt)),
  },
  {
    label: 'Price',
    num: true,
    title: 'CMC USD price of the qualifying scan: a reference, not a fill',
    render: (r) => fmtPrice(r.referencePriceUsd),
  },
  { label: 'Highest High', render: fwdPeak },
  { label: 'Return', num: true, render: fwdReturn },
  { label: 'Status', render: (r) => lab(FWD_STATUS, r.status) },
  {
    label: 'Days',
    num: true,
    title: 'Included days with an eligible High / completed included days (8 in all)',
    render: (r) => (r.outcome ? `${r.outcome.coveredDays}/${r.outcome.completedDays}` : '0/0'),
  },
  {
    label: 'Window ends',
    render: (r) =>
      el(
        'span',
        {
          title: `168 h at ${utc(r.deadline168h)}; included until ${utc(r.evaluationEnd)} (${Number(r.effectiveHorizonHours).toFixed(1)} h)`,
        },
        fmtTime(r.evaluationEnd),
      ),
  },
  { label: '3d · 7d · 30d', title: 'Scanner results at detection', render: fwdWindows },
  {
    label: 'Notes',
    render: (r) =>
      el(
        'span',
        { class: 'chips' },
        r.qualityFlags.map((f) =>
          chip(fwdFlag(f), { tone: /^(INCOMPLETE|HIGH_)/.test(f) ? 'warn' : null, title: f }),
        ),
        r.overlappingEventIds.length
          ? chip(`${r.overlappingEventIds.length} overlapping`, {
              title: 'Other events of this coin with overlapping windows: correlated, not independent.',
            })
          : null,
      ),
  },
];

/** 24 columns, one per UTC hour of detection. */
function hourColumns(values) {
  const max = Math.max(1, ...values);
  return el(
    'div',
    { class: 'fwd-hours' },
    values.map((v, h) => {
      const bar = el('i', { title: `${String(h).padStart(2, '0')}:00 UTC: ${v} events` });
      bar.style.height = `${Math.max(v ? 6 : 2, (v / max) * 100)}%`;
      return el(
        'span',
        null,
        el('b', null, bar),
        el('small', null, h % 6 === 0 ? String(h).padStart(2, '0') : ''),
      );
    }),
  );
}

function renderForwardSummary(s) {
  const by = s.counts.byStatus;
  const active = by.OPEN + by.TRACKING + by.AWAITING_FINAL_DAY;
  $('count-forward').textContent = fmtInt(active);
  put(
    $('forward-note'),
    // The synthetic-data banner is already shown for the whole dashboard.
    s.warnings
      .filter((w) => !w.startsWith('SYNTHETIC'))
      .map((w) => el('div', { class: 'banner inline' }, w)),
    el('p', { class: 'muted small fwd-notice' }, s.notice),
  );
  const last = s.lastUpdate;
  put(
    $('forward-tiles'),
    el(
      'div',
      { class: 'tile' },
      el('span', { class: 'tile-label' }, 'Events'),
      el('b', null, fmtInt(s.counts.events)),
      el('span', { class: 'muted small' }, `on ${fmtInt(s.counts.watchlistAssets)} coins`),
    ),
    el(
      'div',
      { class: 'tile' },
      el('span', { class: 'tile-label' }, 'Active · Final · Incomplete'),
      el('b', null, `${fmtInt(active)} · ${fmtInt(by.FINAL)} · ${fmtInt(by.INCOMPLETE)}`),
      el('span', { class: 'muted small' }, `${fmtInt(by.AWAITING_FINAL_DAY)} awaiting the final day`),
    ),
    el(
      'div',
      { class: 'tile' },
      el('span', { class: 'tile-label' }, 'Daily High update'),
      el('b', null, last ? lab(RUN, last.status) : 'Not yet'),
      el(
        'span',
        { class: 'muted small' },
        last ? `${fmtAgo(last.startedAt)}, for ${fmtDay(last.updateDate)}` : 'after the first UTC day closes',
      ),
    ),
    el(
      'div',
      { class: 'tile' },
      el('span', { class: 'tile-label' }, 'High coverage'),
      el(
        'b',
        null,
        `${fmtInt(s.coverage.coveredDays)} / ${fmtInt(s.coverage.completedDays)} days`,
      ),
      el(
        'span',
        { class: 'muted small' },
        `${fmtInt(s.coverage.missingDays)} missing, ${fmtInt(s.coverage.day0Unresolved)} with day 0 unproven`,
      ),
    ),
  );
  const groupLabel = (g) => (g.group === 'all' ? el('b', null, 'All') : stars(Number(g.group)));
  put(
    $('forward-cohorts'),
    table(
      [
        { label: 'Group', render: groupLabel },
        { label: 'Events', num: true, render: (g) => fmtInt(g.events) },
        { label: 'Coins', num: true, render: (g) => fmtInt(g.distinctAssets) },
        { label: 'Final', num: true, render: (g) => fmtInt(g.final) },
        { label: 'Pending', num: true, render: (g) => fmtInt(g.pending) },
        { label: 'Incomplete', num: true, render: (g) => fmtInt(g.incomplete) },
        { label: 'Median', num: true, render: (g) => fmtPct(g.finalReturns.median) },
        { label: 'Mean', num: true, render: (g) => fmtPct(g.finalReturns.mean) },
        {
          label: 'P25 – P75',
          num: true,
          render: (g) =>
            g.finalReturns.n ? `${fmtPct(g.finalReturns.p25)} – ${fmtPct(g.finalReturns.p75)}` : '—',
        },
        {
          label: 'Min – max',
          num: true,
          render: (g) =>
            g.finalReturns.n ? `${fmtPct(g.finalReturns.min)} – ${fmtPct(g.finalReturns.max)}` : '—',
        },
        {
          label: 'Correlated',
          title: 'Coins with several events, and overlapping same-coin windows',
          render: (g) =>
            `${fmtInt(g.correlation.assetsWithMultipleEvents)} coins · ${fmtInt(g.correlation.sameAssetOverlaps)} overlaps`,
        },
      ],
      s.cohort,
    ),
  );
  const groupCols = [
    { label: 'Group', render: (g) => el('b', null, g.group) },
    { label: 'Events', num: true, render: (g) => fmtInt(g.events) },
    { label: 'Coins', num: true, render: (g) => fmtInt(g.distinctAssets) },
    { label: 'Final', num: true, render: (g) => fmtInt(g.final) },
    { label: 'Pending', num: true, render: (g) => fmtInt(g.pending) },
    { label: 'Incomplete', num: true, render: (g) => fmtInt(g.incomplete) },
    {
      label: 'Median',
      num: true,
      title: 'Median final peak return (FINAL events only); mean, p25 and p75 are in the export',
      render: (g) => fmtPct(g.finalReturns.median),
    },
  ];
  put($('forward-patterns'), table(groupCols, s.cohortByPattern || [], { empty: 'No events yet.' }));
  put($('forward-bands'), table(groupCols, s.cohortByPointsBand || [], { empty: 'No events yet.' }));
  const all = s.cohort.find((g) => g.group === 'all');
  put(
    $('forward-dist'),
    all && all.finalReturns.n
      ? hbars(all.returnDistribution.map((b) => ({ label: b.label, value: b.count })))
      : el('div', { class: 'empty' }, 'No FINAL event yet: an event finishes the day after its window ends.'),
  );
  put($('forward-hours'), all && all.events ? hourColumns(all.detectionHourUtc) : el('div', { class: 'empty' }, 'No events yet.'));
  put(
    $('forward-actions'),
    can('exports:read')
      ? ['workbook.xlsx', 'events_final.csv', 'events_active.csv', 'cohort_summary.csv'].map((f) =>
          el('a', { class: 'chip link-chip', href: `/api/forward/export/${f}` }, f),
        )
      : null,
    can('scan:operate')
      ? el('button', { type: 'button', class: 'btn', onclick: (e) => void forwardUpdateNow(e) }, 'Update Highs now')
      : null,
  );
}

async function loadForward() {
  const st = S.forward;
  const q = new URLSearchParams({
    view: st.view,
    limit: String(FWD_PAGE),
    offset: String(st.page * FWD_PAGE),
  });
  if (st.stars) q.set('stars', st.stars);
  if (st.search) q.set('search', st.search);
  const [sum, ev, rej] = await Promise.all([
    api('forward'),
    api(`forward/events?${q}`),
    api('forward/rejections?limit=50'),
  ]);
  renderForwardSummary(sum);
  put(
    $('forward-events'),
    table(fwdCols(), ev.rows, {
      empty: st.search
        ? `No event matches “${st.search}”.`
        : st.view === 'active'
          ? 'No active event. Eligible 1, 2 and 3-star coins of a published queue are recorded automatically.'
          : 'No events in this view.',
      onRow: (r, tr) => openAsset(r.cmcId, null, tr),
    }),
  );
  pager($('forward-pager'), {
    page: st.page,
    pageSize: FWD_PAGE,
    total: ev.total,
    unit: 'events',
    onPage: (pg) => {
      st.page = pg;
      void loadForward().catch(showError('forward-events'));
    },
  });
  put(
    $('forward-rejections'),
    table(
      [
        { label: 'Batch', render: (r) => fmtTime(r.slotTime) },
        {
          label: 'Coin',
          render: (r) => (r.cmcId ? `${r.symbol || ''} (${r.cmcId})` : el('span', { class: 'muted' }, 'no CMC id')),
        },
        { label: 'Stars', render: (r) => (r.starCount >= 1 && r.starCount <= 3 ? stars(r.starCount) : String(r.starCount)) },
        {
          label: 'Reasons',
          render: (r) => el('span', { class: 'chips' }, r.reasons.map((x) => chip(reasonText(x), { title: x }))),
        },
      ],
      rej,
      { empty: 'No rejected trigger.' },
    ),
  );
}

async function forwardUpdateNow(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const r = await apiPost('forward/update');
    if (!r.ok) toast(r.reason || 'The update did not run.', 'warning');
    else toast(`Highs updated: ${r.update.outcomes.versions} outcomes changed, ${r.update.newlyFinal} newly final.`);
    await loadForward();
  } catch (err) {
    toast(`Update failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

function setForwardSeg(id, attr, value) {
  $(id)
    .querySelectorAll('button')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === value)));
}

/* ============================== Telegram access ============================== */

let accessBusy = false;
const MISSED_STATE = {
  pending: ['accent', 'Queued'],
  retrying: ['warning', 'Retrying'],
  gave_up: ['critical', 'Gave up'],
  not_queued: ['', 'Not sent'],
};

function showAccessNote(kind, text) {
  put(
    $('access-note'),
    text ? el('div', { class: kind === 'error' ? 'banner inline' : 'note-ok' }, text) : null,
  );
}

async function changeAccess(action, chatId, doneMsg) {
  if (accessBusy) return;
  accessBusy = true;
  try {
    const r = await apiPost(`telegram/access/${action}`, { chatId });
    await loadAccess();
    if (action === 'approve' && r && r.notified === false)
      toast(
        `${doneMsg} Telegram would not deliver the welcome message: they must open the bot and press Start.`,
        'warning',
      );
    else toast(doneMsg);
  } catch (e) {
    toast(`Could not change access: ${e.message}`, 'error');
  } finally {
    accessBusy = false;
  }
}

async function deliveryAction(path, body, okMsg) {
  if (accessBusy) return;
  accessBusy = true;
  try {
    const r = await apiPost(path, body);
    const d = r.delivery;
    const outcome = d
      ? `${d.sent} sent${d.failed ? `, ${d.failed} failed` : ''}${d.deferred ? `, ${d.deferred} will retry` : ''}`
      : r.reason || ((r.queued ?? r.requeued) ? 'sending in the background' : 'nothing to send');
    toast(`${okMsg}: ${outcome}.`, d && d.failed ? 'warning' : 'ok');
  } catch (e) {
    toast(`Could not send: ${e.message}`, 'error');
  } finally {
    accessBusy = false;
  }
  await loadAccess().catch(() => undefined);
}

async function loadAccess() {
  const [a, missed] = await Promise.all([api('telegram/access'), api('telegram/missing')]);
  $('count-access').textContent = fmtInt(a.pending.length + missed.rows.length);
  const who = (r) =>
    el(
      'span',
      null,
      el('strong', null, r.label),
      ' ',
      el('span', { class: 'muted small' }, `id ${r.chatId}`),
    );
  const act = (label, cls, fn) =>
    el(
      'button',
      {
        type: 'button',
        class: `btn small${cls ? ` ${cls}` : ''}`,
        disabled: !a.canManage,
        onclick: fn,
      },
      label,
    );
  put(
    $('access-missed'),
    table(
      [
        { label: 'Report hour', render: (r) => fmtTime(r.slotTime) },
        { label: 'Person', render: who },
        {
          label: 'State',
          render: (r) =>
            statusLabel(
              (MISSED_STATE[r.state] || [])[0],
              (MISSED_STATE[r.state] || [0, r.state])[1],
            ),
        },
        { label: 'Parts', render: (r) => (r.partCount ? `${r.partsSent}/${r.partCount}` : '—') },
        {
          label: 'Why',
          render: (r) =>
            r.state === 'not_queued'
              ? 'no copy was queued for this person'
              : r.lastError || 'waiting to be sent',
        },
        {
          label: '',
          render: (r) =>
            act(
              r.state === 'not_queued' ? 'Send' : 'Retry',
              '',
              () =>
                void (r.state === 'not_queued'
                  ? deliveryAction(
                      'telegram/send',
                      { runId: r.runId, chatIds: [r.chatId] },
                      `Sent to ${r.label}`,
                    )
                  : deliveryAction(
                      'telegram/retry',
                      { runId: r.runId, chatId: r.chatId },
                      `Retried ${r.label}`,
                    )),
            ),
        },
      ],
      missed.rows,
      {
        empty:
          missed.mode === 'live'
            ? 'No missed reports in the last 6 hours.'
            : `Telegram is ${missed.mode}: nothing is sent.`,
      },
    ),
  );
  $('missed-retry-all').disabled =
    !a.canManage || !missed.rows.some((r) => r.state !== 'not_queued');
  $('send-latest-all').disabled = !a.canManage || missed.mode !== 'live';
  if (!a.canManage) showAccessNote('error', 'Your role can see but not change Telegram access.');
  else if (a.mode !== 'live' || !a.commandsEnabled)
    showAccessNote(
      'ok',
      `Telegram is ${a.mode}${a.commandsEnabled ? '' : ' and bot commands are off'}: new people can only ask for access when the app runs with TELEGRAM_MODE=live.`,
    );
  else showAccessNote('ok', '');
  const when = { label: 'Since', render: (r) => (r.at ? fmtTime(r.at) : '') };
  put(
    $('access-pending'),
    table(
      [
        { label: 'Person', render: who },
        when,
        {
          label: '',
          render: (r) =>
            el(
              'div',
              { class: 'row-actions' },
              act('Approve', 'primary', () =>
                changeAccess('approve', r.chatId, `Approved ${r.label}.`),
              ),
              act('Reject', 'danger', () =>
                changeAccess('reject', r.chatId, `Rejected ${r.label}.`),
              ),
            ),
        },
      ],
      a.pending,
      { empty: 'No pending requests.' },
    ),
  );
  put(
    $('access-members'),
    table(
      [
        { label: 'Person', render: who },
        when,
        {
          label: '',
          render: (r) =>
            r.owner
              ? el('span', { class: 'muted small' }, 'always allowed')
              : act('Remove', 'danger', () =>
                  changeAccess('remove', r.chatId, `Removed ${r.label}.`),
                ),
        },
      ],
      [{ chatId: a.owner || '—', label: 'Owner', at: null, owner: true }, ...a.members],
      { empty: 'No members.' },
    ),
  );
  put(
    $('access-denied'),
    table(
      [
        { label: 'Chat id', render: (r) => r.chatId },
        {
          label: '',
          render: (r) =>
            act('Allow again', '', () =>
              changeAccess('approve', r.chatId, `Approved ${r.chatId}.`),
            ),
        },
      ],
      a.denied.map((chatId) => ({ chatId })),
      { empty: 'Nobody rejected.' },
    ),
  );
}

/* ============================== Sign-in, account and users ============================== */

const ROLE_TEXT = {
  owner: ['Owner', 'Everything, including users, settings and the Telegram audience.'],
  analyzer: [
    'Analyzer',
    'Every data page, run health and exports; can reprocess a batch and refresh the LBank list.',
  ],
  reviewer: ['Reviewer', 'Market pages and coin details; records reviews and LBank decisions.'],
};
const PERMISSION_TEXT = {
  'data:read': 'See the overview, lists and coin details',
  'health:read': 'See runs, batches and source health',
  'exports:read': 'Download CSV and Excel exports',
  'review:write': 'Record reviews and LBank decisions',
  'scan:operate': 'Reprocess a batch, refresh the LBank list and retry a failed crawl',
  'telegram:manage': 'Manage Telegram members and re-send reports',
  'users:manage': 'Add, change and remove users',
  'settings:manage': 'Change the settings (schedule, source limits, retention, Telegram)',
};

function showAuth(mode, notice) {
  document.body.classList.add('signed-out');
  $('auth').hidden = false;
  if (!$('drawer').hidden) closeDrawer();
  if (P.open) closePalette();
  $('login-form').hidden = mode !== 'login';
  $('change-form').hidden = mode !== 'change';
  if (mode === 'login') {
    $('login-error').textContent = notice || '';
    $('login-password').value = '';
    ($('login-username').value ? $('login-password') : $('login-username')).focus();
  } else {
    $('change-error').textContent = '';
    $('cf-username').value = S.me ? S.me.username : '';
    for (const id of ['cf-current', 'cf-new', 'cf-repeat']) $(id).value = '';
    $('change-lead').textContent =
      S.me && S.me.username === 'owner' && S.me.role === 'owner'
        ? 'This is the first sign-in of the owner account. Choose your own username and password to continue.'
        : 'Your password is temporary. Choose your own to continue.';
    $('cf-current').focus();
  }
}
function hideAuth() {
  document.body.classList.remove('signed-out');
  $('auth').hidden = true;
}

/** Name, role and the sections the role may open. */
function applyUser() {
  if (!S.me) return;
  $('user-name').textContent = S.me.username;
  $('user-role').textContent = ROLE_TEXT[S.me.role][0];
  $('user-avatar').textContent = S.me.username.slice(0, 1).toUpperCase();
  for (const t of TABS) $(`t-${t}`).hidden = !tabAllowed(t);
}

async function signOut() {
  try {
    await apiPost('auth/logout', {});
  } catch {
    /* the cookie is cleared or already gone */
  }
  location.replace(location.pathname);
}

function setBusy(form, busy) {
  form.querySelectorAll('button, input, select').forEach((x) => {
    x.disabled = busy;
  });
}

/** A small modal form; resolves true after onSubmit succeeds, false when cancelled. */
function dialog({ title, body, ok = 'OK', danger = false, onSubmit }) {
  const box = $('dialog'),
    form = $('dialog-form');
  $('dialog-title').textContent = title;
  put($('dialog-body'), body);
  $('dialog-error').textContent = '';
  const okBtn = $('dialog-ok');
  okBtn.textContent = ok;
  okBtn.className = `btn ${danger ? 'danger solid' : 'primary'}`;
  box.hidden = false;
  const first = form.querySelector('input, select');
  (first || okBtn).focus();
  return new Promise((resolve) => {
    const close = (v) => {
      box.hidden = true;
      form.onsubmit = null;
      $('dialog-cancel').onclick = null;
      box.onkeydown = null;
      resolve(v);
    };
    $('dialog-cancel').onclick = () => close(false);
    box.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(false);
      }
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      setBusy(form, true);
      try {
        await onSubmit();
        close(true);
      } catch (err) {
        $('dialog-error').textContent = err.message;
      } finally {
        setBusy(form, false);
      }
    };
  });
}

async function loadUsers() {
  const users = await api('users');
  $('users-meta').textContent = `${users.length} ${users.length === 1 ? 'person' : 'people'}`;
  const status = (u) =>
    !u.isActive
      ? statusLabel('', 'Disabled')
      : u.lockedUntil
        ? statusLabel('critical', `Locked until ${fmtClock(u.lockedUntil)}`)
        : u.mustChangePassword
          ? statusLabel('warning', 'Must set password')
          : statusLabel('good', 'Active');
  put(
    $('users-table'),
    table(
      [
        {
          label: 'User',
          render: (u) =>
            el(
              'div',
              { class: 'coin' },
              el(
                'span',
                { class: `avatar ${u.role}`, 'aria-hidden': 'true' },
                u.username.slice(0, 1).toUpperCase(),
              ),
              el(
                'div',
                { class: 'coin-text' },
                el(
                  'b',
                  null,
                  u.username,
                  u.id === S.me.id ? el('span', { class: 'chip you' }, 'you') : null,
                ),
                el('span', null, `added ${fmtTime(u.createdAt, { year: true })}`),
              ),
            ),
        },
        {
          label: 'Role',
          render: (u) => {
            const sel = el(
              'select',
              { 'aria-label': `Role of ${u.username}`, disabled: u.id === S.me.id },
              Object.entries(ROLE_TEXT).map(([k, [label]]) =>
                el('option', { value: k, selected: k === u.role }, label),
              ),
            );
            sel.addEventListener('change', async () => {
              try {
                await apiPatch(`users/${u.id}`, { role: sel.value });
                toast(
                  `${u.username} is now ${ROLE_TEXT[sel.value][0].toLowerCase()}. Their sessions were ended.`,
                );
              } catch (e) {
                toast(e.message, 'error');
              }
              await loadUsers();
            });
            return sel;
          },
        },
        { label: 'Status', render: status },
        {
          label: 'Last sign-in',
          render: (u) =>
            u.lastLoginAt ? fmtAgo(u.lastLoginAt) : el('span', { class: 'muted' }, 'never'),
        },
        {
          label: '',
          render: (u) =>
            el(
              'div',
              { class: 'row-actions' },
              el(
                'button',
                { type: 'button', class: 'btn small', onclick: () => resetPasswordDialog(u) },
                'Reset password',
              ),
              u.id === S.me.id
                ? null
                : el(
                    'button',
                    { type: 'button', class: 'btn small', onclick: () => toggleActive(u) },
                    u.isActive ? 'Disable' : 'Enable',
                  ),
              u.id === S.me.id
                ? null
                : el(
                    'button',
                    {
                      type: 'button',
                      class: 'btn small danger',
                      onclick: () => deleteUserDialog(u),
                    },
                    'Delete',
                  ),
            ),
        },
      ],
      users,
      { empty: 'No users.' },
    ),
  );
  put(
    $('role-matrix'),
    el(
      'div',
      { class: 'role-matrix' },
      Object.entries(ROLE_TEXT).map(([k, [label, text]]) =>
        el(
          'div',
          { class: 'role-row' },
          el('span', { class: `avatar ${k}`, 'aria-hidden': 'true' }, label.slice(0, 1)),
          el('div', null, el('b', null, label), el('p', { class: 'muted small' }, text)),
        ),
      ),
    ),
  );
}

async function toggleActive(u) {
  try {
    await apiPatch(`users/${u.id}`, { isActive: !u.isActive });
    toast(
      u.isActive ? `${u.username} is disabled and signed out.` : `${u.username} can sign in again.`,
    );
  } catch (e) {
    toast(e.message, 'error');
  }
  await loadUsers();
}

function resetPasswordDialog(u) {
  const pw = el('input', {
    type: 'password',
    required: true,
    minlength: 8,
    maxlength: 128,
    autocomplete: 'new-password',
  });
  return dialog({
    title: `Reset ${u.username}'s password`,
    body: [
      el(
        'p',
        { class: 'muted small' },
        'Give them this temporary password. They choose their own at the next sign-in, and every session they have now ends.',
      ),
      el('label', { class: 'field' }, el('span', null, 'Temporary password'), pw),
    ],
    ok: 'Reset password',
    onSubmit: async () => {
      await apiPost(`users/${u.id}/password`, { password: pw.value });
      toast(`Password reset for ${u.username}.`);
    },
  }).then((done) => done && loadUsers());
}

function deleteUserDialog(u) {
  return dialog({
    title: `Delete ${u.username}?`,
    body: el(
      'p',
      null,
      'They can no longer sign in. Reviews they recorded keep their name. To pause access instead, disable the account.',
    ),
    ok: 'Delete user',
    danger: true,
    onSubmit: async () => {
      await apiDelete(`users/${u.id}`);
      toast(`Deleted ${u.username}.`);
    },
  }).then((done) => done && loadUsers());
}

function renderAccount() {
  if (!S.me) return;
  $('ac-username').value = S.me.username;
  for (const id of ['ac-new', 'ac-repeat', 'ac-current']) $(id).value = '';
  $('account-meta').textContent = `password changed ${fmtAgo(S.me.passwordChangedAt)}`;
  const [label, text] = ROLE_TEXT[S.me.role];
  put(
    $('account-access'),
    el(
      'div',
      { class: 'role-row' },
      el(
        'span',
        { class: `avatar ${S.me.role}`, 'aria-hidden': 'true' },
        S.me.username.slice(0, 1).toUpperCase(),
      ),
      el('div', null, el('b', null, label), el('p', { class: 'muted small' }, text)),
    ),
    el(
      'ul',
      { class: 'perm-list' },
      Object.entries(PERMISSION_TEXT).map(([perm, t]) =>
        el(
          'li',
          { class: S.me.permissions.includes(perm) ? 'yes' : 'no' },
          el(
            'span',
            { class: 'perm-mark', 'aria-hidden': 'true' },
            S.me.permissions.includes(perm) ? '✓' : '–',
          ),
          el('span', null, t),
          el(
            'span',
            { class: 'sr-only' },
            S.me.permissions.includes(perm) ? 'allowed' : 'not allowed',
          ),
        ),
      ),
    ),
  );
}

/** Change own username and/or password; `form` ids differ between the account page and the first-sign-in form. */
async function saveAccount({ username, current, next, repeat, errorBox }) {
  if (next !== repeat) throw new Error("The new passwords don't match.");
  const body = { currentPassword: current };
  if (username && username.toLowerCase() !== S.me.username) body.username = username;
  if (next) body.newPassword = next;
  if (!body.username && !body.newPassword)
    throw new Error('Change the username or the password first.');
  if (errorBox) errorBox.textContent = '';
  S.me = (await apiPost('auth/account', body)).user;
  return body;
}

function wireAccounts() {
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(form, true);
    $('login-error').textContent = '';
    try {
      S.me = (
        await apiPost('auth/login', {
          username: $('login-username').value,
          password: $('login-password').value,
        })
      ).user;
      if (S.me.mustChangePassword) showAuth('change');
      else await enterApp();
    } catch (err) {
      $('login-error').textContent = err.message;
      $('login-password').value = '';
      $('login-password').focus();
    } finally {
      setBusy(form, false);
    }
  });
  $('change-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(form, true);
    try {
      await saveAccount({
        username: $('cf-username').value.trim(),
        current: $('cf-current').value,
        next: $('cf-new').value,
        repeat: $('cf-repeat').value,
        errorBox: $('change-error'),
      });
      toast('Saved. Welcome in.');
      await enterApp();
    } catch (err) {
      $('change-error').textContent = err.message;
    } finally {
      setBusy(form, false);
    }
  });
  $('change-sign-out').addEventListener('click', () => void signOut());
  $('account-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(form, true);
    try {
      const changed = await saveAccount({
        username: $('ac-username').value.trim(),
        current: $('ac-current').value,
        next: $('ac-new').value,
        repeat: $('ac-repeat').value,
      });
      applyUser();
      renderAccount();
      toast(changed.newPassword ? 'Saved. Your other sessions were signed out.' : 'Saved.');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(form, false);
    }
  });
  $('user-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(form, true);
    try {
      const u = await apiPost('users', {
        username: $('ua-username').value.trim(),
        role: $('ua-role').value,
        password: $('ua-password').value,
      });
      toast(`Added ${u.username}. Share the temporary password with them privately.`);
      form.reset();
      await loadUsers();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(form, false);
    }
  });
  put(
    $('ua-role'),
    Object.entries(ROLE_TEXT).map(([k, [label]]) =>
      el('option', { value: k, selected: k === 'reviewer' }, label),
    ),
  );
  const pop = $('user-pop'),
    chip = $('user-chip');
  const setPop = (open) => {
    pop.hidden = !open;
    chip.setAttribute('aria-expanded', String(open));
  };
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    setPop(pop.hidden);
  });
  document.addEventListener('click', (e) => {
    if (!pop.hidden && !e.target.closest('.user-menu')) setPop(false);
  });
  pop.addEventListener('click', () => setPop(false));
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      setPop(false);
      chip.focus();
    }
  });
  $('sign-out').addEventListener('click', () => void signOut());
}

/* ============================== Settings (owner) ============================== */

/** The settings page: the server's view, unsaved edits (draft / reset) and per-field errors. */
const SETTINGS = { view: null, draft: {}, reset: new Set(), errors: {}, general: '' };

const SOURCE_TEXT = {
  environment: [
    'Environment',
    'Set in the server environment (.env / .env.prod), which takes precedence. Remove it there and restart the app to manage it here.',
  ],
  dashboard: ['Saved here', 'Saved in this dashboard.'],
  default: [
    'Default',
    'Neither the environment nor the dashboard sets it: the built-in default applies.',
  ],
};
const CHANGE_SOURCE = { dashboard: 'Dashboard', cli: 'CLI', import_env: 'Import' };

const settingByKey = (key) =>
  SETTINGS.view ? SETTINGS.view.settings.find((x) => x.key === key) : undefined;

function settingText(s, v) {
  if (v === null || v === undefined || v === '') return s && s.optional ? 'auto' : '—';
  if (!s) return String(v);
  if (s.kind === 'bool') return v ? 'On' : 'Off';
  return `${typeof v === 'number' ? nf({ maximumFractionDigits: 2 }).format(v) : v}${s.unit ? ` ${s.unit}` : ''}`;
}

const hasSettingDraft = () => Object.keys(SETTINGS.draft).length > 0 || SETTINGS.reset.size > 0;

/** What a field shows: the unsaved edit, the value a reset returns to, or the value in force. */
function settingShown(s) {
  if (SETTINGS.reset.has(s.key)) return s.default;
  if (Object.hasOwn(SETTINGS.draft, s.key)) return SETTINGS.draft[s.key];
  // An optional setting nobody set is "auto": an empty field with the derived value as placeholder.
  return s.optional && s.source === 'default' ? null : s.value;
}

function draftValue(s, raw) {
  if (s.kind === 'bool') return Boolean(raw);
  const text = String(raw ?? '').trim();
  if (s.kind === 'int' || s.kind === 'number') {
    if (text === '') return s.optional ? null : '';
    const n = Number(text);
    return Number.isFinite(n) ? n : text; // the server names what is wrong with it
  }
  return text;
}

function editSetting(s, raw) {
  SETTINGS.reset.delete(s.key);
  delete SETTINGS.errors[s.key];
  const v = draftValue(s, raw);
  const current = s.optional && s.source === 'default' ? null : s.value;
  if (v === current) delete SETTINGS.draft[s.key];
  else SETTINGS.draft[s.key] = v;
  const row = $(`row-${s.key}`);
  if (row) {
    row.classList.toggle('changed', Object.hasOwn(SETTINGS.draft, s.key));
    row.classList.remove('invalid');
    const err = row.querySelector('.setting-error');
    if (err) err.remove();
  }
  updateSettingsBar();
}

function redrawSetting(s) {
  const row = $(`row-${s.key}`);
  if (row) row.replaceWith(settingRow(s));
  updateSettingsBar();
}

function settingControl(s) {
  const id = `set-${s.key}`;
  const locked = s.source === 'environment';
  const shown = settingShown(s);
  const describedBy = `help-${s.key}`;
  if (s.kind === 'bool') {
    const box = el('input', {
      id,
      type: 'checkbox',
      role: 'switch',
      class: 'switch',
      checked: Boolean(shown),
      disabled: locked,
      'aria-describedby': describedBy,
    });
    box.addEventListener('change', () => editSetting(s, box.checked));
    return box;
  }
  if (s.kind === 'enum') {
    const sel = el(
      'select',
      { id, disabled: locked, 'aria-describedby': describedBy },
      (s.options || []).map((o) => el('option', { value: o, selected: o === shown }, o)),
    );
    sel.addEventListener('change', () => editSetting(s, sel.value));
    return sel;
  }
  const numeric = s.kind === 'int' || s.kind === 'number';
  const input = el('input', {
    id,
    type: numeric ? 'number' : 'text',
    inputmode: numeric ? (s.kind === 'int' ? 'numeric' : 'decimal') : null,
    min: numeric ? s.min : null,
    max: numeric ? s.max : null,
    step: numeric ? (s.kind === 'int' ? 1 : 'any') : null,
    value: shown === null || shown === undefined ? '' : String(shown),
    placeholder: s.optional ? `auto: ${settingText(s, s.value)}` : null,
    list: s.format === 'timezone' ? 'tz-list' : null,
    spellcheck: 'false',
    autocomplete: 'off',
    disabled: locked,
    'aria-describedby': describedBy,
  });
  input.addEventListener('input', () => editSetting(s, input.value));
  return input;
}

function settingRow(s) {
  const err = SETTINGS.errors[s.key];
  const [srcLabel, srcTitle] = SOURCE_TEXT[s.source];
  const resetting = SETTINGS.reset.has(s.key);
  const cls = ['setting'];
  if (Object.hasOwn(SETTINGS.draft, s.key) || resetting) cls.push('changed');
  if (err) cls.push('invalid');
  if (s.source === 'environment') cls.push('locked');
  return el(
    'div',
    { class: cls.join(' '), id: `row-${s.key}` },
    el(
      'div',
      { class: 'setting-text' },
      el('label', { for: `set-${s.key}` }, el('b', null, s.label)),
      el('code', { class: 'setting-key' }, s.key),
      el('p', { class: 'muted small', id: `help-${s.key}` }, s.help),
      el(
        'div',
        { class: 'chips' },
        el(
          'span',
          { class: `chip${s.source === 'dashboard' ? ' violet' : ''}`, title: srcTitle },
          srcLabel,
        ),
        el(
          'span',
          {
            class: 'chip',
            title:
              s.apply === 'live'
                ? 'Takes effect without a restart (after a pipeline run in progress ends)'
                : 'Read when the app starts: restart it to apply a change',
          },
          s.apply === 'live' ? 'Live' : 'At restart',
        ),
        s.source === 'environment'
          ? el(
              'span',
              { class: 'chip mono', title: 'Value in the server environment' },
              `${s.key}=${s.environment}`,
            )
          : null,
        s.pending === 'restart'
          ? el(
              'span',
              { class: 'chip warn' },
              `Restart to apply · running ${settingText(s, s.running)}`,
            )
          : null,
        s.pending === 'run'
          ? el(
              'span',
              { class: 'chip warn' },
              `${SETTINGS.view.waitingForRun ? 'Applies when the current run ends' : 'Applies at the next scheduled run'} · running ${settingText(s, s.running)}`,
            )
          : null,
        resetting
          ? el('span', { class: 'chip warn' }, `Resets to ${settingText(s, s.default)}`)
          : null,
        s.updatedBy && s.updatedAt
          ? el(
              'span',
              { class: 'chip', title: fmtTime(s.updatedAt, { year: true }) },
              `${s.updatedBy} · ${fmtAgo(s.updatedAt)}`,
            )
          : null,
      ),
      err ? el('div', { class: 'setting-error', role: 'alert' }, err) : null,
    ),
    el(
      'div',
      { class: 'setting-control' },
      settingControl(s),
      // Fixed cells (unit, action) keep every row's field in the same place.
      el('span', { class: 'unit' }, s.unit && s.kind !== 'bool' ? s.unit : ''),
      el('span', { class: 'setting-action' }, settingAction(s, resetting)),
    ),
  );
}

/** Reset (remove the saved value) or, once marked, Keep. */
function settingAction(s, resetting) {
  if (resetting)
    return el(
      'button',
      {
        type: 'button',
        class: 'btn small',
        onclick: () => {
          SETTINGS.reset.delete(s.key);
          redrawSetting(s);
        },
      },
      'Keep',
    );
  if (s.source !== 'dashboard') return null;
  return el(
    'button',
    {
      type: 'button',
      class: 'btn small',
      title: `Remove the saved value: back to the default (${settingText(s, s.default)})`,
      onclick: () => {
        delete SETTINGS.draft[s.key];
        delete SETTINGS.errors[s.key];
        SETTINGS.reset.add(s.key);
        redrawSetting(s);
      },
    },
    'Reset',
  );
}

function settingsNote(kind, ...children) {
  return el('div', { class: `settings-note${kind ? ` ${kind}` : ''}` }, ...children);
}

function renderSettingsNotes(v) {
  const notes = [];
  if (v.problems.length)
    notes.push(
      el(
        'div',
        { class: 'banner inline' },
        el('b', null, 'The saved settings do not validate with this server environment.'),
        ' The app will refuse to start with them until this is fixed:',
        el(
          'ul',
          null,
          v.problems.map((p) => el('li', null, `${p.key}: ${p.message}`)),
        ),
      ),
    );
  if (SETTINGS.general) notes.push(el('div', { class: 'banner inline' }, SETTINGS.general));
  if (v.waitingForRun)
    notes.push(
      settingsNote(
        'warn',
        el(
          'p',
          null,
          'A pipeline run is in progress: the saved changes apply as soon as it ends, so one run never mixes two configurations.',
        ),
      ),
    );
  const restart = v.settings.filter((x) => x.pending === 'restart');
  if (restart.length)
    notes.push(
      settingsNote(
        'warn',
        el(
          'p',
          null,
          el('b', null, 'Restart the app to apply: '),
          restart.map((x) => x.label).join(', '),
          '. These are read once at start-up (on the server: ',
          el('code', null, 'dc restart app'),
          ').',
        ),
      ),
    );
  if (v.environmentKeys.length) {
    const unsaved = v.settings.filter(
      (x) => x.source === 'environment' && x.saved !== x.value,
    ).length;
    notes.push(
      settingsNote(
        '',
        el(
          'p',
          null,
          el('b', null, `${v.environmentKeys.length} settings come from the server environment`),
          ' and are read-only here, because the environment takes precedence. ',
          unsaved
            ? 'Import copies their current values into the dashboard; then remove those lines from .env / .env.prod and restart the app to manage them here.'
            : 'Their values are already saved here: remove those lines from .env / .env.prod and restart the app to manage them here.',
        ),
        unsaved
          ? el(
              'button',
              { type: 'button', class: 'btn primary', onclick: () => void importSettings() },
              'Import from environment',
            )
          : null,
        el(
          'details',
          { class: 'settings-env-keys' },
          el('summary', null, 'Lines to remove'),
          el('pre', null, v.environmentKeys.join('\n')),
        ),
      ),
    );
  }
  put($('settings-notes'), notes);
}

function renderSettings() {
  const v = SETTINGS.view;
  renderSettingsNotes(v);
  put(
    $('settings-groups'),
    v.groups.map((g) =>
      el(
        'section',
        { class: 'panel settings-group', 'aria-labelledby': `sg-${g.id}` },
        el(
          'div',
          { class: 'panel-head' },
          el('h2', { id: `sg-${g.id}` }, g.label),
          el('span', { class: 'hint' }, g.description),
        ),
        el(
          'div',
          { class: 'settings-list' },
          v.settings.filter((x) => x.group === g.id).map(settingRow),
        ),
      ),
    ),
  );
  if (!$('tz-list')) {
    const zones =
      typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    $('tab-settings').append(
      el(
        'datalist',
        { id: 'tz-list' },
        ['UTC', ...zones.filter((z) => z !== 'UTC')].map((z) => el('option', { value: z })),
      ),
    );
  }
  const waiting = v.settings.filter((x) => x.pending).length + v.problems.length;
  $('count-settings').textContent = waiting ? fmtInt(waiting) : '';
  updateSettingsBar();
}

function updateSettingsBar() {
  const n = Object.keys(SETTINGS.draft).length + SETTINGS.reset.size;
  $('settings-bar').hidden = n === 0;
  $('settings-bar-text').textContent = `${n} unsaved ${n === 1 ? 'change' : 'changes'}`;
}

async function loadSettings() {
  SETTINGS.view = await api('settings');
  renderSettings();
  await loadSettingsHistory();
}

async function loadSettingsHistory() {
  const rows = await api('settings/history?limit=50');
  const value = (key, v) =>
    v === null ? el('span', { class: 'muted' }, 'not saved') : settingText(settingByKey(key), v);
  put(
    $('settings-history'),
    table(
      [
        { label: 'When', render: (r) => fmtTime(r.changedAt, { year: true }) },
        { label: 'Who', render: (r) => r.changedBy },
        {
          label: 'Setting',
          render: (r) =>
            el(
              'div',
              { class: 'coin-text' },
              el('b', null, (settingByKey(r.key) || { label: r.key }).label),
              el('span', null, r.key),
            ),
        },
        {
          label: 'Change',
          render: (r) =>
            el('span', null, value(r.key, r.oldValue), ' → ', value(r.key, r.newValue)),
        },
        { label: 'Via', render: (r) => CHANGE_SOURCE[r.source] || r.source },
      ],
      rows,
      { empty: 'No changes yet.' },
    ),
  );
}

/** "KEY: message" errors from the API, next to their fields; anything else above the groups. */
function settingErrors(e) {
  const out = {};
  const general = [];
  for (const x of e.errors || []) {
    const m = /^([A-Z][A-Z0-9_]+): (.+)$/s.exec((x && x.message) || '');
    if (m && settingByKey(m[1])) out[m[1]] = out[m[1]] ? `${out[m[1]]}; ${m[2]}` : m[2];
    else if (x && x.message) general.push(x.message);
  }
  if (!Object.keys(out).length && !general.length) general.push(e.message);
  return { fields: out, general: general.join(' ') };
}

function savedSummary(r) {
  if (r.outcome === 'unchanged') return 'Nothing changed.';
  const n = r.changes.length;
  const head = `Saved ${n} ${n === 1 ? 'setting' : 'settings'}.`;
  const live = r.changes.filter((c) => !r.restartRequired.includes(c.key)).length;
  const parts = [head];
  if (live)
    parts.push(
      r.outcome === 'deferred'
        ? 'They apply when the pipeline run in progress ends.'
        : 'In force now.',
    );
  if (r.restartRequired.length)
    parts.push(`Restart the app to apply ${r.restartRequired.join(', ')}.`);
  return parts.join(' ');
}

async function afterSettingsSaved(r) {
  SETTINGS.view = r.view;
  SETTINGS.draft = {};
  SETTINGS.reset = new Set();
  SETTINGS.errors = {};
  SETTINGS.general = '';
  renderSettings();
  void loadSettingsHistory().catch(() => undefined);
  // The display time zone, Telegram mode and schedule also show in the header and overview.
  try {
    S.cfg = await api('config');
    renderHeader();
    await refresh(true);
  } catch {
    /* the 30 s tick reports API errors */
  }
}

async function saveSettings() {
  const btn = $('settings-save');
  btn.disabled = true;
  try {
    const r = await apiPut('settings', {
      values: { ...SETTINGS.draft },
      reset: [...SETTINGS.reset],
    });
    toast(savedSummary(r));
    await afterSettingsSaved(r);
  } catch (e) {
    const { fields, general } = settingErrors(e);
    SETTINGS.errors = fields;
    SETTINGS.general = general;
    renderSettings();
    const first = Object.keys(fields)[0];
    if (first)
      $(`row-${first}`).scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'center',
      });
    toast(first ? 'Not saved: check the highlighted settings.' : `Not saved: ${general}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function importSettings() {
  const keys = SETTINGS.view.environmentKeys;
  const done = await dialog({
    title: 'Import from environment',
    body: el(
      'div',
      { class: 'stack-form' },
      el('p', null, `Save the current value of these ${keys.length} settings in the dashboard:`),
      el('pre', { class: 'settings-import-keys' }, keys.join('\n')),
      el(
        'p',
        { class: 'muted small' },
        'Nothing changes now: the environment keeps precedence. Afterwards remove these lines from .env / .env.prod and restart the app; the dashboard then holds the same values and you can change them here.',
      ),
    ),
    ok: 'Import',
    onSubmit: async () => {
      const r = await apiPost('settings/import-env', {});
      toast(
        r.outcome === 'unchanged'
          ? 'Already saved: nothing to import.'
          : `Imported ${r.changes.length} settings. Now remove those lines from the environment file and restart the app.`,
      );
      await afterSettingsSaved(r);
    },
  });
  return done;
}

function wireSettings() {
  $('settings-save').addEventListener('click', () => void saveSettings());
  $('settings-discard').addEventListener('click', () => {
    SETTINGS.draft = {};
    SETTINGS.reset = new Set();
    SETTINGS.errors = {};
    SETTINGS.general = '';
    if (SETTINGS.view) renderSettings();
  });
  window.addEventListener('beforeunload', (e) => {
    if (hasSettingDraft()) e.preventDefault();
  });
}

/* ============================== Router & refresh ============================== */

const TABS = [
  'overview',
  'queue',
  'eligible',
  'needs_review',
  'excluded',
  'forward',
  'batches',
  'exports',
  'access',
  'users',
  'settings',
  'account',
];
/** The permission each section needs (the rest need data:read, which every role has). */
const TAB_PERMISSION = {
  batches: 'health:read',
  exports: 'exports:read',
  access: 'telegram:manage',
  users: 'users:manage',
  settings: 'settings:manage',
};
const tabAllowed = (t) => t === 'account' || !TAB_PERMISSION[t] || can(TAB_PERMISSION[t]);
const visibleTabs = () => TABS.filter(tabAllowed);
const SHEETS = ['queue', 'eligible', 'needs_review', 'excluded'];
const showError = (where) => (e) => {
  console.error(e);
  const box = SHEETS.includes(where) ? $(`tab-${where}`).querySelector('.sheet-table') : $(where);
  if (box) put(box, el('div', { class: 'error' }, `Could not load: ${e.message}`));
};

async function loadTab(tab) {
  if (SHEETS.includes(tab)) await loadSheet(tab).catch(showError(tab));
  else if (tab === 'forward') await loadForward().catch(showError('forward-events'));
  else if (tab === 'batches') await loadBatches().catch(showError('batches'));
  else if (tab === 'exports') await loadExports().catch(showError('exports'));
  else if (tab === 'access') await loadAccess().catch(showError('access-pending'));
  else if (tab === 'users') await loadUsers().catch(showError('users-table'));
  else if (tab === 'settings') await loadSettings().catch(showError('settings-groups'));
  else if (tab === 'account') renderAccount();
}

function selectTab(tab, push = true) {
  if (!TABS.includes(tab) || !tabAllowed(tab)) tab = 'overview';
  S.tab = tab;
  for (const t of TABS) {
    $(`tab-${t}`).hidden = t !== tab;
    const b = $(`t-${t}`);
    b.setAttribute('aria-selected', String(t === tab));
    b.tabIndex = t === tab ? 0 : -1;
  }
  $('page-title').textContent = PAGES[tab][0];
  $('page-sub').textContent = PAGES[tab][1];
  document.title = tab === 'overview' ? 'Coins Predicts' : `${PAGES[tab][0]} · Coins Predicts`;
  if (push && location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  hideTip();
  void loadTab(tab);
}

async function refresh(force = false) {
  const [ov, lb] = await Promise.all([api('overview'), api('lbank').catch(() => null)]);
  S.overview = ov;
  S.lbank = lb;
  renderOverview(ov);
  const batch = ov.scan ? ov.scan.batchId : null;
  if (force || batch !== S.lastBatch) {
    S.lastBatch = batch;
    if (!['overview', 'access', 'users', 'settings', 'account'].includes(S.tab))
      await loadTab(S.tab);
  }
}

let fastTimer = null;
function watchRun() {
  const running = S.overview && S.overview.latestRun && S.overview.latestRun.status === 'running';
  if (running && !fastTimer) {
    fastTimer = setInterval(async () => {
      try {
        await refresh();
        if (S.tab === 'batches') renderGantt(S.overview.latestRun);
        if (!(S.overview.latestRun && S.overview.latestRun.status === 'running')) {
          clearInterval(fastTimer);
          fastTimer = null;
          await refresh(true);
        }
      } catch {
        /* the 30 s tick reports API errors */
      }
    }, 5_000);
  }
}

function initTheme() {
  const btn = $('theme');
  const apply = (mode) => {
    if (mode === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = mode;
    btn.setAttribute('aria-label', `Color theme: ${mode}`);
    btn.title = `Theme: ${mode}`;
  };
  let mode = 'auto';
  try {
    mode = localStorage.getItem('theme') || 'auto';
  } catch {
    /* storage unavailable */
  }
  apply(mode);
  btn.addEventListener('click', () => {
    mode = mode === 'auto' ? 'light' : mode === 'light' ? 'dark' : 'auto';
    try {
      localStorage.setItem('theme', mode);
    } catch {
      /* storage unavailable */
    }
    apply(mode);
    toast(`Theme: ${mode}`);
  });
}

function wire() {
  for (const t of TABS) $(`t-${t}`).addEventListener('click', () => selectTab(t));
  // The collapsed (tablet / phone) sidebar shows icons only: its label becomes a CSS tooltip.
  document.querySelectorAll('.rail-items button[data-tab]').forEach((b) => {
    const label = b.querySelector('span');
    if (label) b.dataset.label = label.textContent.trim();
  });
  document.querySelector('.rail-items').addEventListener('keydown', (e) => {
    const dir = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const tabs = visibleTabs();
    const next = tabs[(tabs.indexOf(S.tab) + dir + tabs.length) % tabs.length];
    selectTab(next);
    $(`t-${next}`).focus();
  });
  for (const sheet of SHEETS) {
    const sec = $(`tab-${sheet}`);
    let timer = null;
    sec.querySelector('.sheet-search').addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        S.sheets[sheet].search = e.target.value.trim();
        S.sheets[sheet].page = 0;
        void loadSheet(sheet).catch(showError(sheet));
      }, 250);
    });
    sec.querySelector('.sheet-rows').addEventListener('change', () => {
      S.sheets[sheet].page = 0;
      void loadSheet(sheet).catch(showError(sheet));
    });
    sec
      .querySelectorAll('.view-seg button')
      .forEach((b) => b.addEventListener('click', () => setSheetView(sheet, b.dataset.view)));
  }
  let fwdTimer = null;
  $('forward-search').addEventListener('input', (e) => {
    clearTimeout(fwdTimer);
    fwdTimer = setTimeout(() => {
      S.forward.search = e.target.value.trim();
      S.forward.page = 0;
      void loadForward().catch(showError('forward-events'));
    }, 250);
  });
  $('forward-view')
    .querySelectorAll('button')
    .forEach((b) =>
      b.addEventListener('click', () => {
        S.forward.view = b.dataset.view;
        S.forward.page = 0;
        setForwardSeg('forward-view', 'view', b.dataset.view);
        void loadForward().catch(showError('forward-events'));
      }),
    );
  $('forward-stars')
    .querySelectorAll('button')
    .forEach((b) =>
      b.addEventListener('click', () => {
        S.forward.stars = b.dataset.stars;
        S.forward.page = 0;
        setForwardSeg('forward-stars', 'stars', b.dataset.stars);
        void loadForward().catch(showError('forward-events'));
      }),
    );
  $('missed-retry-all').addEventListener(
    'click',
    () => void deliveryAction('telegram/retry', {}, 'Retried all missed'),
  );
  $('send-latest-all').addEventListener(
    'click',
    () => void deliveryAction('telegram/send', {}, 'Sent latest report to everyone'),
  );
  $('access-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('access-add-id').value.trim();
    if (id)
      void changeAccess('approve', id, `Approved ${id}.`).then(() => {
        $('access-add-id').value = '';
      });
  });
  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  $('search-open').addEventListener('click', openPalette);
  $('palette').addEventListener('click', (e) => {
    if (e.target === $('palette')) closePalette();
  });
  $('palette-input').addEventListener('input', (e) => {
    clearTimeout(P.timer);
    const q = e.target.value.trim();
    P.timer = setTimeout(() => void searchPalette(q), 180);
  });
  $('palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && P.items.length) {
      e.preventDefault();
      setActive((P.active + 1) % P.items.length);
    } else if (e.key === 'ArrowUp' && P.items.length) {
      e.preventDefault();
      setActive((P.active - 1 + P.items.length) % P.items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickPalette(P.active);
    }
  });
  document.addEventListener('keydown', (e) => {
    const typing =
      e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
    if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
      e.preventDefault();
      P.open ? closePalette() : openPalette();
      return;
    }
    if (e.key === 'Escape') {
      if (P.open) closePalette();
      else if (!$('drawer').hidden) closeDrawer();
    }
  });
  window.addEventListener('hashchange', () => {
    if (!$('drawer').hidden) closeDrawer();
    selectTab(location.hash.slice(1), false);
  });
  window.addEventListener('scroll', hideTip, { passive: true });
  if (!/Mac|iPhone|iPad/.test(navigator.platform))
    document.querySelectorAll('kbd').forEach((k) => {
      if (k.textContent === '⌘K') k.textContent = 'Ctrl K';
    });
}

async function start() {
  initTheme();
  wire();
  wireAccounts();
  wireSettings();
  try {
    S.me = (await api('auth/me')).user;
  } catch (e) {
    if (e.code === 'AUTH_REQUIRED') return showAuth('login');
    if (e.code === 'PASSWORD_CHANGE_REQUIRED') return showAuth('change');
    $('banner').hidden = false;
    $('banner').textContent =
      `The dashboard could not load: ${e.message}. Check that the app is running, then reload.`;
    return;
  }
  if (S.me.mustChangePassword) return showAuth('change');
  await enterApp();
}

/** After sign-in: load the data the role may see, then start the refresh timers (once). */
async function enterApp() {
  hideAuth();
  applyUser();
  try {
    S.cfg = await api('config');
    renderHeader();
    await refresh(true);
    if (can('telegram:manage'))
      void api('telegram/access')
        .then((a) => {
          $('count-access').textContent = fmtInt(a.pending.length + (a.missingCount || 0));
        })
        .catch(() => undefined);
  } catch (e) {
    if (!$('auth').hidden) return;
    $('banner').hidden = false;
    $('banner').textContent =
      `The dashboard could not load: ${e.message}. Check that the app is running, then reload.`;
  }
  selectTab(location.hash.slice(1) || 'overview', false);
  const coin = Number(new URL(location.href).searchParams.get('coin'));
  if (S.cfg && Number.isInteger(coin) && coin > 0) void openAsset(coin, null, null);
  if (S.started) return;
  S.started = true;
  setInterval(() => {
    if (!$('auth').hidden) return;
    void refresh()
      .then(watchRun)
      .catch((e) => {
        if ($('auth').hidden) toast(`Could not reach the API: ${e.message}`, 'error');
      });
  }, 30_000);
  watchRun();
  setInterval(tickCountdowns, 1_000);
}

void start();
