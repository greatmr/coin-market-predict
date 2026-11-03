// Coins Predicts dashboard. Reads the NestJS JSON API only. All source text is rendered with
// textContent (never innerHTML) because names/symbols come from external sources.
"use strict";

let CFG = { timezone: "Asia/Tehran" };

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "onclick") e.addEventListener("click", v);
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

async function api(path) {
  const r = await fetch(`/api/${path}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

function fmtTime(iso) {
  if (!iso) return "n/a";
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-CA", { timeZone: CFG.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

function fmtNum(n, digits) {
  if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3 && digits === undefined) return (n / 1e3).toFixed(1) + "K";
  if (a >= 1) return n.toFixed(digits ?? 3);
  return n.toPrecision(4);
}
const pct = (x) => (x === null || x === undefined ? "n/a" : (x * 100).toFixed(2) + "%");

function chip(text, kind) {
  return el("span", { class: `chip ${kind || ""}` }, text);
}
const statusKind = { candidate: "good", watch: "warn", insufficient_data: "", no_signal: "bad" };

function table(headers, rows, onRow) {
  if (!rows.length) return el("div", { class: "empty" }, "Nothing to show.");
  const thead = el("thead", {}, el("tr", {}, headers.map((h) => el("th", { class: h.num ? "num" : "" }, h.label))));
  const tbody = el(
    "tbody",
    {},
    rows.map((r) =>
      el("tr", onRow ? { class: "clickable", onclick: () => onRow(r.__raw) } : {}, headers.map((h) => el("td", { class: h.num ? "num" : "" }, r[h.key]))),
    ),
  );
  return el("table", {}, thead, tbody);
}

function sparkline(points) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", "0 0 600 120");
  svg.setAttribute("preserveAspectRatio", "none");
  const vals = points.map((p) => p.v).filter((v) => v !== null);
  if (vals.length < 2) {
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", "8");
    t.setAttribute("y", "60");
    t.textContent = "Warm-up: not enough snapshots for a chart yet";
    svg.append(t);
    return svg;
  }
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  let d = "";
  points.forEach((p, i) => {
    if (p.v === null) return;
    const x = (i / (points.length - 1)) * 590 + 5;
    const y = 110 - ((p.v - min) / span) * 100;
    d += `${d ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  svg.append(path);
  for (const [y, v] of [[12, max], [118, min]]) {
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", "8");
    t.setAttribute("y", String(y));
    t.textContent = fmtNum(v);
    svg.append(t);
  }
  return svg;
}

async function loadConfig() {
  CFG = await api("config");
  const b = $("badges");
  b.replaceChildren(
    el("span", { class: `badge ${CFG.isLiveData ? "" : "fixture"}` }, CFG.isLiveData ? `LIVE · ${CFG.providerName}` : "FIXTURE · synthetic data"),
    el("span", { class: "badge" }, `agents: ${CFG.agentProvider}${CFG.agentAvailability && !CFG.agentAvailability.available ? " (unavailable)" : ""}`),
    el("span", { class: "badge" }, `telegram: ${CFG.telegramMode}`),
    el("span", { class: "badge" }, `tz: ${CFG.timezone}`),
  );
  if (!CFG.isLiveData) {
    $("banner").hidden = false;
    $("banner").textContent = "Fixture mode: all prices, volumes and signals on this page are SYNTHETIC test data, not real market data.";
  }
  $("footer").textContent = `${CFG.attribution || ""} · Research hypotheses only — not financial advice. Hourly snapshots cannot observe intrahour moves. Scores are heuristics, not probabilities. No orders are placed.`;
}

async function loadSignals() {
  const status = $("f-status").value;
  const cls = $("f-class").value;
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  if (cls) q.set("classification", cls);
  const data = await api(`signals?${q}`);
  const rows = data.signals.map((s) => ({
    __raw: s,
    token: el("span", {}, el("b", {}, s.asset.symbol), " ", el("span", { class: "muted" }, s.asset.name)),
    status: chip(s.status, statusKind[s.status]),
    type: s.signalType === "move_underway" ? "underway (detection)" : s.signalType,
    score: fmtNum(s.heuristicScore, 1),
    agent: s.agentScore === null ? "–" : fmtNum(s.agentScore, 0),
    horizon: `${s.horizonHours}h`,
    entry: s.scenario && s.scenario.entryRule ? s.scenario.entryRule : s.entryTrigger,
    risk: el("span", {}, (s.riskFlags || []).slice(0, 4).map((f) => chip(f, "bad"))),
    origin: chip(s.origin, s.origin === "agent" ? "good" : ""),
    expires: fmtTime(s.expiresAt),
  }));
  $("signals").replaceChildren(
    table(
      [
        { key: "token", label: "Token" }, { key: "status", label: "Status" }, { key: "type", label: "Type" },
        { key: "score", label: "Heuristic", num: true }, { key: "agent", label: "Agent", num: true }, { key: "horizon", label: "Horizon" },
        { key: "entry", label: "Entry trigger" }, { key: "risk", label: "Risk flags" }, { key: "origin", label: "Origin" }, { key: "expires", label: "Expires" },
      ],
      rows,
      (s) => showDetail(s.assetId, s),
    ),
  );
  if (!rows.length) $("signals").append(el("div", { class: "empty" }, "No qualifying signals in the latest run. That is a normal outcome."));
}

async function loadScreening() {
  const cls = $("f-screen").value;
  const q = new URLSearchParams({ eligibleOnly: "true", limit: "100" });
  if (cls) q.set("classification", cls);
  const data = await api(`screening?${q}`);
  const rows = data.results.map((r) => ({
    __raw: r,
    rank: r.rank,
    token: el("span", {}, el("b", {}, r.asset.symbol), " ", el("span", { class: "muted" }, r.asset.name)),
    cls: r.classification,
    score: fmtNum(r.heuristicScore, 1),
    short: r.shortlisted ? chip("shortlisted", "good") : "",
    flags: el("span", {}, (r.riskFlags || []).slice(0, 4).map((f) => chip(f))),
  }));
  $("screening").replaceChildren(
    table([{ key: "rank", label: "#", num: true }, { key: "token", label: "Token" }, { key: "cls", label: "Classification" }, { key: "score", label: "Score", num: true }, { key: "short", label: "" }, { key: "flags", label: "Risk flags" }], rows, (r) => showDetail(r.assetId)),
  );
}

async function showDetail(assetId, signal) {
  const [asset, snaps, feats] = await Promise.all([api(`assets/${assetId}`), api(`assets/${assetId}/snapshots?hours=168`), api(`assets/${assetId}/features`)]);
  $("detail-section").hidden = false;
  $("detail-title").textContent = `${asset.symbol} — ${asset.name}`;
  const s = snaps.snapshots;
  const latest = s[s.length - 1];
  const f = feats.features[0];
  const ident = el("dl", { class: "kv" },
    el("dt", {}, "Canonical id"), el("dd", {}, asset.id),
    el("dt", {}, "Class"), el("dd", {}, asset.assetClass),
    el("dt", {}, "Provider ids"), el("dd", {}, asset.identities.map((i) => `${i.providerId}:${i.providerAssetId}`).join(", ")),
    el("dt", {}, "Contracts"), el("dd", {}, asset.contracts.length ? asset.contracts.map((c) => `${c.chain}:${c.contractAddress}`).join(", ") : "none recorded"),
    el("dt", {}, "Price"), el("dd", {}, latest ? fmtNum(latest.price) : "n/a"),
    el("dt", {}, "Market cap"), el("dd", {}, latest ? `${fmtNum(latest.marketCap)} (${latest.marketCapProvenance})` : "n/a"),
    el("dt", {}, "Volume"), el("dd", {}, latest ? `${fmtNum(latest.volumeRolling24h)} — rolling 24h` : "n/a"),
    el("dt", {}, "Observed"), el("dd", {}, latest ? `${fmtTime(latest.observedAt)} (collected ${fmtTime(latest.collectedAt)})` : "n/a"),
    el("dt", {}, "Quality"), el("dd", {}, latest ? (latest.qualityFlags.length ? latest.qualityFlags.join(", ") : "no flags") : "n/a"),
    el("dt", {}, "Source"), el("dd", {}, latest ? latest.sourceUrl : "n/a"),
    el("dt", {}, "History"), el("dd", {}, f ? `${f.historyDepth} consecutive hourly snapshots (${f.warmupState})` : "n/a"),
  );
  const featList = f
    ? el("table", {}, el("tbody", {}, Object.keys(f.values).map((k) => el("tr", {}, el("td", {}, k), el("td", { class: "num" }, f.values[k] === null ? el("span", { class: "muted" }, f.unavailable[k] || "n/a") : f.values[k].toFixed(4))))))
    : el("div", { class: "empty" }, "No features yet.");
  const parts = [el("div", { class: "two" }, el("div", {}, el("h2", {}, "Price (hourly snapshots)"), sparkline(s.map((x) => ({ v: x.price }))), ident), el("div", {}, el("h2", {}, "Features"), featList))];
  if (signal) {
    parts.push(
      el("div", { class: "two" },
        el("div", {}, el("h2", {}, "Evidence"), el("ul", { class: "list" }, signal.evidence.map((e) => el("li", {}, `${e.metric} = ${e.value} @ ${fmtTime(e.observedAt)} — ${e.interpretation}`)))),
        el("div", {}, el("h2", {}, "Counterevidence"), el("ul", { class: "list" }, signal.counterevidence.map((c) => el("li", {}, c.point)))),
      ),
      el("div", { class: "two" },
        el("div", {}, el("h2", {}, "Paper scenario"), el("dl", { class: "kv" },
          el("dt", {}, "Entry"), el("dd", {}, signal.scenario.entryRule || signal.entryTrigger),
          el("dt", {}, "Invalidation"), el("dd", {}, signal.scenario.stopRule || signal.invalidation),
          el("dt", {}, "Target"), el("dd", {}, signal.scenario.targetRule || signal.exitConditions.target),
          el("dt", {}, "Trailing"), el("dd", {}, signal.scenario.trailingRule || signal.exitConditions.trailing),
          el("dt", {}, "Costs"), el("dd", {}, `${signal.scenario.feeBps} bps fee + ${signal.scenario.slippageBps} bps slippage per side`),
          el("dt", {}, "Execution"), el("dd", {}, signal.scenario.executionAssumption || ""),
        )),
        el("div", {}, el("h2", {}, "Data quality & review"), el("dl", { class: "kv" },
          el("dt", {}, "Assessment"), el("dd", {}, signal.dataQuality.assessment),
          el("dt", {}, "Issues"), el("dd", {}, (signal.dataQuality.issues || []).join(", ") || "none"),
          el("dt", {}, "Guardrails"), el("dd", {}, (signal.dataQuality.guardrailNotes || []).join("; ") || "none"),
          el("dt", {}, "Review"), el("dd", {}, signal.reviewOutcome || "n/a"),
          el("dt", {}, "Rationale"), el("dd", {}, signal.rationale),
        )),
      ),
    );
  }
  $("detail").replaceChildren(...parts);
  $("detail-section").scrollIntoView({ behavior: "smooth" });
}

async function loadHealth() {
  const h = await api("health");
  const c = h.coverage;
  const cov = c.lastRunCoverage || {};
  const sh = c.sourceHealth || {};
  $("health").replaceChildren(
    el("dl", { class: "kv" },
      el("dt", {}, "Provider"), el("dd", {}, c.provider ? `${c.provider.name}${c.isLiveData ? "" : " (synthetic)"}` : "n/a"),
      el("dt", {}, "Known assets"), el("dd", {}, `${c.knownAssets} (${c.activeIdentities} active identities)`),
      el("dt", {}, "Last discovery"), el("dd", {}, c.lastDiscovery ? `${fmtTime(c.lastDiscovery.startedAt)} — ${c.lastDiscovery.status}, ${c.lastDiscovery.assetsSeen} seen, ${c.lastDiscovery.coverageComplete ? "complete listing" : "PARTIAL listing"}` : "never"),
      el("dt", {}, "Last run coverage"), el("dd", {}, cov.label ? `${cov.label}: ${cov.collected}${cov.universeSize ? "/" + cov.universeSize : ""}${cov.coveragePct !== null && cov.coveragePct !== undefined ? ` (${cov.coveragePct.toFixed(1)}%)` : ""}` : "n/a"),
      el("dt", {}, "Stale"), el("dd", {}, cov.stale ?? "n/a"),
      el("dt", {}, "Missing fields"), el("dd", {}, cov.missingFields ? Object.entries(cov.missingFields).map(([k, v]) => `${k}: ${v}`).join(", ") : "n/a"),
      el("dt", {}, "Circuit"), el("dd", {}, sh.state ? `${sh.state}${sh.suspendedReason ? " — " + sh.suspendedReason : ""}; budget used ${sh.budgetUsed}` : "no requests yet"),
    ),
  );
  const runs = h.runs.map((r) => ({
    slot: fmtTime(r.slotTime),
    status: chip(r.status, r.status === "succeeded" ? "good" : r.status === "partial" || r.status === "missed" ? "warn" : r.status === "failed" ? "bad" : ""),
    stages: el("span", {}, (r.stages || []).map((s) => chip(`${s.stage}:${s.status}`, s.status === "succeeded" ? "good" : s.status === "failed" ? "bad" : ""))),
    cov: r.coverage ? `${r.coverage.label} ${r.coverage.collected}` : "",
    cost: r.modelCostUsd ? `$${Number(r.modelCostUsd).toFixed(4)}` : "$0",
    err: r.error ? r.error.slice(0, 120) : "",
  }));
  $("runs").replaceChildren(table([{ key: "slot", label: "Slot" }, { key: "status", label: "Status" }, { key: "stages", label: "Stages" }, { key: "cov", label: "Coverage" }, { key: "cost", label: "Model cost", num: true }, { key: "err", label: "Error" }], runs));
}

async function loadPaper() {
  const p = await api("paper");
  const s = p.summary;
  $("paper").replaceChildren(
    el("dl", { class: "kv" },
      el("dt", {}, "Positions"), el("dd", {}, `${s.total} (open ${s.open}, pending entry ${s.pendingEntry}, closed ${s.closed}, expired ${s.expiredWithoutEntry})`),
      el("dt", {}, "Win rate"), el("dd", {}, s.winRate === null ? "pending" : pct(s.winRate)),
      el("dt", {}, "Avg net return"), el("dd", {}, s.avgNetReturn === null ? "pending" : pct(s.avgNetReturn)),
      el("dt", {}, "Ambiguous ordering"), el("dd", {}, s.ambiguousOrdering),
    ),
    el("p", { class: "muted" }, s.note),
    table(
      [{ key: "sym", label: "Token" }, { key: "status", label: "Status" }, { key: "entry", label: "Entry", num: true }, { key: "exit", label: "Exit", num: true }, { key: "reason", label: "Reason" }, { key: "net", label: "Net", num: true }],
      p.positions.slice(0, 15).map((x) => ({ sym: x.signal.asset.symbol, status: x.status, entry: fmtNum(x.entryPrice), exit: fmtNum(x.exitPrice), reason: x.exitReason || "", net: x.netReturn === null ? "" : pct(x.netReturn) })),
    ),
  );
}

async function loadBacktest() {
  const b = await api("backtest").catch(() => null);
  if (!b) {
    $("backtest").replaceChildren(el("div", { class: "empty" }, "No backtest yet. Run `npm run cli -- backtest`."));
    return;
  }
  const r = b.report;
  if (r.status !== "completed") {
    $("backtest").replaceChildren(el("div", { class: "empty" }, `Evaluation pending: ${r.reason}`));
    return;
  }
  const m = (x) => (x ? `${x.signals} signals, ${x.trades} trades, precision ${pct(x.precision)}, FPR ${pct(x.falsePositiveRate)}, avg net ${pct(x.avgNetReturn)}, total ${pct(x.totalNetReturn)}, max DD ${pct(x.maxDrawdown)}` : "n/a");
  $("backtest").replaceChildren(
    el("p", {}, b.isLiveData ? "" : el("b", {}, "Synthetic fixture data — says nothing about real-market performance. ")),
    el("dl", { class: "kv" },
      el("dt", {}, "Period"), el("dd", {}, `${fmtTime(r.periodStart)} → ${fmtTime(r.periodEnd)}`),
      el("dt", {}, "Strategy"), el("dd", {}, m(r.strategy)),
      el("dt", {}, "Momentum baseline"), el("dd", {}, m(r.momentumBaseline)),
      el("dt", {}, "BTC buy & hold"), el("dd", {}, `${pct(r.btcBuyHold.avgReturnPerWindow)} avg per ${r.btcBuyHold.windows} windows`),
      el("dt", {}, "Market median"), el("dd", {}, `${pct(r.marketMedian.avgReturnPerWindow)} avg per window`),
      el("dt", {}, "Final test"), el("dd", {}, r.finalTest ? m(r.finalTest.strategy) : "held out (untouched)"),
      el("dt", {}, "Calibration"), el("dd", {}, r.calibration),
    ),
    el("ul", { class: "list muted" }, r.assumptions.map((a) => el("li", {}, a))),
  );
}

async function loadVmc() {
  const c = await api("vmc/comparison");
  $("vmc-meta").textContent = `${c.isFixture ? "SYNTHETIC FIXTURE DATA · " : ""}generated ${fmtTime(c.generatedAt)}`;
  const rows = c.rows.map((r) => ({
    id: r.cmcId,
    sym: el("span", {}, el("b", {}, r.symbol), " ", el("span", { class: "muted" }, r.name)),
    obs: r.observationTimeUtc ? `${r.observationTimeUtc.slice(0, 16).replace("T", " ")} UTC${r.quoteAgeMinutes !== null ? ` (${r.quoteAgeMinutes}m)` : ""}` : "n/a",
    vol: r.volume24hUsd === null ? "n/a" : fmtNum(Number(r.volume24hUsd)),
    mcap: r.marketCapUsd === null ? "n/a" : fmtNum(Number(r.marketCapUsd)),
    cur: r.currentRatio ?? "n/a",
    base: r.baselineMean ?? "n/a",
    cov: r.baselineCoverage,
    mult: r.ratioToBaseline,
    win: r.recentWindow,
    st: el("span", {}, r.dataStatus.map((s) => chip(s, s === "ok" ? "good" : "warn"))),
  }));
  $("vmc").replaceChildren(
    table(
      [
        { key: "id", label: "CMC ID", num: true }, { key: "sym", label: "Symbol" }, { key: "obs", label: "Observation time" },
        { key: "vol", label: "Volume 24h USD", num: true }, { key: "mcap", label: "Market cap USD", num: true },
        { key: "cur", label: "Current ratio", num: true }, { key: "base", label: "Baseline mean", num: true },
        { key: "cov", label: "Baseline coverage" }, { key: "mult", label: "Cur/Base" }, { key: "win", label: "72h window" }, { key: "st", label: "Data status" },
      ],
      rows,
    ),
  );
  if (!rows.length) $("vmc").append(el("div", { class: "empty" }, "No assets configured (set VMC_ASSET_IDS)."));
}

async function refresh() {
  const tasks = [loadSignals, loadScreening, loadHealth, loadPaper, loadBacktest, loadVmc];
  await Promise.all(tasks.map((t) => t().catch((e) => console.error(e))));
}

$("f-status").addEventListener("change", () => loadSignals());
$("f-class").addEventListener("change", () => loadSignals());
$("f-screen").addEventListener("change", () => loadScreening());
$("detail-close").addEventListener("click", () => ($("detail-section").hidden = true));

loadConfig().then(refresh).catch((e) => {
  $("banner").hidden = false;
  $("banner").textContent = `Failed to load: ${e.message}`;
});
setInterval(refresh, 60_000);
