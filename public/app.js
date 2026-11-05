// Coins Predicts dashboard (Two-Tier VMC strategy). Reads the NestJS JSON API only. All source
// text (coin names, symbols, notes) is rendered with textContent, never innerHTML, because it comes
// from external sources or reviewers. No inline styles (CSP).
"use strict";

/* ============================== Basics ============================== */

const $ = (id) => document.getElementById(id);

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

function put(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
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

const num = (x) => (x === null || x === undefined || x === "" ? null : Number(x));
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

/* ============================== State & formatting ============================== */

const S = {
  cfg: null,
  overview: null,
  tab: "overview",
  sheets: { queue: { page: 0, search: "" }, eligible: { page: 0, search: "" }, needs_review: { page: 0, search: "" }, excluded: { page: 0, search: "" } },
  drawer: { cmcId: null, batchId: null, returnFocus: null },
  lastBatch: null,
};
const tz = () => (S.cfg && S.cfg.timezone) || "UTC";
const live = () => !!(S.cfg && S.cfg.isLiveData);

function nf(o) { return new Intl.NumberFormat("en-US", o); }
const fmtInt = (n) => (isNum(n) ? nf({ maximumFractionDigits: 0 }).format(n) : "—");
function fmtUsd(n) {
  n = num(n);
  if (!isNum(n)) return "—";
  return nf({ style: "currency", currency: "USD", notation: Math.abs(n) >= 1e6 ? "compact" : "standard", maximumFractionDigits: Math.abs(n) >= 1e6 ? 2 : 0 }).format(n);
}
function fmtPrice(n) {
  n = num(n);
  if (!isNum(n)) return "—";
  if (n >= 1000) return nf({ style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
  if (n >= 1) return nf({ style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(n);
  return `$${n.toPrecision(4)}`;
}
/** VMC as ratio and percent (PDF p.13: 0.20 = 20%). */
function fmtVmc(x, withRatio = true) {
  x = num(x);
  if (!isNum(x)) return "—";
  const pct = `${(x * 100).toFixed(x * 100 >= 10 ? 2 : 3)}%`;
  return withRatio ? `${pct} (${x.toPrecision(4)})` : pct;
}
function fmtMult(x) {
  x = num(x);
  return isNum(x) ? `${x >= 100 ? x.toFixed(0) : x.toFixed(x >= 10 ? 1 : 2)}×` : "—";
}
function fmtTime(iso, opts = {}) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-GB", { timeZone: tz(), year: opts.year ? "numeric" : undefined, month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
function fmtAgo(iso) {
  if (!iso) return "—";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}
const utc = (iso) => (iso ? `${String(iso).replace(".000Z", "Z")}` : "—");

const statusLabel = (dot, text, title) => el("span", { class: "status", title }, el("span", { class: `dot ${dot || ""}`, "aria-hidden": "true" }), text);
const chip = (text, opts = {}) => el("span", { class: `chip${opts.strong ? " strong" : ""}`, title: opts.title }, opts.dot ? el("span", { class: `dot ${opts.dot}`, "aria-hidden": "true" }) : null, text);

const ELIG = { ELIGIBLE: ["good", "Eligible"], NEEDS_REVIEW: ["warning", "Needs review"], EXCLUDED: ["", "Excluded"] };
const LBANK = { VERIFIED: ["good", "Verified"], PAIR_LISTED_UNVERIFIED: ["warning", "Listed, unverified"], NOT_LISTED: ["", "Not listed"], NOT_TRADABLE: ["critical", "Not tradable"], UNKNOWN: ["serious", "Unknown"] };
const CURRENT = { OK: ["good", "OK"], STALE: ["serious", "Stale"], TIMESTAMP_UNVERIFIED: ["serious", "Time unverified"], MISMATCHED: ["critical", "Mismatched"], MISSING: ["critical", "Missing"], INVALID: ["critical", "Invalid"] };
const QUEUE = { PUBLISHED: ["good", "Published"], EMPTY: ["", "Empty"], WITHHELD_INCOMPLETE_BATCH: ["critical", "Withheld: incomplete batch"], WITHHELD_LBANK_UNAVAILABLE: ["critical", "Withheld: LBank feed unavailable"] };
const BATCH = { COMPLETE: ["good", "Complete"], INCOMPLETE: ["serious", "Incomplete"], FAILED: ["critical", "Failed"] };
const RUN = { running: ["accent", "Running"], succeeded: ["good", "Succeeded"], partial: ["warning", "Partial"], failed: ["critical", "Failed"], skipped: ["", "Skipped"], missed: ["", "Missed"], interrupted: ["critical", "Interrupted"] };
const lab = (map, key) => statusLabel((map[key] || [])[0], (map[key] || [])[1] || key || "—");

const REASON_TEXT = {
  RANK_OUT_OF_RANGE: "rank outside 101–1200", RANK_MISSING: "no CMC rank", RANK_AMBIGUOUS: "duplicate rank in batch",
  MARKET_CAP_BELOW_MIN: "market cap below $15M", MARKET_CAP_MISSING: "market cap missing", LISTING_AGE_BELOW_60D: "listed < 60 days",
  DATE_ADDED_MISSING: "no listing date", DATE_ADDED_AFTER_SCAN: "listing date after scan", STABLECOIN: "stablecoin", TOKENIZED_ASSET: "tokenized stock/asset",
  CLASS_AMBIGUOUS: "class ambiguous", NO_LBANK_SPOT_PAIR: "no LBank Spot pair", LBANK_NOT_TRADABLE: "LBank pair not tradable",
  LBANK_PAIR_UNVERIFIED: "LBank pair unverified", LBANK_STATUS_UNKNOWN: "LBank status unknown",
  DAILY_ROW_MISSING: "a completed day is missing", DAILY_ROW_INVALID: "a completed day is invalid", ZERO_BASELINE: "zero baseline",
  NOT_EVALUATED_EXCLUDED: "not evaluated (excluded)", CURRENT_MISSING: "no current quote", CURRENT_STALE: "stale quote",
  TIMESTAMP_UNVERIFIED: "no provider time", TIMESTAMP_IN_FUTURE: "provider time in the future", MISMATCHED_OBSERVATION: "volume/cap mismatch",
  CURRENT_CAP_INVALID: "current cap invalid", CURRENT_VOLUME_INVALID: "current volume invalid",
};
const reasonText = (code) => {
  if (!code) return "";
  const [k, detail] = String(code).split(":");
  return `${REASON_TEXT[k] || k}${detail ? ` (${detail.replace(/_/g, " ").toLowerCase()})` : ""}`;
};

/** YES / NO / N/A with the multiple and, for N/A, the reason as a tooltip. */
function passCell(status, multiple, reason) {
  const cls = status === "YES" ? "pass yes" : status === "NO" ? "pass no" : "pass na";
  return el("span", { class: cls, title: status === "N/A" ? reasonText(reason) : `${status}: current ÷ mean = ${num(multiple)}` }, status === "N/A" ? "N/A" : `${status} ${fmtMult(multiple)}`);
}
const stars = (n) => el("span", { class: "stars", title: `${n} of 3 windows met`, "aria-label": `${n} stars` }, "★".repeat(n) + "☆".repeat(3 - n));

function coinCell(r) {
  const logo = live() && Number.isInteger(r.cmcId) && r.cmcId < 900000 ? el("img", { class: "logo", src: `https://s2.coinmarketcap.com/static/img/coins/64x64/${r.cmcId}.png`, width: 22, height: 22, alt: "", loading: "lazy", onerror: (e) => e.target.remove() }) : null;
  return el("div", { class: "coin" }, logo, el("div", { class: "coin-text" }, el("b", null, r.symbol), el("span", { title: r.name }, `${r.name} · ${r.cmcId}`)));
}

function table(cols, rows, opts = {}) {
  if (!rows.length) return el("div", { class: "empty" }, opts.empty || "Nothing to show.");
  const head = el("thead", null, el("tr", null, cols.map((c) => el("th", { class: c.num ? "num" : null, title: c.title }, c.label))));
  const body = el("tbody", null, rows.map((r) => {
    const tr = el("tr", { class: opts.onRow ? "clickable" : null, tabindex: opts.onRow ? 0 : null }, cols.map((c) => el("td", { class: c.num ? "num" : null }, c.render(r))));
    if (opts.onRow) {
      tr.addEventListener("click", (e) => { if (!e.target.closest("button, a, input, select, textarea")) opts.onRow(r, tr); });
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") opts.onRow(r, tr); });
    }
    return tr;
  }));
  return el("table", null, head, body);
}
const kv = (pairs) => el("table", { class: "kv-table" }, el("tbody", null, pairs.filter(Boolean).map(([k, v]) => el("tr", null, el("td", null, k), el("td", null, v)))));

function pager(container, { page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  put(container, el("span", null, `${fmtInt(total)} rows · page ${page + 1} of ${pages}`),
    el("button", { type: "button", class: "btn", disabled: page === 0, onclick: () => onPage(page - 1) }, "Previous"),
    el("button", { type: "button", class: "btn", disabled: page + 1 >= pages, onclick: () => onPage(page + 1) }, "Next"));
}

/* ============================== Header & overview ============================== */

function renderHeader() {
  const c = S.cfg;
  put($("badges"),
    el("span", { class: `badge ${c.isLiveData ? "live" : "fixture"}` }, c.isLiveData ? `Live · ${c.providerName}` : "SYNTHETIC fixture data"),
    el("span", { class: "badge" }, `Telegram: ${c.telegramMode}`),
    el("span", { class: "badge" }, `Scheduler: ${c.schedulerEnabled ? "on" : "off"}`),
    el("span", { class: "badge" }, c.strategy.rulesetVersion));
  put($("footer"), `${c.attribution || ""}${c.attribution ? " · " : ""}Times in ${tz()} (stored in UTC). Research screening only: the Review Queue is a list for human chart review, never a buy signal, and no order is ever placed.`);
}

function renderBanners(ov) {
  const msgs = [...(ov.banners || [])];
  if (!live()) msgs.unshift("SYNTHETIC fixture market: every coin, price and volume on this dashboard is invented for testing.");
  const b = $("banner");
  b.hidden = !msgs.length;
  put(b, msgs.map((m, i) => el("div", { class: i ? "banner-line" : null }, m)));
}

function renderRunStrip(ov) {
  const run = ov.latestRun;
  if (!run) return put($("run-strip"), el("div", null, S.cfg.schedulerEnabled ? "Waiting for the first hourly run." : "Automatic runs are off. Start one with `npm run cli -- run-once`."));
  const stages = ["discover", "collect", "lbank", "daily", "scan", "venues", "export", "notify"];
  const done = new Set((run.stages || []).filter((s) => s.status === "succeeded").map((s) => s.stage));
  const daily = run.metrics && run.metrics.daily;
  put($("run-strip"),
    el("div", { class: "state" }, lab(RUN, run.status), el("span", null, `${run.kind} run · slot ${fmtTime(run.slotTime)}`)),
    el("div", { class: "progress" },
      el("div", { class: "label" }, run.status === "running" ? `${run.currentStageLabel || run.currentStage || "starting"}…` : `finished ${fmtAgo(run.finishedAt)}`),
      el("div", { class: "steps" }, stages.map((s) => el("span", { class: `step${done.has(s) ? " done" : ""}${run.currentStage === s ? " active" : ""}`, title: s }, s)))),
    daily && daily.due !== undefined ? el("div", { class: "meta" }, `daily rows: ${daily.fetched ?? 0}/${daily.due} due refreshed${daily.remaining ? ` · ${daily.remaining} pending` : ""}`) : null,
    run.error ? el("div", { class: "error small" }, run.error) : null,
    S.cfg.canWrite ? el("button", { type: "button", class: "btn", title: "Recompute the latest stored batch from saved data (no crawling) and re-export", onclick: rescan }, "Reprocess latest batch") : null);
}

async function rescan(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "Reprocessing…";
  try {
    const r = await apiPost("scan/rescan", {});
    btn.textContent = r.ok ? `Done · queue ${r.counts ? r.counts.queue : "?"}` : `Skipped: ${r.reason}`;
    await refresh(true);
  } catch (err) {
    btn.textContent = `Failed: ${err.message}`;
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = "Reprocess latest batch"; }, 4000);
  }
}

/** LBank Spot markets list (CMC exchange page, Markets section): age, next refresh, manual refresh. */
function lbankRow(scanList) {
  const info = S.lbank, l = info && info.list;
  const button = S.cfg.canWrite ? el("button", { type: "button", class: "btn", title: "Fetch the Markets list of CMC's LBank page now, then recompute the latest batch", onclick: refreshLbank }, "Refresh LBank list now") : null;
  if (!l) return el("div", null, el("span", { class: "muted" }, "No complete list yet: the next run fetches it."), button ? el("div", { class: "row-actions" }, button) : null);
  const age = l.ageDays < 1 ? "today" : `${Math.floor(l.ageDays)} d ago`;
  const usedByScan = scanList && scanList.id !== l.crawlId ? el("div", { class: "small muted" }, "The latest scan used an older list; refreshing recomputes it.") : null;
  return el("div", null,
    el("div", null, `${fmtInt(l.pairs)} spot pairs · fetched ${fmtTime(l.fetchedAt)} (${age}) · next automatic refresh ${fmtTime(l.nextRefreshAt)}`),
    l.stale ? el("div", { class: "error small" }, `Older than ${info.maxAgeDays} days: LBank status is UNKNOWN and the queue is withheld until it is refreshed.`) : null,
    l.lastAttempt && l.lastAttempt.status !== "COMPLETE" ? el("div", { class: "error small" }, `Last refresh attempt ${fmtTime(l.lastAttempt.at)} ${l.lastAttempt.status}${l.lastAttempt.error ? `: ${l.lastAttempt.error}` : ""}; the list above stays in use.`) : null,
    usedByScan,
    button ? el("div", { class: "row-actions" }, button) : null);
}

async function refreshLbank(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "Refreshing… (about a minute)";
  try {
    const r = await apiPost("lbank/refresh", {});
    btn.textContent = r.ok ? `Done · ${fmtInt(r.pairs)} pairs · queue ${r.counts ? fmtInt(r.counts.queue) : "?"}` : `Not refreshed: ${r.reason || `${r.status}${r.notes && r.notes.length ? ` — ${r.notes[0]}` : ""}`}`;
    await refresh(true);
  } catch (err) {
    btn.textContent = `Failed: ${err.message}`;
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = "Refresh LBank list now"; }, 5000);
  }
}

function renderOverview(ov) {
  renderBanners(ov);
  renderRunStrip(ov);
  const b = ov.latestBatch, sc = ov.scan, c = (sc && sc.counts) || {};
  const pass = (k) => (c.pass && c.pass[k]) || {};
  put($("kpis"), [
    ["Crawl batch", b ? lab(BATCH, b.status) : "—", b ? `${fmtTime(b.slotTime)} · crawled ${fmtAgo(b.crawledAt)}` : "no batch yet"],
    ["Coins in batch", fmtInt(c.assets), b ? `${fmtInt(b.collected)} of ${fmtInt(b.listedTotal)} listed` : ""],
    ["Review Queue", fmtInt(c.queue), sc ? lab(QUEUE, sc.queueStatus) : ""],
    ["Eligible", fmtInt(c.eligible), "pass every hard filter"],
    ["Needs review", fmtInt(c.needsReview), "missing or ambiguous input"],
    ["Excluded", fmtInt(c.excluded), "a known failed filter"],
    ["3d YES · 7d YES · 30d YES", `${fmtInt(pass("pass3d").YES || 0)} · ${fmtInt(pass("pass7d").YES || 0)} · ${fmtInt(pass("pass30d").YES || 0)}`, "of evaluated coins"],
    ["Open mapping tasks", fmtInt(ov.openMappingTasks), "ambiguous LBank tickers"],
  ].map(([label, value, sub]) => el("div", { class: "tile" }, el("div", { class: "label" }, label), el("div", { class: "value" }, value), el("div", { class: "sub" }, sub))));
  $("scan-meta").textContent = sc ? `as of ${fmtTime(sc.asOf)} · ruleset ${sc.rulesetVersion} · config ${sc.configVersion} · overrides ${sc.overridesVersion}` : "";
  if (!sc) put($("scan-summary"), el("div", { class: "empty" }, "No scan yet."));
  else {
    const lbc = c.lbankCrawl;
    put($("scan-summary"), kv([
      ["Queue status", lab(QUEUE, sc.queueStatus)],
      ["Current quotes", el("span", null, Object.entries(c.current || {}).map(([k, v]) => chip(`${(CURRENT[k] || [0, k])[1]} ${fmtInt(v)}`, { dot: (CURRENT[k] || [])[0] })))],
      ["LBank status", el("span", null, Object.entries(c.lbank || {}).map(([k, v]) => chip(`${(LBANK[k] || [0, k])[1]} ${fmtInt(v)}`, { dot: (LBANK[k] || [])[0] })))],
      ["LBank Spot list", lbankRow(lbc)],
      ["Stars (evaluated coins)", el("span", null, ["3", "2", "1", "0"].map((k) => chip(`${"★".repeat(+k) || "0"}: ${fmtInt((c.stars || {})[k] || 0)}`)))],
      ["N/A by window", el("span", null, ["reason3d", "reason7d", "reason30d"].map((k) => chip(`${k.slice(6)}: ${fmtInt(Object.values((c.notAvailable || {})[k] || {}).reduce((a, x) => a + x, 0))}`, { title: Object.entries((c.notAvailable || {})[k] || {}).map(([r, n]) => `${reasonText(r)}: ${n}`).join("\n") })))],
      ["Last export", ov.export ? `${fmtTime(ov.export.exportedAt)} · batch ${String(ov.export.batchId).slice(0, 8)}` : "none"],
    ]));
  }
  put($("warnings"), sc && sc.warnings.length ? el("ul", { class: "notes" }, sc.warnings.map((w) => el("li", null, w))) : el("div", { class: "empty" }, "No warnings for the latest scan."));
  const st = S.cfg.strategy, r = st.rules;
  $("rules-version").textContent = `${st.rulesetVersion} · overrides ${st.overrides.version || st.overrides.error || "—"}`;
  put($("rules"), el("ul", { class: "checks" }, [
    `Rank ${r.rankMin}–${r.rankMax} (current CMC rank, inclusive)`,
    `Circulating market cap ≥ ${fmtUsd(r.minMarketCapUsd)} (inclusive)`,
    "Listed ≥ 60 × 24 h since CMC date added (exactly 60 days qualifies)",
    "Not a stablecoin or tokenized stock/asset (CMC tags + versioned overrides); fan tokens stay eligible",
    st.lbank && st.lbank.requireManualVerification
      ? "An LBank Spot pair (any quote currency) that is unambiguously mapped and verified tradable by you"
      : `An LBank Spot pair (any quote currency) in the Markets list of CMC's LBank page, unambiguously mapped (list refreshed every ${st.lbank ? st.lbank.refreshDays : 30} days or on demand)`,
    `VMC = volume ÷ market cap; current = rolling-24h quote (stale after ${st.maxQuoteAgeMinutes} min)`,
    "Means of completed UTC daily ratios over exactly the last 3, 7, 14, 30 days; a missing/invalid day makes only its windows N/A",
    `YES iff current ≥ ${r.passMultiple} × mean (3d, 7d, 30d; 14d is context only); stars = number of YES`,
  ].map((t) => el("li", null, el("span", { class: "mark ok" }, "•"), el("span", null, t), el("span")))));
  const reasons = Object.entries(c.reasons || {}).sort((a, b) => b[1] - a[1]);
  put($("reasons"), reasons.length ? el("div", { class: "bars" }, reasons.map(([k, v]) => [el("div", { class: "name" }, reasonText(k)), el("div", { class: "track" }, barEl(v, reasons[0][1]), el("span", { class: "val" }, fmtInt(v)))])) : el("div", { class: "empty" }, "No exclusions yet."));
  for (const k of ["queue", "eligible", "needs_review", "excluded"]) {
    const n = { queue: c.queue, eligible: c.eligible, needs_review: c.needsReview, excluded: c.excluded }[k];
    $(`count-${k}`).textContent = fmtInt(n ?? 0);
  }
}

function barEl(v, max) {
  const b = el("span", { class: "bar" });
  b.style.width = `${Math.max(2, Math.round((v / (max || 1)) * 220))}px`;
  return b;
}

/* ============================== Sheets ============================== */

const sheetCols = (sheet) => [
  sheet === "queue" ? { label: "#", num: true, render: (r) => r.queueOrder } : { label: "Rank", num: true, render: (r) => r.rank ?? "—" },
  { label: "Coin", render: coinCell },
  sheet === "queue" ? { label: "Rank", num: true, render: (r) => r.rank ?? "—" } : null,
  { label: "Market cap", num: true, render: (r) => fmtUsd(r.capUsd) },
  { label: "Vol 24h", num: true, title: "rolling 24h volume (not this hour)", render: (r) => fmtUsd(r.volume24hUsd) },
  { label: "Current VMC", num: true, title: "rolling 24h volume ÷ market cap", render: (r) => el("span", { title: r.currentStatus !== "OK" ? reasonText(r.currentReason) : null, class: r.currentStatus !== "OK" ? "muted" : null }, fmtVmc(r.currentVmc, false), r.currentStatus !== "OK" ? ` · ${(CURRENT[r.currentStatus] || [0, r.currentStatus])[1]}` : "") },
  { label: "3d", render: (r) => passCell(r.pass3d, r.multiple3d, r.reason3d) },
  { label: "7d", render: (r) => passCell(r.pass7d, r.multiple7d, r.reason7d) },
  { label: "30d", render: (r) => passCell(r.pass30d, r.multiple30d, r.reason30d) },
  { label: "14d mean", num: true, title: "context only", render: (r) => (r.vmc14dAvg === null ? el("span", { class: "muted", title: reasonText(r.avg14dReason) }, "N/A") : fmtVmc(r.vmc14dAvg, false)) },
  { label: "Stars", render: (r) => stars(r.stars) },
  sheet === "eligible" || sheet === "queue" ? null : { label: "Reasons", render: (r) => el("span", null, (r.eligibilityReasons || []).map((x) => chip(reasonText(x)))) },
  { label: "LBank", render: (r) => el("span", null, lab(LBANK, r.lbankStatus), " ", el("span", { class: "hint" }, (r.lbankPairs || []).map((p) => p.marketPair).join(", "))) },
  { label: "Venue", render: (r) => el("span", null, (r.venueFlags || []).map((f) => chip(f.replace(/_/g, " ").toLowerCase()))) },
  { label: "Review", render: (r) => (r.review ? el("span", { class: "small", title: `${r.review.reviewer} · ${fmtTime(r.review.reviewedAt)}` }, `${r.review.finalDecision}${r.review.planStatus ? ` (${r.review.planStatus})` : ""} · venue ${r.review.venueDecision} · day ${r.review.eventDay}`) : el("span", { class: "muted" }, "—")) },
].filter(Boolean);

async function loadSheet(sheet) {
  const sec = $(`tab-${sheet}`);
  const st = S.sheets[sheet];
  const size = Number(sec.querySelector(".sheet-rows").value);
  const q = new URLSearchParams({ sheet, limit: String(size), offset: String(st.page * size) });
  if (st.search) q.set("search", st.search);
  const data = await api(`scan?${q}`);
  sec.querySelector(".sheet-meta").textContent = data.batchId ? `batch ${String(data.batchId).slice(0, 8)} · as of ${fmtTime(data.asOf)}` : "";
  const status = sec.querySelector(".sheet-status");
  if (status) {
    const qs = data.queueStatus;
    put(status, qs && qs !== "PUBLISHED" && qs !== "EMPTY" ? el("div", { class: "banner-note error" }, `${(QUEUE[qs] || [0, qs])[1]}. These rows are shown for inspection only and are not a complete queue.`) : null);
  }
  put(sec.querySelector(".sheet-table"), table(sheetCols(sheet), data.rows, {
    empty: data.batchId ? (sheet === "queue" ? "No eligible coin has a current VMC ≥ 1.5× any of its own 3/7/30-day means." : "No coins in this sheet.") : "No scan yet.",
    onRow: (r, tr) => openAsset(r.cmcId, data.batchId, tr),
  }));
  pager(sec.querySelector(".sheet-pager"), { page: st.page, pageSize: size, total: data.total, onPage: (p) => { st.page = p; void loadSheet(sheet).catch(showError(sheet)); } });
}

/* ============================== Asset drawer (calculation trace + review) ============================== */

async function openAsset(cmcId, batchId, returnFocus) {
  S.drawer = { cmcId, batchId, returnFocus: returnFocus || document.activeElement };
  $("drawer").hidden = false;
  $("drawer-backdrop").hidden = false;
  put($("drawer-body"), el("div", { class: "empty" }, "Loading…"));
  $("drawer-close").focus();
  try {
    const t = await api(`assets/${cmcId}/trace${batchId ? `?batchId=${batchId}` : ""}`);
    renderTrace(t);
  } catch (e) {
    put($("drawer-body"), el("div", { class: "error" }, e.message));
  }
}

function closeDrawer() {
  $("drawer").hidden = true;
  $("drawer-backdrop").hidden = true;
  const back = S.drawer.returnFocus;
  S.drawer = { cmcId: null, batchId: null, returnFocus: null };
  if (back && document.contains(back)) back.focus();
}

function renderTrace(t) {
  const r = t.record, b = t.batch;
  $("drawer-title").textContent = `${r.symbol} · ${r.name}`;
  $("drawer-sub").textContent = `CMC id ${r.cmcId}${r.slug && live() ? ` · coinmarketcap.com/currencies/${r.slug}` : ""} · batch ${String(b.id).slice(0, 8)} (${fmtTime(b.slotTime)})${b.isLive ? "" : " · SYNTHETIC"}`;
  const elig = t.eligibility;
  const head = el("div", { class: "card" },
    el("div", { class: "summary-line" }, lab(ELIG, elig.status), stars(r.stars), lab(LBANK, r.lbankStatus), lab(CURRENT, r.currentStatus), r.inQueue ? chip(`Review Queue #${r.queueOrder}`, { strong: true, dot: "accent" }) : null),
    elig.reasons.length ? el("div", { class: "small" }, "Reasons: ", elig.reasons.map((x) => chip(reasonText(x)))) : null,
    (r.flags.length || r.venueFlags.length) ? el("div", { class: "small" }, "Flags: ", [...r.flags, ...r.venueFlags].map((x) => chip(x))) : null);

  const cur = t.current;
  const current = el("div", { class: "card" }, el("div", { class: "card-head" }, el("h2", null, "Current observation"), el("span", { class: "hint" }, "rolling 24h — not volume traded in the current hour")),
    el("p", { class: "formula" }, cur.formula),
    kv([
      ["Volume 24h (USD)", r.volume24hUsd === null ? "—" : String(r.volume24hUsd)],
      ["Market cap (USD, circulating)", r.capUsd === null ? "—" : String(r.capUsd)],
      ["Price (USD)", fmtPrice(r.priceUsd)],
      ["Provider update time", utc(r.observedAt)],
      ["Crawl time", utc(r.crawledAt)],
      ["Scan time", utc(r.computedAt)],
      ["Rank · listed", `${r.rank ?? "no rank"} · ${utc(r.dateAdded)} (${r.ageDays === null ? "?" : Number(r.ageDays).toFixed(2)} days)`],
      ["Class", `${elig.assetClass} [${elig.classSource}]`],
    ]));

  const windows = el("div", { class: "card" }, el("div", { class: "card-head" }, el("h2", null, "Windows"), el("span", { class: "hint" }, "mean of daily ratios — never Σvolume ÷ Σcap")),
    table([
      { label: "Window", render: (w) => `${w.days}d` },
      { label: "Dates", render: (w) => (w.dates.length ? `${w.dates[w.dates.length - 1]} → ${w.dates[0]}` : "—") },
      { label: "Mean VMC", num: true, render: (w) => (w.mean === null ? el("span", { class: "muted", title: reasonText(w.reason) }, `N/A · ${reasonText(w.reason)}`) : fmtVmc(w.mean)) },
      { label: "Result", render: (w) => (w.pass ? passCell(w.pass.status, w.pass.multiple, w.pass.reason) : el("span", { class: "muted" }, "context only")) },
    ], t.windows),
    el("details", null, el("summary", null, "Formulas"), el("ul", { class: "notes mono" }, t.windows.flatMap((w) => [el("li", null, w.formula), w.comparison ? el("li", null, w.comparison) : null]))));

  const daily = el("div", { class: "card" }, el("div", { class: "card-head" }, el("h2", null, "Completed UTC daily rows used"), el("span", { class: "hint" }, `as of ${t.daily.asOfDate}; the open day is never used`)),
    el("div", { class: "table-wrap" }, table([
      { label: "Day", render: (d) => `T−${d.daysAgo}` },
      { label: "Date", render: (d) => d.dateUtc },
      { label: "Volume (USD)", num: true, render: (d) => (d.volumeUsd === null ? "—" : Number(d.volumeUsd).toLocaleString("en-US")) },
      { label: "Market cap (USD)", num: true, render: (d) => (d.marketCapUsd === null ? "—" : Number(d.marketCapUsd).toLocaleString("en-US")) },
      { label: "VMC", num: true, render: (d) => (d.vmc === null ? el("span", { class: "error" }, d.valid === false ? `invalid: ${d.invalidReasons.join(", ")}` : "missing") : fmtVmc(d.vmc, false)) },
      { label: "Close", num: true, render: (d) => fmtPrice(d.closeUsd) },
      { label: "Rev.", num: true, render: (d) => (d.revision === null ? "—" : `${d.revision}${d.revisedSinceScan ? " (revised since)" : ""}`) },
    ], t.daily.used, { empty: "Not evaluated: no daily rows are requested for excluded coins." })));

  const lb = t.lbank;
  const canWrite = S.cfg.canWrite;
  const decide = (decision, marketPair) => venueDecision(r, decision, marketPair);
  const lbank = el("div", { class: "card" }, el("div", { class: "card-head" }, el("h2", null, "LBank Spot pairs"), el("span", { class: "hint" }, lb.crawl ? `crawl ${lb.crawl.status} · ${fmtTime(lb.crawl.finishedAt)} · ${fmtInt(lb.crawl.fetchedCount)} pairs` : "no crawl")),
    el("p", { class: "small muted" }, S.cfg.strategy.lbank && S.cfg.strategy.lbank.requireManualVerification
      ? "Pairs come from the Markets section of CMC's LBank exchange page (spot), mapped by CMC's own coin id. That list has no trading status, so a pair counts as tradable only after you verify it on LBank. Presence does not prove its listing date or fills."
      : "Pairs come from the Markets section of CMC's LBank exchange page (spot), mapped by CMC's own coin id and refreshed every few weeks or on demand. A listed, unambiguous pair counts as tradable; mark it Not tradable if LBank shows otherwise. Presence does not prove its listing date or fills."),
    table([
      { label: "Pair", render: (p) => el("b", null, p.marketPair) },
      { label: "Mapping", render: (p) => chip(p.mapping, { dot: p.mapping === "OK" || p.mapping === "CONFIRMED" ? "good" : p.mapping === "AMBIGUOUS" ? "serious" : "critical" }) },
      { label: "Trading", render: (p) => chip(`${p.trading}${p.tradingSource ? ` (${p.tradingSource})` : ""}`, { dot: p.trading === "TRADING" ? "good" : p.trading === "UNVERIFIED" ? "warning" : "critical" }) },
      { label: "Vol 24h", num: true, render: (p) => fmtUsd(p.volumeUsd) },
      { label: "Evidence", render: (p) => el("span", { class: "small" }, (p.evidence || []).join("; ")) },
      { label: "", render: (p) => (canWrite ? el("div", { class: "row-actions" },
        p.mapping === "AMBIGUOUS" ? [el("button", { type: "button", class: "btn", onclick: () => decide("MAPPING_CONFIRMED", p.marketPair) }, "Mapping correct"), el("button", { type: "button", class: "btn danger", onclick: () => decide("MAPPING_REJECTED", p.marketPair) }, "Wrong asset")] : null,
        p.trading !== "TRADING" ? el("button", { type: "button", class: "btn primary", onclick: () => decide("VERIFIED_TRADABLE", p.marketPair) }, "Verified tradable") : null,
        el("button", { type: "button", class: "btn danger", onclick: () => decide("NOT_TRADABLE", p.marketPair) }, "Not tradable")) : null) },
    ], lb.pairs, { empty: `No LBank Spot pair maps to this CMC id (${lb.status}${lb.reason ? `: ${lb.reason}` : ""}).` }),
    lb.status === "UNKNOWN" && lb.reason === "PAIR_DISAPPEARED" && canWrite ? el("button", { type: "button", class: "btn danger", onclick: () => decide("NOT_TRADABLE", null) }, "Confirm: no tradable LBank pair") : null,
    lb.tasks.length ? el("div", { class: "small" }, el("b", null, "Mapping tasks: "), lb.tasks.map((x) => chip(`${x.marketPair} ${x.kind} ${x.status}`, { dot: x.status === "OPEN" ? "serious" : "good" }))) : null,
    lb.decisions.length ? el("details", null, el("summary", null, `Decisions (${lb.decisions.length})`), el("ul", { class: "notes" }, lb.decisions.map((d) => el("li", null, `${fmtTime(d.decidedAt)} · ${d.decision} ${d.marketPair || "(asset)"} · ${d.reviewer}${d.note ? ` — ${d.note}` : ""}`)))) : null,
    el("div", { id: "decision-note", class: "small" }));

  const v = t.venues;
  const venueSum = v.summary;
  const venues = el("div", { class: "card" }, el("div", { class: "card-head" }, el("h2", null, "CMC Markets venues"), el("span", { class: "hint" }, venueSum ? `${venueSum.dataStatus} · ${fmtTime(venueSum.observedAt)} · ${venueSum.pairsUsed} of ${venueSum.expectedCount ?? "?"} spot pairs` : "not collected")),
    el("p", { class: "small muted" }, "Where the asset's spot volume is reported (CMC data). Upbit-dominant or single-venue activity is flagged for your judgment; there is no share cutoff and no wash-trading diagnosis. Your venue decision is part of the review below."),
    venueSum ? table([
      { label: "Exchange", render: (e) => e.name },
      { label: "Pairs", num: true, render: (e) => e.pairs },
      { label: "Volume 24h (USD)", num: true, render: (e) => fmtUsd(e.volumeUsd) },
      { label: "Share (CMC %)", num: true, render: (e) => (e.volumePercent === null ? "—" : `${Number(e.volumePercent).toFixed(2)}%`) },
    ], venueSum.exchanges.slice(0, 12)) : el("div", { class: "empty" }, "Venue rows are collected for review candidates (queue, or needs review with a YES)."));

  const reviews = el("div", { class: "card" }, el("div", { class: "card-head" }, el("h2", null, "Review history"), el("span", { class: "hint" }, "append-only: every save is a new revision")),
    table([
      { label: "When", render: (x) => fmtTime(x.reviewedAt) },
      { label: "Batch / rev.", render: (x) => `${String(x.batchId).slice(0, 8)} · r${x.revision}` },
      { label: "Reviewer", render: (x) => x.reviewer },
      { label: "Venue · day", render: (x) => `${x.venueDecision} · ${x.eventDay}` },
      { label: "Decision", render: (x) => `${x.finalDecision}${x.planStatus ? ` (${x.planStatus})` : ""}` },
      { label: "Validation", render: (x) => el("span", { class: "small" }, [...((x.validation && x.validation.errors) || []), ...((x.validation && x.validation.warnings) || [])].join("; ")) },
      { label: "", render: (x) => el("a", { href: `/api/reviews/${x.id}/export`, target: "_blank", rel: "noopener" }, "Export") },
    ], t.reviews, { empty: "No review yet." }));

  put($("drawer-body"), head, current, windows, daily, lbank, venues, reviewForm(t), reviews);
}

async function venueDecision(r, decision, marketPair) {
  const box = $("decision-note");
  const reviewer = savedReviewer();
  if (!reviewer) { put(box, el("span", { class: "error" }, "Enter your name in the review form below first (it is recorded with every decision).")); return; }
  try {
    await apiPost("venue-decisions", { cmcId: r.cmcId, batchId: r.batchId, marketPair: marketPair || null, decision, reviewer, note: ($("rv-venueNote") && $("rv-venueNote").value) || undefined });
    put(box, el("span", { class: "banner-note" }, `${decision} recorded for ${marketPair || "the asset"}. It applies from the next scan — use “Reprocess latest batch” on the Overview to apply it now.`));
    const t = await api(`assets/${r.cmcId}/trace?batchId=${r.batchId}`);
    renderTrace(t);
  } catch (e) {
    put(box, el("span", { class: "error" }, e.message));
  }
}

function savedReviewer() {
  const input = $("rv-reviewer");
  const v = input ? input.value.trim() : "";
  if (v) { try { localStorage.setItem("reviewer", v); } catch { /* storage unavailable */ } return v; }
  try { return localStorage.getItem("reviewer") || ""; } catch { return ""; }
}

function select(id, options, value, allowEmpty = true) {
  return el("select", { id }, allowEmpty ? el("option", { value: "" }, "—") : null, options.map((o) => el("option", { value: o, selected: o === value }, o)));
}
const field = (label, control, hint) => el("label", { class: "field" }, el("span", null, label), control, hint ? el("small", { class: "hint" }, hint) : null);
const input = (id, attrs = {}) => el("input", { id, ...attrs });

/** Tier 1 decisions (venue, event day) and Tier 2 chart review + manual Spot trade plan (PDF p.15, p.24–27). */
function reviewForm(t) {
  const r = t.record, R = S.cfg.review;
  const last = t.reviews.find((x) => x.batchId === r.batchId) || null;
  const pairs = t.lbank.pairs.map((p) => p.marketPair);
  let reviewer = "";
  try { reviewer = localStorage.getItem("reviewer") || ""; } catch { /* storage unavailable */ }
  const plan = (last && last.plan) || {};
  const tp = (i, k) => (plan.targets && plan.targets[i] && plan.targets[i][k]) || "";
  const out = el("div", { id: "rv-result", class: "small", "aria-live": "polite" });
  const form = el("form", { class: "review-form", autocomplete: "off" },
    el("fieldset", null, el("legend", null, "Tier 1 — venue and event day"),
      field("Reviewer", input("rv-reviewer", { value: reviewer, required: true, maxlength: 80 })),
      field("Venue decision", select("rv-venueDecision", R.venueDecisions, (last && last.venueDecision) || "PENDING", false)),
      field("Venue note", input("rv-venueNote", { value: (last && last.venueNote) || "", maxlength: 1000, placeholder: "e.g. only Upbit active; no comparable participation" })),
      field("Event day", select("rv-eventDay", R.eventDays, (last && last.eventDay) || "UNKNOWN", false), "first/second day of unusual volume — your judgment from the daily rows above")),
    el("fieldset", null, el("legend", null, "Tier 2 — 1D chart review (TradingView)"),
      field("Verified LBank pair", select("rv-lbankPair", pairs, last && last.lbankPair)),
      field("Chart exchange", input("rv-chartExchange", { value: (last && last.chartExchange) || "", placeholder: "LBank (preferred) or proxy exchange" })),
      field("Chart symbol", input("rv-chartSymbol", { value: (last && last.chartSymbol) || "", placeholder: `${r.symbol}USDT` })),
      field("Quote currency", input("rv-chartQuote", { value: (last && last.chartQuote) || "" })),
      field("Chart URL", input("rv-chartUrl", { type: "url", value: (last && last.chartUrl) || "" })),
      field("Candle-close timezone", input("rv-chartTimezone", { value: (last && last.chartTimezone) || "", placeholder: "e.g. UTC" }), "CMC daily rows close at 00:00 UTC; an exchange chart may differ"),
      field("Proxy reason (non-LBank chart)", input("rv-chartProxyReason", { value: (last && last.chartProxyReason) || "" })),
      field("Range low vs. top", select("rv-rangeLow", R.judgments, last && last.rangeLow)),
      field("Chart history (real upward waves)", select("rv-chartHistory", R.judgments, last && last.chartHistory)),
      field("Prior pump response", select("rv-priorPumpResponse", R.judgments, last && last.priorPumpResponse)),
      field("Candle state", select("rv-candleState", R.candleStates, last && last.candleState)),
      field("BTC/ETH regime", select("rv-marketRegime", R.marketRegimes, last && last.marketRegime)),
      field("Final decision", select("rv-finalDecision", R.finalDecisions, (last && last.finalDecision) || "REVIEW", false)),
      field("Rationale", el("textarea", { id: "rv-rationale", rows: 3, maxlength: 4000 }, (last && last.rationale) || ""))),
    el("fieldset", null, el("legend", null, "Manual LBank Spot trade plan (PLAN_READY only)"),
      el("p", { class: "small muted" }, "You choose every price. Validation only checks completeness and stop < entry < TP1 < TP2 < TP3; the stop % and the 7 × 24 h time exit are derived. No sizing, order type or execution exists here."),
      field("Entry price (USD)", input("rv-entryPrice", { inputmode: "decimal", value: plan.entryPrice || "" })),
      field("Entry time (UTC)", input("rv-entryTime", { type: "datetime-local", value: plan.entryTime ? plan.entryTime.slice(0, 16) : "" })),
      field("Stop price (USD)", input("rv-stopPrice", { inputmode: "decimal", value: plan.stopPrice || "" }), plan.stopPct ? `stop ${Number(plan.stopPct).toFixed(2)}% below entry` : null),
      [0, 1, 2].map((i) => el("div", { class: "tp-row" }, field(`TP${i + 1} price`, input(`rv-tp${i}-price`, { inputmode: "decimal", value: tp(i, "price") })), field(`TP${i + 1} allocation %`, input(`rv-tp${i}-alloc`, { inputmode: "decimal", value: tp(i, "allocationPct") })))),
      field("Plan notes", el("textarea", { id: "rv-notes", rows: 2, maxlength: 2000 }, plan.notes || "")),
      plan.deadline ? el("div", { class: "small" }, `Time exit: ${utc(plan.deadline)}`) : null),
    el("div", { class: "row-actions" }, el("button", { type: "submit", class: "btn primary", disabled: !S.cfg.canWrite }, last ? "Save new revision" : "Save review"), S.cfg.canWrite ? null : el("span", { class: "error small" }, "Read-only dashboard (set DASHBOARD_BASIC_AUTH or bind to 127.0.0.1).")),
    out);
  form.addEventListener("submit", (e) => { e.preventDefault(); void submitReview(t); });
  return el("div", { class: "card" }, el("div", { class: "card-head" }, el("h2", null, "Review"), el("span", { class: "hint" }, `record for batch ${String(r.batchId).slice(0, 8)}${last ? ` · revision ${last.revision} exists` : ""}`)), form);
}

async function submitReview(t) {
  const r = t.record;
  const v = (id) => { const e = $(id); return e && e.value.trim() ? e.value.trim() : undefined; };
  const reviewer = savedReviewer();
  const targets = [0, 1, 2].map((i) => ({ price: v(`rv-tp${i}-price`), allocationPct: v(`rv-tp${i}-alloc`) })).filter((x) => x.price || x.allocationPct);
  const entryTime = v("rv-entryTime");
  const plan = { entryPrice: v("rv-entryPrice"), entryTime: entryTime ? new Date(`${entryTime}:00Z`).toISOString() : undefined, stopPrice: v("rv-stopPrice"), targets: targets.length ? targets : undefined, notes: v("rv-notes") };
  const hasPlan = Object.values(plan).some((x) => x !== undefined);
  const body = {
    cmcId: r.cmcId, batchId: r.batchId, reviewer, venueDecision: v("rv-venueDecision"), venueNote: v("rv-venueNote"), eventDay: v("rv-eventDay"), lbankPair: v("rv-lbankPair"),
    chartExchange: v("rv-chartExchange"), chartSymbol: v("rv-chartSymbol"), chartQuote: v("rv-chartQuote"), chartUrl: v("rv-chartUrl"), chartTimezone: v("rv-chartTimezone"), chartProxyReason: v("rv-chartProxyReason"),
    rangeLow: v("rv-rangeLow"), chartHistory: v("rv-chartHistory"), priorPumpResponse: v("rv-priorPumpResponse"), candleState: v("rv-candleState"), marketRegime: v("rv-marketRegime"),
    finalDecision: v("rv-finalDecision"), rationale: v("rv-rationale"), plan: hasPlan ? plan : undefined,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  const out = $("rv-result");
  try {
    const res = await apiPost("reviews", body);
    const val = res.validation;
    put(out, el("div", { class: val.planStatus === "INCOMPLETE" ? "error" : "banner-note" }, `Saved revision ${res.review.revision}${val.planStatus ? ` · plan ${val.planStatus}` : ""}.`, val.errors.length ? el("ul", { class: "notes" }, val.errors.map((x) => el("li", null, x))) : null, val.warnings.length ? el("ul", { class: "notes" }, val.warnings.map((x) => el("li", null, `⚠ ${x}`))) : null));
    const fresh = await api(`assets/${r.cmcId}/trace?batchId=${r.batchId}`);
    renderTrace(fresh);
    put($("rv-result"), el("div", { class: "banner-note" }, `Saved revision ${res.review.revision}${val.planStatus ? ` · plan ${val.planStatus}` : ""}${val.errors.length ? ` — ${val.errors.join("; ")}` : ""}${val.warnings.length ? ` — ⚠ ${val.warnings.join("; ")}` : ""}`));
  } catch (e) {
    put(out, el("div", { class: "error" }, `Not saved: ${e.message}`));
  }
}

/* ============================== Batches, health, exports ============================== */

async function loadBatches() {
  const [batches, health, tasks] = await Promise.all([api("batches"), api("health"), api("mapping-tasks?status=OPEN")]);
  const cov = health.coverage, h = cov.sourceHealth || {};
  put($("health-tiles"), [
    ["Source", cov.provider ? cov.provider.name : "—", cov.isLiveData ? "live" : "synthetic"],
    ["Circuit", h.state || "—", h.lastSuccessAt ? `last success ${fmtAgo(h.lastSuccessAt)}` : ""],
    ["Requests this month", fmtInt(h.budgetUsed), cov.monthlyRequestBudget ? `of ${fmtInt(cov.monthlyRequestBudget)} (local budget)` : "no budget"],
    ["Known CMC assets", fmtInt(cov.knownAssets), ""],
  ].map(([l, v, s]) => el("div", { class: "tile" }, el("div", { class: "label" }, l), el("div", { class: "value" }, v), el("div", { class: "sub" }, s))));
  put($("batches"), table([
    { label: "Slot", render: (b) => fmtTime(b.slotTime) },
    { label: "Batch", render: (b) => lab(BATCH, b.status) },
    { label: "Collected", num: true, render: (b) => `${fmtInt(b.collected)} / ${fmtInt(b.listedTotal)}` },
    { label: "Ranks 1–1200", render: (b) => (b.missingRanks.length || b.duplicateRanks.length ? `${b.missingRanks.length} missing · ${b.duplicateRanks.length} duplicate` : "contiguous") },
    { label: "Scan", render: (b) => (b.scan ? lab(RUN, b.scan.status) : "—") },
    { label: "Queue", render: (b) => (b.scan && b.scan.queueStatus ? `${(QUEUE[b.scan.queueStatus] || [0, b.scan.queueStatus])[1]} · ${fmtInt((b.scan.counts || {}).queue)}` : "—") },
    { label: "Eligible / review / excluded", render: (b) => (b.scan && b.scan.counts ? `${fmtInt(b.scan.counts.eligible)} / ${fmtInt(b.scan.counts.needsReview)} / ${fmtInt(b.scan.counts.excluded)}` : "—") },
    { label: "Export", render: (b) => (b.scan ? b.scan.exportStatus || "—" : "—") },
    { label: "Notes", render: (b) => el("span", { class: "small" }, [...(b.statusReasons || []), ...((b.scan && b.scan.warnings) || []).map((w) => w.split(":")[0])].join(", ")) },
  ], batches, { empty: "No crawl batches yet." }));
  put($("tasks"), table([
    { label: "Coin", render: (x) => el("button", { type: "button", class: "linkish", onclick: () => openAsset(x.cmcId, null) }, `CMC ${x.cmcId}`) },
    { label: "LBank pair", render: (x) => x.marketPair },
    { label: "Kind", render: (x) => x.kind },
    { label: "Evidence", render: (x) => el("span", { class: "small" }, JSON.stringify(x.evidence)) },
    { label: "Since", render: (x) => fmtTime(x.createdAt) },
  ], tasks, { empty: "No open mapping tasks." }));
  put($("runs"), table([
    { label: "Slot", render: (r) => fmtTime(r.slotTime) },
    { label: "Kind", render: (r) => r.kind },
    { label: "Status", render: (r) => lab(RUN, r.status) },
    { label: "Stages", render: (r) => el("span", { class: "small" }, (r.stages || []).map((s) => `${s.stage}:${s.status}`).join(" · ")) },
    { label: "Error", render: (r) => el("span", { class: "small error" }, r.error || "") },
  ], health.runs, { empty: "No runs yet." }));
}

async function loadExports() {
  const rows = await api("exports");
  $("exports-meta").textContent = rows.length ? `${rows.length} batches` : "";
  put($("exports"), table([
    { label: "Batch", render: (x) => `${fmtTime(x.asOf)} · ${String(x.batchId).slice(0, 8)}${x.isLive ? "" : " · SYNTHETIC"}` },
    { label: "Status", render: (x) => (x.exportStatus === "succeeded" ? statusLabel("good", "Exported") : statusLabel("critical", `Failed: ${x.error || ""}`)) },
    { label: "Queue", render: (x) => (QUEUE[x.queueStatus] || [0, x.queueStatus || "—"])[1] },
    { label: "Files", render: (x) => (x.available ? el("span", { class: "files" }, (x.exportFiles || []).map((f) => el("a", { href: `/api/exports/${x.batchId}/${f.name}`, title: `sha256 ${f.sha256}` }, `${f.name} (${fmtInt(f.rows)})`)), el("a", { href: `/api/exports/${x.batchId}/manifest.json` }, "manifest.json")) : el("span", { class: "muted" }, "files pruned (database keeps the results)")) },
  ], rows, { empty: "No exports yet." }));
}

/* ============================== Telegram access (unchanged behaviour) ============================== */

let accessBusy = false;
const MISSED_STATE = { pending: ["accent", "Queued"], retrying: ["warning", "Retrying"], gave_up: ["critical", "Gave up"], not_queued: ["", "Not sent"] };

function showAccessNote(kind, text) { put($("access-note"), el("div", { class: kind === "error" ? "error" : "banner-note" }, text)); }

async function changeAccess(action, chatId, doneMsg) {
  if (accessBusy) return;
  accessBusy = true;
  try {
    const r = await apiPost(`telegram/access/${action}`, { chatId });
    await loadAccess();
    if (action === "approve" && r && r.notified === false) showAccessNote("warning", `${doneMsg} — but Telegram would not deliver the welcome message. They must open the bot and press Start.`);
    else showAccessNote("ok", doneMsg);
  } catch (e) {
    showAccessNote("error", `Could not change access: ${e.message}`);
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
    const outcome = d ? `${d.sent} sent${d.failed ? `, ${d.failed} failed` : ""}${d.deferred ? `, ${d.deferred} will retry` : ""}` : r.reason || ((r.queued ?? r.requeued) ? "sending in the background" : "nothing to send");
    showAccessNote(d && d.failed ? "warning" : "ok", `${okMsg}: ${outcome}.`);
  } catch (e) {
    showAccessNote("error", `Could not send: ${e.message}`);
  } finally {
    accessBusy = false;
  }
  await loadAccess().catch(() => undefined);
}

async function loadAccess() {
  const [a, missed] = await Promise.all([api("telegram/access"), api("telegram/missing")]);
  $("count-access").textContent = fmtInt(a.pending.length + missed.rows.length);
  const who = (r) => el("span", null, el("strong", null, r.label), " ", el("span", { class: "hint" }, `id ${r.chatId}`));
  const act = (label, cls, fn) => el("button", { type: "button", class: `btn${cls ? ` ${cls}` : ""}`, disabled: !a.canManage, onclick: fn }, label);
  put($("access-missed"), table([
    { label: "Report hour", render: (r) => fmtTime(r.slotTime) },
    { label: "Person", render: who },
    { label: "State", render: (r) => statusLabel((MISSED_STATE[r.state] || [])[0], (MISSED_STATE[r.state] || [0, r.state])[1]) },
    { label: "Parts", render: (r) => (r.partCount ? `${r.partsSent}/${r.partCount}` : "—") },
    { label: "Why", render: (r) => (r.state === "not_queued" ? "no copy was queued for this person" : r.lastError || "waiting to be sent") },
    { label: "", render: (r) => act(r.state === "not_queued" ? "Send" : "Retry", "", () => void (r.state === "not_queued" ? deliveryAction("telegram/send", { runId: r.runId, chatIds: [r.chatId] }, `Sent to ${r.label}`) : deliveryAction("telegram/retry", { runId: r.runId, chatId: r.chatId }, `Retried ${r.label}`))) },
  ], missed.rows, { empty: missed.mode === "live" ? "No missed reports in the last 6 hours." : `Telegram is ${missed.mode}: nothing is sent.` }));
  $("missed-retry-all").disabled = !a.canManage || !missed.rows.some((r) => r.state !== "not_queued");
  $("send-latest-all").disabled = !a.canManage || missed.mode !== "live";
  if (!a.canManage) showAccessNote("error", "Read-only: set DASHBOARD_BASIC_AUTH (or keep HOST on 127.0.0.1) to approve or reject from the dashboard.");
  else if (a.mode !== "live" || !a.commandsEnabled) showAccessNote("ok", `Telegram is ${a.mode}${a.commandsEnabled ? "" : " and bot commands are off"}: new people can only ask for access when the app runs with TELEGRAM_MODE=live.`);
  else put($("access-note"));
  const when = { label: "Since", render: (r) => (r.at ? fmtTime(r.at) : "") };
  put($("access-pending"), table([{ label: "Person", render: who }, when, { label: "", render: (r) => el("div", { class: "row-actions" }, act("Approve", "primary", () => changeAccess("approve", r.chatId, `Approved ${r.label}.`)), act("Reject", "danger", () => changeAccess("reject", r.chatId, `Rejected ${r.label}.`))) }], a.pending, { empty: "No pending requests." }));
  put($("access-members"), table([{ label: "Person", render: who }, when, { label: "", render: (r) => (r.owner ? el("span", { class: "hint" }, "always allowed") : act("Remove", "danger", () => changeAccess("remove", r.chatId, `Removed ${r.label}.`))) }], [{ chatId: a.owner || "—", label: "Owner", at: null, owner: true }, ...a.members], { empty: "No members." }));
  put($("access-denied"), table([{ label: "Chat id", render: (r) => r.chatId }, { label: "", render: (r) => act("Allow again", "", () => changeAccess("approve", r.chatId, `Approved ${r.chatId}.`)) }], a.denied.map((chatId) => ({ chatId })), { empty: "Nobody rejected." }));
}

/* ============================== Router & refresh ============================== */

const TABS = ["overview", "queue", "eligible", "needs_review", "excluded", "batches", "exports", "access"];
const SHEETS = ["queue", "eligible", "needs_review", "excluded"];
const showError = (where) => (e) => {
  console.error(e);
  const box = SHEETS.includes(where) ? $(`tab-${where}`).querySelector(".sheet-table") : $(where);
  if (box) put(box, el("div", { class: "error" }, `Could not load: ${e.message}`));
};

async function loadTab(tab) {
  if (SHEETS.includes(tab)) await loadSheet(tab).catch(showError(tab));
  else if (tab === "batches") await loadBatches().catch(showError("batches"));
  else if (tab === "exports") await loadExports().catch(showError("exports"));
  else if (tab === "access") await loadAccess().catch(showError("access-pending"));
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

async function refresh(force = false) {
  const [ov, lb] = await Promise.all([api("overview"), api("lbank").catch(() => null)]);
  S.overview = ov;
  S.lbank = lb;
  renderOverview(ov);
  const batch = ov.scan ? ov.scan.batchId : null;
  if (force || batch !== S.lastBatch) {
    S.lastBatch = batch;
    if (S.tab !== "overview" && S.tab !== "access") await loadTab(S.tab);
  }
}

let fastTimer = null;
function watchRun() {
  const running = S.overview && S.overview.latestRun && S.overview.latestRun.status === "running";
  if (running && !fastTimer) {
    fastTimer = setInterval(async () => {
      try {
        await refresh();
        if (!(S.overview.latestRun && S.overview.latestRun.status === "running")) { clearInterval(fastTimer); fastTimer = null; await refresh(true); }
      } catch { /* the 30 s tick reports API errors */ }
    }, 5_000);
  }
}

function initTheme() {
  const btn = $("theme");
  const apply = (m) => { if (m === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = m; btn.textContent = `Theme: ${m}`; };
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
  document.querySelector(".tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = TABS.indexOf(S.tab) + (e.key === "ArrowRight" ? 1 : -1);
    const next = TABS[(i + TABS.length) % TABS.length];
    selectTab(next);
    $(`t-${next}`).focus();
  });
  for (const sheet of SHEETS) {
    const sec = $(`tab-${sheet}`);
    let timer = null;
    sec.querySelector(".sheet-search").addEventListener("input", (e) => { clearTimeout(timer); timer = setTimeout(() => { S.sheets[sheet].search = e.target.value.trim(); S.sheets[sheet].page = 0; void loadSheet(sheet).catch(showError(sheet)); }, 250); });
    sec.querySelector(".sheet-rows").addEventListener("change", () => { S.sheets[sheet].page = 0; void loadSheet(sheet).catch(showError(sheet)); });
  }
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
  window.addEventListener("hashchange", () => { if (!$("drawer").hidden) closeDrawer(); selectTab(location.hash.slice(1), false); });
}

async function start() {
  initTheme();
  wire();
  try {
    S.cfg = await api("config");
    renderHeader();
    await refresh(true);
    void api("telegram/access").then((a) => { $("count-access").textContent = fmtInt(a.pending.length + (a.missingCount || 0)); }).catch(() => undefined);
  } catch (e) {
    $("banner").hidden = false;
    $("banner").textContent = `Failed to load the dashboard: ${e.message}`;
  }
  selectTab(location.hash.slice(1) || "overview", false);
  setInterval(() => { void refresh().then(watchRun).catch((e) => put($("run-strip"), el("div", { class: "error" }, `Could not reach the API: ${e.message}`))); }, 30_000);
  watchRun();
}

void start();
