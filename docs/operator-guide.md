# Operator guide — Two-Tier VMC

How to run the system, read its output, and record reviews. The rules themselves are in
[strategy-two-tier-vmc.md](strategy-two-tier-vmc.md); this page is about operating them.

> The Review Queue is a list of coins for human chart review. It is not a buy list, not a
> prediction, and nothing here places orders.

## 1. Run it

```bash
docker compose up -d postgres && npm run db:migrate   # builds, then applies committed migrations
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

| Section (left rail) | Shows                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview            | Run ring (progress while a run is going, otherwise a countdown to the next run) with the stage list; a funnel from every listed coin to evaluated, eligible and the review queue; review-queue cards; window results (YES / NO / N/A per window), eligibility donut, stars, exclusion reasons, data quality (quote and LBank status, LBank list age, warnings) and the rule list |
| Review queue        | ELIGIBLE coins with at least one YES among 3d / 7d / 30d, in the PDF's order (3d, then 7d, then 30d result; then the 3-day multiple)                                                                                                                                                                                                                                             |
| Eligible            | Every coin passing all hard filters, including 0-star rows                                                                                                                                                                                                                                                                                                                       |
| Needs review        | Coins with missing or ambiguous inputs (no rank / cap / listing date, ambiguous class, unverified or ambiguous LBank pair, LBank feed down). Windows are still computed                                                                                                                                                                                                          |
| Excluded            | Coins with a known failed filter, with every reason                                                                                                                                                                                                                                                                                                                              |
| Runs & health       | Source, circuit and request budget; the latest run's stages on a timeline; hourly crawl batches (missing / duplicate ranks); runs; open LBank mapping tasks                                                                                                                                                                                                                      |
| Exports             | Per-batch CSV / XLSX files with checksums                                                                                                                                                                                                                                                                                                                                        |
| Telegram            | Missed reports, pending requests, members                                                                                                                                                                                                                                                                                                                                        |

The queue, eligible and needs-review lists switch between **Table** and **Scatter** (current VMC
against the coin's own 30-day mean on log scales, with the 1.5× line; click a dot to open the
coin). **Find a coin** (⌘K / Ctrl K, or `/`) searches every known coin by symbol, name or CMC id.
The theme button at the bottom of the rail cycles auto / light / dark.

Window cells show the multiple and a bar against the 1.5× tick (YES in amber), or `N/A`. Hover an N/A for its reason:
`DAILY_ROW_MISSING` / `DAILY_ROW_INVALID` (a day in that window is missing or invalid — other
windows still count), `ZERO_BASELINE`, `CURRENT_STALE` (provider update older than
`MAX_QUOTE_AGE_MINUTES`, default 120), `TIMESTAMP_UNVERIFIED`, `MISMATCHED_OBSERVATION`,
`NOT_EVALUATED_EXCLUDED`. Stars count YES results among 3d / 7d / 30d; they are not a
probability or confidence. The 14-day mean is context only.

Click any row (or a queue card) for the **coin detail**. Its address gains `?coin=<CMC id>`, so
the view can be reloaded or bookmarked. Under the price and status chips it has three tabs (the
last one used stays selected):

- **Review**: the evidence and your review form.
  - _Volume ÷ market cap_: the 30 completed daily VMC bars and today's rolling-24h value. Pick a
    window (3 / 7 / 14 / 30 days) to highlight its days and draw its mean and the 1.5× line.
  - _Price and volume_: daily closes with daily volume, or the hourly snapshots (72 h, 7 days,
    30 days). Hourly history builds up one point per run.
  - _Where it trades_ (CMC venue shares), the LBank pairs with their decision buttons, and the
    review form.
- **History**: review revisions, LBank decisions and CMC metadata changes (name, symbol, tags).
- **Calculation details**: the current-VMC formula and timestamps, the window table with every
  formula, and every daily row used, with revision numbers.

The same trace is available as
`npm run cli -- tier1:trace --id <cmcId>`, and in Telegram as `/coin <CMC id or symbol>` (windows
with bars, VMC and price sparklines, LBank, venues, review; the daily rows sit in a collapsed
quote) or `/vmc <CMC id or symbol>` (windows only). Tap a coin name in the hourly report and the
bot answers with its details in the next message; a symbol shared by several coins gets a list
of tappable choices.

### When the queue is withheld

| Banner / status                  | Meaning                                                                                                   | What to do                                                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Withheld: incomplete batch       | Ranks 1–1200 had a gap or duplicate, or not every listed coin was stored                                  | Check _Runs & health_; the next hourly batch usually recovers. Rows remain inspectable but are not a complete queue                                              |
| Withheld: LBank feed unavailable | No complete LBank Spot markets list yet, or the stored list is older than `LBANK_PAIRS_MAX_AGE_DAYS` (35) | Press _Refresh LBank list now_ on the Overview (or `lbank:refresh`); check source health if it fails. Every LBank status is UNKNOWN until a complete list exists |
| Empty                            | No eligible coin met any window                                                                           | Nothing to review this hour; no rule is relaxed to fill it                                                                                                       |

## 3. Review workflow

1. **LBank pair** (drawer → _LBank Spot pairs_). A pair in the LBank Spot markets list counts as
   tradable (operator decision D1), so most coins need nothing here. Two cases do:
   - **Ambiguous ticker** (LBank symbol differs from CMC, e.g. `DUSK1`, or one ticker on several
     CMC ids, e.g. `MARS/USDC`): press **Mapping correct** or **Wrong asset**. Open tasks are
     listed under _Runs & health_.
   - **Listed but not tradable** on LBank (suspended, delisted): press **Not tradable**.
     Decisions are stored with your name and apply from the next scan; press _Reprocess latest
     batch_ on the Overview to apply them now. (With `LBANK_REQUIRE_MANUAL_VERIFICATION=true` every
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
against; _Export_ on a revision returns it as JSON. Reviews and LBank decisions need the Owner or
Reviewer role, and the signed-in username is recorded as the reviewer.

## 3a. Users and sign-in

Every page and API call needs a signed-in user. There are three roles:

| Role     | Can see                                                   | Can do                                             |
| -------- | --------------------------------------------------------- | -------------------------------------------------- |
| Owner    | Everything                                                | Everything, including _Users_ and _Telegram_       |
| Analyzer | Overview, lists, coin details, _Runs & health_, _Exports_ | Reprocess the latest batch, refresh the LBank list |
| Reviewer | Overview, lists, coin details                             | Save reviews and LBank decisions                   |

Everyone can change their own username and password under _My account_ (the current password is
always required). Owners manage people under _Users_: add someone with a temporary password, change
a role, disable or delete an account, or reset a password. A temporary password must be replaced at
the next sign-in, and a reset, a role change or disabling ends that person's sessions. The last
active owner can't be demoted, disabled or deleted, and an owner can't do any of that to themselves
from the dashboard. Five wrong passwords in a row lock an account for 15 minutes; an owner's
password reset unlocks it.

**First start, and an empty database.** When the web server starts and finds no active owner, it
creates `owner` with the password `owner` and logs a warning. The first sign-in shows only a form to
choose your own username and password; nothing else opens until you do. To start with a different
password, set `INITIAL_OWNER_PASSWORD` (at least 8 characters) before the first start. This also
happens after you clear the database, so the owner is never locked out.

**Recovery from the server's shell** (passwords are asked at a hidden prompt, or piped on stdin;
never put them on the command line):

```bash
npm run cli -- users:list                          # who exists, roles, locked or not
npm run cli -- users:reset-owner                   # "owner" / "owner" again: active, unlocked, must change
npm run cli -- users:password --username ana       # new temporary password, unlocks the account
npm run cli -- users:add --username ana --role reviewer
docker compose exec app node dist/cli.js users:reset-owner   # the same inside the Docker app
```

**On a server.** Put the dashboard behind HTTPS (nginx or Caddy) and set `TRUST_PROXY=loopback` (or
the proxy's hop count) so the app sees real client addresses and marks the session cookie
`Secure` (`COOKIE_SECURE=auto`; `true` forces it). Sessions last `SESSION_TTL_HOURS` (default 12)
after their last use. MCP keeps its own bearer tokens, and `/healthz` stays open for health checks.

## 4. LBank Spot markets list

The list of LBank Spot pairs comes from the **Markets section of CMC's LBank exchange page**
(`coinmarketcap.com/exchanges/lbank/?type=spot`, all pages, ~900 pairs, 2 requests). It is
fetched once and reused; the hourly run fetches it again only when it is
`LBANK_PAIRS_REFRESH_DAYS` (30) old. The Overview's _LBank Spot list_ row shows when it was
fetched and when it refreshes next.

- **Refresh now:** _Refresh LBank list now_ on the Overview, or `npm run cli -- lbank:refresh`.
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

| Command                                         | Purpose                                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `run-once`                                      | Run the current hour now                                                           |
| `tier1:scan [--batch ID] [--no-export]`         | Recompute a stored batch from saved data (no crawling)                             |
| `tier1:export [--batch ID]`                     | Re-export a scanned batch                                                          |
| `tier1:trace --id CMC_ID [--batch ID] [--json]` | Calculation trace for one coin                                                     |
| `tier1:batches`                                 | Recent crawl batches and scans                                                     |
| `lbank:status`                                  | Stored LBank Spot markets list: fetched when, next automatic refresh, last attempt |
| `lbank:refresh`                                 | Fetch the LBank list now, then recompute and re-export the latest batch            |
| `daily:import-csv --id CMC_ID --file F`         | Import a CMC "Download CSV" history file as completed daily rows                   |
| `telegram:preview [--batch ID] [--fake]`        | Print the Telegram summary without sending                                         |
| `source:reset --provider coinmarketcap_web`     | Clear a suspended source after fixing the cause                                    |

## 7. Troubleshooting

| Symptom                                  | Likely cause                                                                                            | Action                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Many `DAILY_ROW_MISSING`                 | Cold start, the daily stage hit its time / asset / budget bound, or CMC has not published yesterday yet | Wait for the next runs (retries after `TIER1_DAILY_RETRY_HOURS`); check `metrics.daily` on the run and the budget on _Runs & health_                                                                                                                                                                                                                 |
| Many `CURRENT_STALE`                     | The listing returned old provider timestamps                                                            | Compare provider update time and crawl time in the trace; persistent staleness means a source problem                                                                                                                                                                                                                                                |
| Source circuit `open` / `suspended`      | Repeated errors or 401/403 denials                                                                      | Stop and investigate (network, blocking, route change) before `source:reset`                                                                                                                                                                                                                                                                         |
| "The latest crawl batch … failed" banner | Network loss (e.g. the host slept), timeouts or server errors opened the circuit (15-minute cooldown)   | Once the cause is gone, press _Retry crawl now_ in the banner (needs `scan:operate`): it closes an `open` circuit, skipping the cooldown, and crawls the current hour again. It refuses while a run holds the lease, when this hour already completed, when the source is `suspended` (use `source:reset`) or while a provider Retry-After is active |
| Budget nearly used                       | Daily refresh volume above the monthly budget                                                           | Raise `CMC_WEB_MONTHLY_REQUEST_BUDGET` deliberately or reduce `TIER1_DAILY_MAX_ASSETS_PER_RUN`; the hourly listing keeps a reserve                                                                                                                                                                                                                   |
| Export failed banner                     | Disk or permission problem in `TIER1_EXPORT_DIR`                                                        | Fix and run `tier1:export`; the previous export is still valid                                                                                                                                                                                                                                                                                       |
| Missed Telegram reports                  | Recipient blocked the bot or Telegram errors                                                            | _Telegram access_ → Retry                                                                                                                                                                                                                                                                                                                            |

## 8. Overrides

`config/tier1-overrides.json` holds reviewed exceptions: `classOverrides` (`eligible`,
`stablecoin`, `tokenized` for a CMC id) and `lbankMappingOverrides` (`MAPPING_CONFIRMED` /
`MAPPING_REJECTED` for a CMC id + LBank pair). Each entry needs a reason, `addedBy` and
`addedAt`; bump `version` and `updatedAt` on every change. The file's hash is part of each
scan's configuration version, so a change is visible in every result it affects.

## 9. Backup, restore and migrations

```bash
docker compose exec -T postgres pg_dump -U coins -Fc coins > backups/coins-$(date +%F).dump
docker compose exec -T postgres pg_restore -U coins -d coins --clean --if-exists < backups/coins-YYYY-MM-DD.dump
npm run db:status     # applied and pending migrations; exits 1 while any is pending
npm run db:migrate    # applies pending migrations (Docker: RUN_MIGRATIONS=true at container start)
```

The schema changes only through new files in `src/database/migrations/`
([ADR-0001](adr/0001-typeorm-modular-layout.md)); an applied migration is never edited.
`npm run db:revert` undoes the last migration _and drops what it created_: development databases
only. Never run `docker compose down -v`, `db:revert`, or TypeORM `schema:drop` / `schema:sync`
against real history.

### One-time cut-over from the Prisma schema (2026-11-06)

A database created before 2026-11-06 still holds the Prisma tables (quoted CamelCase names such
as `"MarketSnapshot"`). Their market data is not migrated (the pipeline refills it), but the source
registry, the monthly request budget, the approved Telegram members and the bot's update offset
are carried over, so members keep their reports and the bot does not re-run old commands:

1. Stop the app (`npm start`, or `docker compose --profile app stop app`). With the Docker app
   profile, finish these steps before starting the new image: its entrypoint migrates and starts
   the bot straight away.
2. Back up (above).
3. `npm run db:migrate` — creates the snake_case tables next to the old ones (no name clashes).
4. `docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < scripts/db/2026-11-06-carry-over-prisma-state.sql`
   — prints the copied row counts and keys, never values.
5. The same command with `scripts/db/2026-11-06-drop-prisma-schema.sql`. It refuses to run
   while step 3 or 4 is missing.
6. Start the app or `npm run cli -- run-once`. The first run rebuilds identities, snapshots and
   the batch; on the live source, daily rows refill over the first runs (§ 1), so windows are N/A
   until their days arrive.

The earlier backup of 2026-11-05 (before the Two-Tier VMC migration) is described in
[implementation-plan.md § 7](implementation-plan.md#7-database-preparation-before-the-schema-migration).
