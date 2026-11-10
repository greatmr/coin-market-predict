# Two-Tier VMC Strategy — specification

Source: **"Two-Tier VMC Strategy — CoinMarketCap screening → TradingView technical review"**
(LBank Spot developer handoff, 05 Nov 2026, 28 pages; `CMC_Volume_MarketCap_Data_Flow_EN_New.pdf`).
Page references are written `(p.N)`. This document is the project's strategy specification; the
input mapping is in [tier1-input-mapping.md](tier1-input-mapping.md) and the implementation plan
in [implementation-plan.md](implementation-plan.md).

> Research and review tooling only. Nothing here places orders, sizes positions, predicts
> prices or claims accuracy. A VMC result never forces an entry (p.27).

## 1. Purpose and boundaries

| Item | Specification | Page |
|---|---|---|
| Purpose | Screen CoinMarketCap assets for unusual trading activity measured as Volume ÷ Market Cap (VMC) against each asset's own recent daily averages, and hand a documented shortlist to a human chart review | p.1 |
| Tier 1 | Deterministic CMC screener: filter assets, compute 3d/7d/30d VMC outcomes, review venue volume and LBank Spot availability, deliver a candidate table | p.1, p.3–22 |
| Tier 2 | Human TradingView 1D review and a manually completed LBank Spot trade plan; nothing automated | p.1, p.23–28 |
| Order | Tier 1 and its acceptance tests first; Tier 2 consumes Tier 1 records | p.1, p.2, p.28 |
| Input boundary | The existing crawler and its stored records; no replacement crawler, no new CMC API client | p.2, p.8, p.22 |
| Explicit exclusions | New API integration, six-month baseline, 72-hour hourly backfill, Volatility fields, independent dollar-volume gate, global VMC > 0.30 gate, auto-orders, automatic chart-based buy signals | p.2, p.14, p.22 |
| Decision precedence | 1 later direct user decisions; 2 existing crawler and stored records; 3 this specification; 4 screenshots show navigation only; 5 visual judgments stay human review fields | p.2 |

Screenshots (p.3–7) identify CMC pages and labels — main listing with *Columns*, a coin page with
*See historical data* and the *Markets* table, the daily *Historical Data* table (Date, Open, High,
Low, Close, Volume, Market Cap) and the *Volume / Mcap* column — they are **not** test data (p.2, p.8).

## 2. Inputs (p.8, p.11, p.12, p.22)

Per crawl batch, per CMC asset: CMC id, current CMC rank, name, symbol, slug, tags, `date_added`,
USD price, USD circulating market cap, USD rolling-24h volume, provider update time, crawl time.
Per asset and completed UTC day: USD daily volume, USD market cap at that day's close, close
timestamp, crawl timestamp, source identifier (plus close price for event-day review, p.15).
Per venue: exchange, spot pair, base-asset mapping, quote currency, USD 24h pair volume, observed
time; for LBank: the published Spot pair and its observed/status evidence.

Input acceptance gate (p.8): daily rows are completed UTC days; current volume is rolling 24h (not
an hourly bucket); current volume and cap come from the same observation; provider update time,
crawl time and scan time are kept apart. A missing field is reported with the affected rule,
an example record and the needed upstream change, and the dependent output is N/A or PENDING —
never sourced from an unrelated site or inferred from a screenshot (p.8, p.22).

## 3. Flow

```
existing crawler batch (hourly CMC listing)          ← trigger: after each successful batch (p.12)
  → validate + store current observations (rank, cap, volume, price, date_added, tags, times)
  → LBank Spot markets list (Markets section of CMC's LBank page; fetched once,
    refreshed every 30 days or on demand — operator decision D2)        (p.10)
  → completed UTC daily rows for screen candidates (existing history route) (p.11)
  → Tier 1 scan: eligibility → current VMC → window means → 3d/7d/30d outcomes → stars → queue
  → CMC Markets venue rows for review candidates                         (p.15)
  → exports: CSV + XLSX (All_Eligible, Review_Queue, Needs_Review, Excluded, Run_Metadata) (p.17)
  → dashboard / MCP / Telegram summary (queue withheld when incomplete)  (p.18)
human: venue decision, event day, LBank verification (Tier 1); chart review + trade plan (Tier 2)
```

No second hourly fetch job and no 72-hour backfill (p.12). The Star Event Forward Test add-on
([forward-test.md](forward-test.md)) runs after `notify` on the published queue; it reads Tier 1
results and changes none of the rules in this document. A missing batch is a visible gap and is
never filled with invented snapshots (p.12, p.18).

## 4. Eligibility (p.3, p.9, p.10, p.18)

Evaluated on every scan for every asset in the batch. Boundaries are inclusive.

| Rule | Pass | Known failure → EXCLUDED | Missing / ambiguous → NEEDS_REVIEW |
|---|---|---|---|
| Rank | current CMC rank 101–1200 (no page heuristic) | `RANK_OUT_OF_RANGE` | `RANK_MISSING` (no rank), `RANK_AMBIGUOUS` (duplicate rank in batch) |
| Market cap | USD circulating cap ≥ 15,000,000 | `MARKET_CAP_BELOW_MIN` | `MARKET_CAP_MISSING` (null, 0, or not provider-reported) |
| Listing age | ≥ 60 × 24 h since CMC `date_added` (exactly 60 days qualifies) | `LISTING_AGE_BELOW_60D` | `DATE_ADDED_MISSING` |
| Class | not a stablecoin, not a tokenized stock/asset; fan tokens stay eligible | `STABLECOIN`, `TOKENIZED_ASSET` (CMC tags or override) | `CLASS_AMBIGUOUS:<kind>` (wrapped/bridged/staked tags, name/price heuristics without a CMC tag) |
| LBank Spot pair | an active, unambiguously mapped, **tradable** LBank Spot pair (any quote currency); a pair in the LBank Spot markets list counts as tradable (D1) | `NO_LBANK_SPOT_PAIR` (usable complete list, never listed), `LBANK_NOT_TRADABLE` (reviewer decision) | `LBANK_STATUS_UNKNOWN:<reason>` (list missing, incomplete or older than `LBANK_PAIRS_MAX_AGE_DAYS`, ambiguous mapping, pair disappeared); `LBANK_PAIR_UNVERIFIED` only with `LBANK_REQUIRE_MANUAL_VERIFICATION=true` |

Status: **EXCLUDED** if any rule has a known failure (all reasons kept); else **NEEDS_REVIEW** if any
rule is missing/ambiguous; else **ELIGIBLE**. Excluded records and reasons are kept (p.9). Classes
come from CMC tags plus a documented, versioned manual override list (`config/tier1-overrides.json`,
p.9). No LBank listing-age filter exists; pair presence does not prove listing date or fills (p.9, p.10).

### LBank pair status (p.10)

| Status | Meaning |
|---|---|
| `VERIFIED` | Pair is in a usable, complete LBank Spot markets list, mapped to this CMC id by the crawler's own identity mapping, and either listed there (D1, default), proven by a feed trading status, **or** confirmed by a reviewer's `VERIFIED_TRADABLE` decision made after the pair's current continuous listing began |
| `PAIR_LISTED_UNVERIFIED` | Only with `LBANK_REQUIRE_MANUAL_VERIFICATION=true` (assumption A7): listed and mapped, but no trading-status proof; a human must verify it before it is called tradable |
| `NOT_LISTED` | Usable, complete list; no Spot pair maps to the asset and none did before |
| `NOT_TRADABLE` | Reviewer recorded that no listed pair is tradable (overrides the listing) |
| `UNKNOWN` | List missing, incomplete or older than `LBANK_PAIRS_MAX_AGE_DAYS`; LBank base ticker ambiguous (a saved mapping-evidence task is opened); or a previously listed pair disappeared — withheld until re-verified |

LBank pair status and CMC venue distribution are separate fields (p.10).

## 5. VMC arithmetic (p.5, p.6, p.11, p.13, p.14)

Completed dates are the UTC dates before the scan's as-of date (T): window N uses exactly dates
T−1 … T−N. "Today" is never used (p.5, p.11).

```
daily_vmc[d]  = daily_volume_usd[d] / daily_market_cap_usd[d]   valid iff finite volume ≥ 0 and finite cap > 0
mean_N        = arithmetic_mean(daily_vmc[T−1..T−N])            N ∈ {3, 7, 14, 30}
current_vmc   = current_volume_24h_usd / current_market_cap_usd  (same observation, USD)
multiple_N    = current_vmc / mean_N                             N ∈ {3, 7, 30}
pass_N        = multiple_N ≥ 1.5                                 YES / NO / N/A
stars         = count(pass_N = YES), N ∈ {3, 7, 30}              0–3
```

- Mean of daily ratios — never Σvolume/Σcap, never mean volume ÷ mean cap (p.13, p.19 C).
- A missing or invalid date makes only the windows containing it N/A; no zero substitution, no
  skipping, no shorter mean under the same name (p.11, p.19 D).
- Exact decimal arithmetic; comparisons on unrounded values; exactly 1.5× is YES (p.13, p.19 A).
- `mean_N = 0` → N/A `ZERO_BASELINE`. Current cap ≤ 0 or missing, volume < 0 or missing, non-finite
  input, stale or unverified quote → every comparison N/A (p.13, p.19 E).
- The 14-day mean is context only: no status, no star, no queue gate (p.6, p.14).
- Optional diagnostics if data is present (never pass/fail): `vol_avg_N` and
  `vol_ratio_24h_N = volume_24h / vol_avg_N` (p.14).
- VMC shown as ratio and percent (0.20 = 20%); 1.5× is a multiple, not percentage points (p.13).
  Numerator and denominator are shown beside every ratio because a high VMC can come from a falling
  market cap (p.14). No "smart money" label (p.14).

### Current observation status (p.12, p.13)

`OK`, `STALE` (crawl time − provider update time > max_quote_age), `TIMESTAMP_UNVERIFIED` (no
provider time, or provider time in the future), `MISMATCHED` (volume and cap not from one snapshot),
`MISSING` (asset absent from the batch), `INVALID` (cap ≤ 0 / volume < 0 / non-numeric). Anything but
`OK` makes all comparisons N/A. `max_quote_age` = 2 × the crawler's documented interval (hourly →
120 minutes, configurable; p.12). The current ratio is labelled "rolling 24h, observed at … UTC";
it is not volume traded in the current hour (p.12).

## 6. Outputs and priority (p.7, p.14, p.17)

- **All Eligible**: every ELIGIBLE asset, including 0-star and failing rows (p.14).
- **Review Queue**: ELIGIBLE assets with ≥ 1 YES (p.14), ranked by the weighted star ranking
  (§ 6a, operator decision D3; it replaced the p.14 sort by `pass_3d`, `pass_7d`, `pass_30d`).
  Mixed results (e.g. YES/NO/YES) stay visible with exact multiples (p.7).
- **Needs Review**, **Excluded** with reason codes, **Run_Metadata** (p.17).
- Exports: UTF-8 CSV and an Excel workbook; one row per CMC id and crawl batch; ratios as plain
  decimals (no `%`), full precision in machine output, ISO 8601 UTC with `Z`, N/A as a status with
  a blank numeric value and a reason code — never 0 or infinity (p.17).
- Mandatory columns: `crawl_batch_id, observed_at_utc, cmc_id, symbol, name, rank, age_days,
  price_usd, cap_usd, volume_24h_usd, current_vmc, vmc_3d_avg, vmc_7d_avg, vmc_14d_avg, vmc_30d_avg,
  multiple_3d, multiple_7d, multiple_30d, pass_3d, pass_7d, pass_30d, stars, eligibility_status,
  lbank_pairs, venue_review, event_day, flags, source_updated_at` (p.17).
- These are presentation rules, not trading rules (p.14).
- Ranking columns after `queue_order`: `weighted_pass_points`, `score_complete`,
  `weighted_strength`, `ranking_ruleset_version`; `Run_Metadata` names the ranking and its rule.

## 6a. Weighted star ranking (`weighted_star_v1`, operator decision D3)

Source: *CMC Scanner — Weighted Star Ranking Addendum* v1.0, 10 Nov 2026. It ranks the scanner's
own results; stars, passes, the 1.5× threshold, the 14-day context, eligibility, LBank and Tier 2
are unchanged, so `RULESET_VERSION` stays `vmc-tier1-1` and every row also records
`ranking_ruleset_version = weighted_star_v1`.

```
weighted_pass_points = 60 × I(pass_3d = YES) + 25 × I(pass_7d = YES) + 15 × I(pass_30d = YES)
score_complete       = all three results are YES or NO (an N/A makes the points a lower bound)
weighted_strength    = 0.60 × min(multiple_3d, 3.0) + 0.25 × min(multiple_7d, 3.0)
                     + 0.15 × min(multiple_30d, 3.0)        only with three valid multiples, else NULL
```
An N/A earns no points, stays N/A with its reason, and its weight is never redistributed. The cap
applies only inside `weighted_strength`; stored multiples are never capped. Everything is
computed from the scan's unrounded values; stored values are rounded to 30 dp for storage only.

Queue order: `stars` descending (every 3-star row before every 2-star row, and so on) →
`weighted_pass_points` descending → complete scores first → `weighted_strength` descending, NULL
last → `multiple_3d` descending, NULL last → CMC id ascending. Points never override stars: a
2-star NO/YES/YES row (40) precedes a 1-star YES/NO/NO row (60).

| 3d | 7d | 30d | Stars | Points |
|---|---|---|---|---|
| YES | YES | YES | 3 | 100 |
| YES | YES | NO | 2 | 85 |
| YES | NO | YES | 2 | 75 |
| NO | YES | YES | 2 | 40 |
| YES | NO | NO | 1 | 60 |
| NO | YES | NO | 1 | 25 |
| NO | NO | YES | 1 | 15 |

The 60 / 25 / 15 weights are an initial product decision, not a probability or a forecast; the
windows overlap, so the scores are prioritization features, not independent confirmations. They are
evaluated prospectively with the [forward test](forward-test.md) (outcomes by star count, pass
pattern and weighted-points band). A revision gets a new `ranking_ruleset_version`; stored scores
and event snapshots are never rewritten, and a revision is judged on later, unseen detections.
Scan rows stored before the ranking keep NULL ranking fields and the order they were published
with; reprocessing a stored batch ranks it with the current version.

## 7. Human review fields (p.15, p.24–27)

Tier 1 (p.15): `event_day` FIRST / SECOND / LATER / UNKNOWN marked by the trader beside the last
3–7 completed daily volume, VMC and close; `venue_decision` ACCEPT / REJECT / PENDING with a note
(machine `venue_review` stays PENDING until then; Upbit-dominant or single-venue activity is flagged,
never auto-rejected; no wash-trading diagnosis); LBank pair verification.

Tier 2 (p.24–27): chart exchange, symbol, URL and candle-close timezone (prefer the verified LBank
pair; never substitute a different asset with the same ticker); range-low judgment, chart history
and prior pump response (PASS / REJECT / UNCERTAIN); `candle_state` PRE_MOVE / ALREADY_PUMPED /
UNCERTAIN; BTC/ETH `market_regime` FAVORABLE / UNFAVORABLE / UNCERTAIN; `final_decision` REVIEW /
NO_TRADE / PLAN_READY; rationale. PLAN_READY requires entry price and time, stop price (percent
derived), TP1–TP3 prices and allocations, the 7 × 24 h deadline from entry and notes; missing fields
keep the plan INCOMPLETE; stop < entry < TP1 < TP2 < TP3 (p.26–27). Reviews are append-only
revisions; a later scan never overwrites them (p.16, p.27). No sizing, order type, fee model or
automatic execution is specified, so none is invented (p.26).

## 8. Failure handling (p.12, p.18)

| Situation | Behaviour |
|---|---|
| Crawl batch missing / failed | Recorded as a gap; no old quote reused as current |
| Listing not fully read or ranks 1–1200 not contiguous | Batch `INCOMPLETE`; queue published only with an INCOMPLETE banner, Telegram withholds it |
| Missing rank / cap / date_added / tags / pair match | NEEDS_REVIEW or EXCLUDED with reason, never fabricated |
| Missing or invalid daily date | Only the windows containing it are N/A |
| Duplicated / out-of-order / revised daily rows | Normalized per UTC date; every revision kept |
| Invalid division inputs | N/A for that asset; the batch continues |
| No complete LBank list, or older than `LBANK_PAIRS_MAX_AGE_DAYS` (35) | LBank `UNKNOWN`, NEEDS_REVIEW, queue withheld until the list is refreshed; a failed refresh keeps the previous list until that age |
| Analysis fails | The previous valid export stays current and a failure banner is shown |

Run observability: batch id, fetched / eligible / review / excluded / N/A counts, crawl age, missing
fields, export path and checksum; warnings for incomplete universe, repeated missing daily data,
stale-snapshot spikes and empty venue mappings (p.18).

## 9. Explicit requirements vs implementation assumptions

Everything in sections 4–8 that cites a page is explicit. The following are implementation choices
where the PDF is silent or ambiguous; each is configurable or documented in code with its id.

| Id | Assumption | Why |
|---|---|---|
| A1 | The rules' "scan time" is the batch's crawl time (as-of); wall-clock processing time is stored separately | Replaying a batch must give the same outcome (p.16); in normal operation the scan runs minutes after the crawl |
| A2 | "N days ago" = T−N, where T is the as-of UTC date; window N = T−1…T−N | Matches p.19 D exactly |
| A3 | Quote age = crawl time − provider `lastUpdated`; observation > 5 min in the future → TIMESTAMP_UNVERIFIED | Existing validation convention for future timestamps |
| A4 | `pass_N` evaluated as `current_vmc ≥ 1.5 × mean_N` with exact decimals | Algebraically equal to `multiple_N ≥ 1.5` for `mean_N > 0`; one less rounding step |
| A5 | Stablecoin = CMC tag `stablecoin` or `*-stablecoin`; tokenized asset = CMC `tokenized-*` tags (stock, ETFs, commodities, gold, silver, treasury bonds/bills, real estate) | The PDF names the classes, not the tags (p.9) |
| A6 | Wrapped, bridged and staked representations, and heuristic-only matches (name, symbol, $1 peg, tracking BTC/ETH price) are `CLASS_AMBIGUOUS` → NEEDS_REVIEW until the override list decides | PDF excludes only stablecoins and tokenized assets; ambiguity must be reviewed, not guessed (p.9) |
| A7 | LBank pairs come from CMC's LBank exchange-markets data collected by the existing CMC website crawler; identity = CMC `baseCurrencyId`. *Superseded in part by D1:* human verification of every listed pair is now optional (`LBANK_REQUIRE_MANUAL_VERIFICATION`) | Only in-crawler source that maps LBank pairs to CMC ids (gap G6); it has no trading-status field (p.10) |
| A8 | A pair whose LBank base symbol differs from the asset's CMC symbol, or an LBank base symbol mapped to several CMC ids, is ambiguous → UNKNOWN + mapping task | "If an LBank base ticker is ambiguous, do not guess" (p.10) |
| A9 | A human `VERIFIED_TRADABLE` decision stays valid while the pair is in every later complete crawl; a disappearance voids it; a disappeared pair stays UNKNOWN until it returns or a reviewer marks it not tradable | "withhold … until reverified" (p.10) |
| A10 | Venue flags: `UPBIT_TOP_VENUE` (Upbit has the largest aggregated spot volume) and `SINGLE_VENUE` (one exchange); venue data older than 24 h or partial → `VENUE_DATA_PENDING`/`INCOMPLETE` | No numeric share cutoff exists (p.15) |
| A11 | Daily rows: each eligible-or-review candidate missing date T−1 gets one history request covering the last 35 completed days; bounded per run, budget-reserved, resumable; later revisions are captured on the next refresh | One request per asset regardless of range length; p.11 requires revision upserts |
| A12 | Batch INCOMPLETE when the listing was not fully read or any rank 1–1200 is missing or duplicated | Makes "incomplete rank pagination" testable (p.18) |
| A13 | Crawler expected interval = 60 min (hourly `PIPELINE_CRON`), so `max_quote_age` = 120 min | p.12 requires an explicit, documented interval |
| A14 | A stale or unverified quote leaves eligibility unchanged but makes every comparison N/A | p.13 specifies comparisons only |
| A15 | Diagnostics `vol_avg_N` use the same N dates and validity rules as `mean_N` | p.14 lists them without definitions |
| A16 | Queue status `PUBLISHED`, `WITHHELD_INCOMPLETE_BATCH`, `WITHHELD_LBANK_UNAVAILABLE` or `EMPTY` | p.18 "do not publish an apparently complete queue" |
| A17 | CSV: UTF-8 without BOM, RFC 4180, plain decimal strings (no exponent); XLSX numeric cells are IEEE doubles (display) while CSV keeps full precision | p.17 |
| A18 | Trade-plan allocations: each > 0, total ≤ 100 % (a total below 100 % is a warning); stop % = (entry − stop) / entry × 100 | Logical consistency only; no allocation rule is invented (p.26) |
| A19 | Reviewer = name entered with each review (single operator) | p.16 requires a reviewer field |
| A20 | Storage: scan rows excluded only by rank/cap are thinned to the first batch of each UTC day after `RETENTION_DETAIL_DAYS`; export files are kept `EXPORT_RETENTION_DAYS` (database keeps history) | ~8k assets per hourly batch; extends the operator's existing storage policy |

### Operator decisions (p.2 precedence #1: later direct user decisions)

| Id | Decision (D1, D2: 2026-11-05; D3: 2026-11-10) | Implementation |
|---|---|---|
| D1 | The LBank pair list comes from the **Markets section of CMC's LBank exchange page** (spot). A coin with an unambiguously mapped pair in that list counts as having a tradable LBank Spot pair; no separate human check per pair | `listingIsTradable` in `tier1/lbank.ts`; the pair's evidence says "listed in CMC's LBank Spot markets (list fetched …)". A reviewer's `NOT_TRADABLE` still wins; ambiguous tickers still need a mapping decision (p.10). `LBANK_REQUIRE_MANUAL_VERIFICATION=true` restores A7 |
| D2 | That list is crawled **once**, then again automatically after about **30 days**, or manually from the dashboard | `LBANK_PAIRS_REFRESH_DAYS=30` (reuse until this age), `LBANK_PAIRS_MAX_AGE_DAYS=35` (stale beyond: UNKNOWN, queue withheld), dashboard *Refresh LBank list now* / `npm run cli -- lbank:refresh` (fetch, then recompute and re-export the latest batch). Scans use the newest complete list (reference data, recorded per scan as `ScanRun.lbankCrawlId`) |

| D3 | Weighted Star Ranking Addendum v1.0 (10 Nov 2026): keep the star definition; rank the Review Queue by stars, then 60 / 25 / 15 weighted points, completeness, weighted strength, the 3-day multiple and CMC id | § 6a; `RANKING_RULESET_VERSION`, `RANKING`, `rankingScore`, `compareQueue` in `tier1/review-queue.ts`; ranking fields on `scan_result`, `scan_run` and forward-test events (migration M009) |

Consequences: a pair listed or delisted on LBank between refreshes is noticed only at the next
refresh (use the manual refresh when it matters); the crawler reads the same data as the page's
Markets table — verified 2026-11-05: the page reported 901 spot pairs and every row of its first
screen (pair and CMC coin id) was in the stored 901-pair list.

## 10. Conflicts with the previous implementation and resolution

| Id | Previous behaviour | Conflict | Resolution |
|---|---|---|---|
| C1 | Six-month VMC baseline, one-time 72 h hourly backfill, hourly coin-page job (`src/vmc`, earlier 03 Nov brief) | Explicitly excluded (p.2, p.6, p.12, p.14, p.22) | Removed; the daily-history route, parser and revision storage are reused for Tier 1 |
| C2 | Pump-chance screen with invented thresholds, automatic Buy/Watch/Avoid, agent buy/hold/sell stances, automatic paper positions | No automatic buy signals; presentation rules only; trade decisions are human (p.2, p.14, p.24–28); no manufactured thresholds (p.2) | Retired (features, surge screening, agents, paper trading, backtest) |
| C3 | Universe: cap ≥ $5M, 24h volume ≥ $250k, wrapped/bridged/staked excluded | Rank 101–1200, cap ≥ $15M; no dollar-volume gate; only stablecoins and tokenized assets excluded (p.2, p.3, p.9, p.14) | Replaced by the Tier 1 rules |
| C4 | Listing parser drops `cmcRank`, `dateAdded`, raw tags | Required inputs (p.8, p.9) | Targeted crawler fix (data defect, p.2) |
| C5 | 7-day chart backfill of 72 hourly samples | 72-hour backfill excluded (p.2, p.6, p.12) | Removed |
| C6 | Telegram pump watchlist, `/vmc` six-month baseline | Superseded output | Telegram reports the Tier 1 queue; `/vmc <id>` shows the Tier 1 trace |
| C7 | MCP signal/recommendation tools and `publish_signal_report` | Superseded output; no automatic signals | Tier 1 read tools; write tool removed |
| C8 | PDF "Keep collected data" (p.22) vs the operator's instruction to clear coin-related data | Direct conflict | Later direct user decision wins (p.2 #1): a verified backup keeps all previously collected data; the clear is scoped and documented in the implementation plan |
| C9 | Review Queue sorted by `pass_3d`, then `pass_7d`, then `pass_30d` across all star groups (p.14; acceptance case F, p.19) | The addendum ranks by stars first, then weighted points | Later direct decision wins (p.2 #1): the weighted star ranking (D3, § 6a) replaces only that sort rule; queue membership is unchanged |

## 11. Remaining limits

- CMC website routes are unofficial and may change; the collector is an explicit operator choice.
- CMC's LBank markets data carries no trading status. By operator decision D1 a listed pair
  counts as tradable, so a pair that is listed but suspended on LBank can reach the Review Queue;
  the Tier 2 reviewer confirms the pair on LBank before any plan (G6). The list is refreshed every
  30 days or on demand (D2), so listing changes in between are not seen.
- Venue rows cover the top 100 spot pairs per asset; coverage is reported, not assumed complete.
- Daily history costs one request per candidate per UTC day; the request-budget reserve can leave
  windows N/A until the next run (visible, never filled).
- VMC outcomes are descriptive screening results with no validated predictive value.
