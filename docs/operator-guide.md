# Operator guide — Two-Tier VMC

How to run the system, read its output, and record reviews. The rules themselves are in
[strategy-two-tier-vmc.md](strategy-two-tier-vmc.md); this page is about operating them.

> The Review Queue is a list of coins for human chart review. It is not a buy list, not a
> prediction, and nothing here places orders.

## 1. Run it
```bash
docker compose up -d postgres && npm run db:migrate && npm run build
npm run cli -- config:check            # secrets shown only as <set>/<not set>
npm run cli -- run-once                # one hourly batch now
npm start                              # dashboard http://127.0.0.1:3000 + hourly scheduler
```
- **Synthetic** (`DATA_SOURCE=fixture`, default): a made-up market of 1,301 coins (CMC-shaped ids
  ≥ 990001) with 29 named edge cases. Every screen says SYNTHETIC / TEST DATA. Use it to learn
  the screens; it says nothing about real markets.
- **Live** (`DATA_SOURCE=coinmarketcap_web`): the CMC website collector, no key. The first live
  run fetches 35 days of daily rows for each screen candidate; at 30 requests/minute that is
  spread over the first two or three runs, and windows stay N/A until their days arrive.
- Keep `TELEGRAM_MODE=dry_run` until the output looks right; `live` sends to every approved member.

Each run takes one crawl batch per UTC hour (minute 7 by default) and writes the scan, the
exports and the Telegram summary. Missed hours are recorded, never invented.

## 2. Read the dashboard
| Tab | Shows |
|---|---|
| Overview | Run progress (whole-run bar plus a per-coin bar with time left for the daily-rows and venues stages), next scheduled update with a countdown, batch status, counts, warnings, the rule list, and why coins are not eligible |
| Review Queue | ELIGIBLE coins with at least one YES among 3d / 7d / 30d, in the PDF's order (3d, then 7d, then 30d result; then the 3-day multiple) |
| All Eligible | Every coin passing all hard filters, including 0-star rows |
| Needs Review | Coins with missing or ambiguous inputs (no rank / cap / listing date, ambiguous class, unverified or ambiguous LBank pair, LBank feed down). Windows are still computed |
| Excluded | Coins with a known failed filter, with every reason |
| Batches & health | Crawl batches (missing / duplicate ranks), source health and request budget, open LBank mapping tasks, runs |
| Exports | Per-batch CSV / XLSX files with checksums |
| Telegram access | Missed reports, pending requests, members |

Window cells read `YES 2.00×`, `NO 1.33×` or `N/A`. Hover an N/A for its reason:
`DAILY_ROW_MISSING` / `DAILY_ROW_INVALID` (a day in that window is missing or invalid — other
windows still count), `ZERO_BASELINE`, `CURRENT_STALE` (provider update older than
`MAX_QUOTE_AGE_MINUTES`, default 120), `TIMESTAMP_UNVERIFIED`, `MISMATCHED_OBSERVATION`,
`NOT_EVALUATED_EXCLUDED`. Stars count YES results among 3d / 7d / 30d; they are not a
probability or confidence. The 14-day mean is context only.

Click any row for the **calculation trace**: the current observation with its formula, each
window's dates and mean, the 30 completed daily rows used (with revision numbers), the LBank
pairs, venue rows, and the review history. The same trace is available as
`npm run cli -- tier1:trace --id <cmcId>`, and in Telegram as `/coin <CMC id or symbol>` (the
whole drawer, a few messages) or `/vmc <CMC id or symbol>` (windows only). A symbol shared by
several coins gets a list of `/coin <id>` choices.

### When the queue is withheld
| Banner / status | Meaning | What to do |
|---|---|---|
| Withheld: incomplete batch | Ranks 1–1200 had a gap or duplicate, or not every listed coin was stored | Check *Batches & health*; the next hourly batch usually recovers. Rows remain inspectable but are not a complete queue |
| Withheld: LBank feed unavailable | No complete LBank Spot markets list yet, or the stored list is older than `LBANK_PAIRS_MAX_AGE_DAYS` (35) | Press *Refresh LBank list now* on the Overview (or `lbank:refresh`); check source health if it fails. Every LBank status is UNKNOWN until a complete list exists |
| Empty | No eligible coin met any window | Nothing to review this hour; no rule is relaxed to fill it |

## 3. Review workflow
1. **LBank pair** (drawer → *LBank Spot pairs*). A pair in the LBank Spot markets list counts as
   tradable (operator decision D1), so most coins need nothing here. Two cases do:
   - **Ambiguous ticker** (LBank symbol differs from CMC, e.g. `DUSK1`, or one ticker on several
     CMC ids, e.g. `MARS/USDC`): press **Mapping correct** or **Wrong asset**. Open tasks are
     listed under *Batches & health*.
   - **Listed but not tradable** on LBank (suspended, delisted): press **Not tradable**.
   Decisions are stored with your name and apply from the next scan; press *Reprocess latest
   batch* on the Overview to apply them now. (With `LBANK_REQUIRE_MANUAL_VERIFICATION=true` every
   listed pair waits for your **Verified tradable**; a verification is voided if the pair later
   disappears from LBank's list.)
2. **Tier 1 decisions** (review form): venue decision `ACCEPT` / `REJECT` / `PENDING` after
   looking at the venue rows (Upbit-dominant and single-venue activity are flagged, never
   auto-rejected), and the event day `FIRST` / `SECOND` / `LATER` / `UNKNOWN` from the daily rows.
3. **Tier 2 chart review** on TradingView's 1D chart: exchange, symbol, quote, chart URL and its
   candle-close timezone (CMC days close at 00:00 UTC), proxy reason if the chart is not LBank,
   then the judgments (range low, chart history, prior pump response, candle state, BTC/ETH
   regime) and a final decision `REVIEW` / `NO_TRADE` / `PLAN_READY`.
4. **Manual trade plan** (only for `PLAN_READY`): you choose entry, entry time (UTC), stop and
   three targets with allocations, plus notes. Validation checks completeness and
   stop < entry < TP1 < TP2 < TP3, allocations ≤ 100 %, a verified LBank pair, and a rationale
   when the event is later / unknown or the candle already pumped. The stop % and the 7 × 24 h
   time exit are derived; an incomplete plan is saved as `INCOMPLETE`, never as ready.

Every save is a new revision (append-only), tied to the batch and the Tier 1 values it was made
against; *Export* on a revision returns it as JSON. Reviews can be saved only when the dashboard
is bound to 127.0.0.1 or protected with `DASHBOARD_BASIC_AUTH`.

## 4. LBank Spot markets list
The list of LBank Spot pairs comes from the **Markets section of CMC's LBank exchange page**
(`coinmarketcap.com/exchanges/lbank/?type=spot`, all pages, ~900 pairs, 2 requests). It is
fetched once and reused; the hourly run fetches it again only when it is
`LBANK_PAIRS_REFRESH_DAYS` (30) old. The Overview's *LBank Spot list* row shows when it was
fetched and when it refreshes next.
- **Refresh now:** *Refresh LBank list now* on the Overview, or `npm run cli -- lbank:refresh`.
  It fetches the list, then recomputes and re-exports the latest batch, so the result is visible
  at once. Use it when you know LBank listed or delisted something.
- **If a refresh fails**, the previous complete list stays in use until it is
  `LBANK_PAIRS_MAX_AGE_DAYS` (35) old; after that every LBank status is UNKNOWN and the queue is
  withheld until a refresh succeeds.
- `npm run cli -- lbank:status` prints the stored list's age, next refresh and last attempt.

## 5. Exports
Each scanned batch is written to `var/exports/<provider>/<slot>Z_<batch>[_SYNTHETIC]/`:
`all_eligible.csv`, `review_queue.csv`, `needs_review.csv`, `excluded.csv`, `run_metadata.csv`,
`workbook.xlsx` with the same five sheets, and `manifest.json` (SHA-256 per file). Values are full
precision; an N/A value is blank with its reason code; `data_label` says LIVE or SYNTHETIC.
The workbook is also sent to Telegram after each summary (renamed `coins-tier1_<slot>Z.xlsx`),
except when the queue is withheld; set `TELEGRAM_ATTACH_EXPORT=none` for text only.
A failed export never replaces the previous one. Files are pruned after
`EXPORT_RETENTION_DAYS`; the database keeps every result, so `npm run cli -- tier1:export
--batch <id>` regenerates them.

## 6. Command reference
| Command | Purpose |
|---|---|
| `run-once` | Run the current hour now |
| `tier1:scan [--batch ID] [--no-export]` | Recompute a stored batch from saved data (no crawling) |
| `tier1:export [--batch ID]` | Re-export a scanned batch |
| `tier1:trace --id CMC_ID [--batch ID] [--json]` | Calculation trace for one coin |
| `tier1:batches` | Recent crawl batches and scans |
| `lbank:status` | Stored LBank Spot markets list: fetched when, next automatic refresh, last attempt |
| `lbank:refresh` | Fetch the LBank list now, then recompute and re-export the latest batch |
| `daily:import-csv --id CMC_ID --file F` | Import a CMC "Download CSV" history file as completed daily rows |
| `telegram:preview [--batch ID] [--fake]` | Print the Telegram summary without sending |
| `source:reset --provider coinmarketcap_web` | Clear a suspended source after fixing the cause |

## 7. Troubleshooting
| Symptom | Likely cause | Action |
|---|---|---|
| Many `DAILY_ROW_MISSING` | Cold start, the daily stage hit its time / asset / budget bound, or CMC has not published yesterday yet | Wait for the next runs (retries after `TIER1_DAILY_RETRY_HOURS`); check `metrics.daily` on the run and the budget on *Batches & health* |
| Many `CURRENT_STALE` | The listing returned old provider timestamps | Compare provider update time and crawl time in the trace; persistent staleness means a source problem |
| Source circuit `open` / `suspended` | Repeated errors or 401/403 denials | Stop and investigate (network, blocking, route change) before `source:reset` |
| Budget nearly used | Daily refresh volume above the monthly budget | Raise `CMC_WEB_MONTHLY_REQUEST_BUDGET` deliberately or reduce `TIER1_DAILY_MAX_ASSETS_PER_RUN`; the hourly listing keeps a reserve |
| Export failed banner | Disk or permission problem in `TIER1_EXPORT_DIR` | Fix and run `tier1:export`; the previous export is still valid |
| Missed Telegram reports | Recipient blocked the bot or Telegram errors | *Telegram access* → Retry |

## 8. Overrides
`config/tier1-overrides.json` holds reviewed exceptions: `classOverrides` (`eligible`,
`stablecoin`, `tokenized` for a CMC id) and `lbankMappingOverrides` (`MAPPING_CONFIRMED` /
`MAPPING_REJECTED` for a CMC id + LBank pair). Each entry needs a reason, `addedBy` and
`addedAt`; bump `version` and `updatedAt` on every change. The file's hash is part of each
scan's configuration version, so a change is visible in every result it affects.

## 9. Backup and restore
```bash
docker compose exec -T postgres pg_dump -U coins -Fc coins > backups/coins-$(date +%F).dump
docker compose exec -T postgres pg_restore -U coins -d coins --clean --if-exists < backups/coins-YYYY-MM-DD.dump
```
The pre-migration backup of 2026-11-05 and its verification are described in
[implementation-plan.md § 7](implementation-plan.md#7-database-preparation-before-the-schema-migration).
Never run `docker compose down -v`, `prisma migrate reset` or `db push` against real history.
