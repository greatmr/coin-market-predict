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
npm start                              # API http://127.0.0.1:3000 + hourly scheduler
npm run front:install && npm run front:dev     # dashboard http://127.0.0.1:5173 (talks to the API on :3000)
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
| Overview            | Run ring (progress while a run is going, otherwise a countdown to the next run) with the stage list; a funnel from every listed coin to evaluated, eligible and the review queue; review-queue cards; the forward test at a glance (results by stars, the last High check, a link to the full table); window results (YES / NO / N/A per window), eligibility donut, stars and the rule list |
| Review queue        | ELIGIBLE coins with at least one YES among 3d / 7d / 30d, ranked by stars, then weighted points (3d 60 · 7d 25 · 30d 15 per YES; `≥ n` = lower bound because a window is N/A), complete scores first, weighted strength, the 3-day multiple and CMC id ([strategy § 6a](strategy-two-tier-vmc.md#6a-weighted-star-ranking-weighted_star_v1-operator-decision-d3)). A 2-star row always precedes a 1-star row |
| Eligible            | Every coin passing all hard filters, including 0-star rows                                                                                                                                                                                                                                                                                                                       |
| Needs review        | Coins with missing or ambiguous inputs (no rank / cap / listing date, ambiguous class, unverified or ambiguous LBank pair, LBank feed down). Windows are still computed                                                                                                                                                                                                          |
| Excluded            | Coins with a known failed filter, with every reason                                                                                                                                                                                                                                                                                                                              |
| Forward test        | Star Event Forward Test: results by stars, every event with its High-check status, window progress and notes ([§ 5a](#5a-star-event-forward-test))                                                                                                                                                                                                                               |
| Data                | Data quality of the latest batch (quote and LBank status, LBank list age and _Refresh LBank list now_, scan warnings, last export) and why coins are left out (exclusion reasons)                                                                                                                                                                                                |
| Runs & health       | Source, circuit and request budget; the latest run's stages on a timeline; hourly crawl batches (missing / duplicate ranks); runs; open LBank mapping tasks                                                                                                                                                                                                                      |
| Exports             | Per-batch CSV / XLSX files with checksums                                                                                                                                                                                                                                                                                                                                        |
| Telegram            | Missed reports, pending requests, members                                                                                                                                                                                                                                                                                                                                        |

The queue, eligible and needs-review lists switch between **Table** and **Scatter** (current VMC
against the coin's own 30-day mean on log scales, with the 1.5× line; click a dot to open the
coin). **Find a coin** — the search at the top centre of every page (⌘K / Ctrl K, or `/`) —
searches every known coin by symbol, name or CMC id.

The sidebar groups the sections into *Screen*, *Data & operations* and *Settings* (Telegram,
users, and *Preferences*, which shows your avatar with an online / offline dot); *Sign out* is at
its foot. The round button on the sidebar's edge collapses it to icons on desktop (remembered) and
opens it over the page on tablet; collapsed items show their name on hover or touch.
**Preferences** holds your sign-in details, what your role allows, the colour theme (auto / light /
dark) and whether the desktop sidebar starts collapsed. On phones the bottom bar keeps Overview,
Review queue, Forward test and Data; **More** opens the other sections (Preferences included) and
*Sign out*. A *Back to top* button appears on every device once a page is scrolled down.

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
| Withheld: incomplete batch       | Ranks 1–1200 had a gap or duplicate, or not every listed coin was stored                                  | Check _Runs & health_ (the batch notes list every listing read). A website listing in which CMC gives one rank to two coins (its rank cache caught mid-refresh) is read again automatically, up to 3 times 60 s apart, so this remains only when every read was inconsistent. A stored hour cannot be crawled again (first write wins); the next hourly batch usually recovers. Rows remain inspectable but are not a complete queue, and no forward-test events open from it |
| Withheld: LBank feed unavailable | No complete LBank Spot markets list yet, or the stored list is older than `LBANK_PAIRS_MAX_AGE_DAYS` (35) | Press _Refresh LBank list now_ on _Data_ (or `lbank:refresh`); check source health if it fails. Every LBank status is UNKNOWN until a complete list exists |
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
   regime) and a final decision `REVIEW` / `NO_TRADE` / `PLAN_READY`. The live chart at the top
   of the Review tab ([§ 3b](#3b-live-chart-and-the-claude-agent)) fills the chart fields with
   _Use in review form_.
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
| Owner    | Everything, including the coin's _Agent_ tab               | Everything, including _Users_, _Telegram_ and the Claude agent |
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
docker compose exec api node dist/cli.js users:reset-owner   # the same inside the Docker api
```

**On a server.** Put the dashboard behind HTTPS (nginx or Caddy) and set `TRUST_PROXY=loopback` (or
the proxy's hop count) so the app sees real client addresses and marks the session cookie
`Secure` (`COOKIE_SECURE=auto`; `true` forces it). Sessions last `SESSION_TTL_HOURS` (default 12)
after their last use. MCP keeps its own bearer tokens, and `/healthz` stays open for health checks.

## 3b. Live chart and the Claude agent

**Live chart** (everyone, Review tab of a coin). It loads as soon as the coin opens: TradingView's
daily chart (candles close at 00:00 UTC, like CMC's days) with a live price strip. TradingView
has no LBank Spot data, so the chart is always a proxy. The buttons above it list the symbols in
order:

1. spot markets that CMC lists for this coin id on exchanges TradingView carries (shown for coins
   with venue rows, i.e. review candidates), USD quotes and higher volume first;
2. the LBank perpetual (`LBANK:<BASE>USDT.P`), which exists only if LBank lists one;
3. TradingView's index (`CRYPTO:<SYMBOL>USD`), which matches by ticker only, so check that it is
   this coin.

If a symbol shows no data, pick another or use the chart's own symbol search. _Use in review
form_ copies the exchange, symbol, quote, chart URL, `UTC` and a proxy reason into the Tier 2
fields; check them before saving. The chart is a sandboxed TradingView frame: it cannot read the
dashboard, and nothing from it is stored.

**Claude agent** (owners only, the coin's _Agent_ tab). _Ask Claude_ → _Run analysis_ starts one
run. Claude reads the coin's stored data through four read-only tools (the Tier 1 trace, hourly
prices, BTC/ETH, the forward test) and answers within a few minutes with:

- its outlook for the next 7 days (_pump likely_, _possible_, _unlikely_ or _not enough data_) and
  a confidence (not a probability);
- its reasoning, the points for and against with the values they rest on, risks, data gaps and
  what to watch;
- its read of the Tier 2 candle state and BTC/ETH regime.

Confidence is capped by code on synthetic data, a stale or missing current observation, or an
incomplete batch; each adjustment is shown. The view is an AI opinion for your own review, not a
signal.

- **Limit:** 5 runs in any rolling 12 hours, shared by all owners (`AGENT_MAX_RUNS`,
  `AGENT_WINDOW_HOURS`), one at a time. The tab shows the runs left and when the next one frees
  up. A run that fails before Claude answers (credentials, outage) does not count.
- **History:** every run is stored (`agent_analysis`) with who asked, the batch it read, the model,
  every tool call and its output, and the answer or the failure. Finished runs never change; pick
  one under _All analyses of this coin_ to see it again.
- **Setup:** on a machine signed in to your Claude subscription, run `claude setup-token` and put the
  token in the server's configuration as `CLAUDE_CODE_OAUTH_TOKEN` (`.env`, or `.env.prod` on
  the server), then restart. It is the only credential the agent uses; an API key is refused.
  Check it by name only: `npm run cli -- config:check` shows `<set>` or `<not set>`. Model, effort,
  fallback and per-run limits are the `AGENT_*` settings in `.env.example`. Tokens last about a
  year; when Claude rejects one, the run fails with a message saying so.

## 4. LBank Spot markets list

The list of LBank Spot pairs comes from the **Markets section of CMC's LBank exchange page**
(`coinmarketcap.com/exchanges/lbank/?type=spot`, all pages, ~900 pairs, 2 requests). It is
fetched once and reused; the hourly run fetches it again only when it is
`LBANK_PAIRS_REFRESH_DAYS` (30) old. The _LBank Spot list_ row on _Data_ shows when it was
fetched and when it refreshes next.

- **Refresh now:** _Refresh LBank list now_ on _Data_, or `npm run cli -- lbank:refresh`.
  It fetches the list, then recomputes and re-exports the latest batch, so the result is visible
  at once. Use it when you know LBank listed or delisted something.
- **If a refresh fails**, the previous complete list stays in use until it is
  `LBANK_PAIRS_MAX_AGE_DAYS` (35) old; after that every LBank status is UNKNOWN and the queue is
  withheld until a refresh succeeds.
- `npm run cli -- lbank:status` prints the stored list's age, next refresh and last attempt.

**LBank Futures and Bithumb lists** ([ADR-0007](adr/0007-exchange-listings.md)). For the
forward-test tab's *LBank Futures* and *Bithumb* listings, the hourly run also reads LBank's Futures
markets (`?type=perpetual`, ~740 pairs) and Bithumb's Spot markets (~500 KRW / BTC pairs) from the
same CMC exchange pages when the stored list is `EXCHANGE_LISTS_REFRESH_HOURS` (24) old, about 4
requests. A failed fetch is retried after at most 6 hours; a list older than
`EXCHANGE_LISTS_MAX_AGE_HOURS` (72) no longer counts, and its listings show *Unknown*. They are not
Tier 1 inputs: refreshing them never rescans and never changes eligibility, stars, points or the
queue. `npm run cli -- exchange-lists:status` shows all three lists; `exchange-lists:refresh` fetches
the two new ones now.

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

## 5a. Star Event Forward Test

Every hourly run whose Review Queue is published records each eligible 1/2/3-star coin as an
event at the scan's CMC price — the first one per coin, UTC day and star count — and adds the coin
to the automatic forward-test watchlist. No approval step exists. Once per closed UTC day the run
stores each event's daily Highs and recomputes the highest High after detection, until the end of
the UTC day containing detection + 168 h. Rules, statuses, fields and gaps:
[forward-test.md](forward-test.md).

- **Forward test** tab: results by stars (events, confirmed Highs, events awaiting a check, active
  returns so far apart from FINAL statistics), pass-pattern and points tables, the final-return
  distribution, identification hours, the event list (filters by status, result, LBank market,
  Bithumb and stars; sort by Return, stars, points, identification time or a 3d / 7d / 30d ratio),
  rejected triggers, downloads
  (needs `exports:read`) and *Update Highs now* (needs `scan:operate`). *How to read the forward
  test* on the page defines every column.
- **Return** is the peak return: the highest High confirmed after identification against the CMC
  price recorded at identification — the maximum increase, not a trade or realized profit (a stop
  could have been hit first), and no "pumped" threshold exists. `≥ x %` is so far (window open,
  final day pending or a day missing); only FINAL events have an exact peak.
- **Days and time zones:** a day is a UTC calendar day; day 0 is the UTC date of identification and
  day 7 the UTC date of identification + 168 h, included to its end. Times are shown in the display
  timezone (`DISPLAY_TIMEZONE`, Asia/Tehran: a UTC day starts at 03:30 there).
- **High check** column: *Not checked yet*, *New record found*, *Checked; record unchanged*, *Data
  unavailable* or *Data retrieval error*, the UTC date every closed day is checked through, and when
  the last successful check ran (hover for the note). Highs are checked once per closed UTC day by
  the first hourly run after 00:00 UTC, retried while a day is missing, and on *Update Highs now* —
  never when the page opens. *Update Highs now* runs in the background: the page shows its
  progress, then how many events were checked, got a new highest High, stayed unchanged, had no
  data or failed.
- A yellow **Day 0 High** is the identification day's High that CMC dates before identification
  (or without a time): it is shown but never counted in Return or any statistic. Click it, or the
  *day 0 unconfirmed* note, for the times. *N overlapping* lists the same coin's other events whose
  windows overlap this one (this row not included); the dialog opens with the coin's Average Return.
- **Average Return (coin)**: the mean of the Returns of *all* stored events of the coin (same CMC
  id, any status and star count, whatever the filters), with "k of n events with a Return". Events
  without a Return are left out, never counted as 0 %. `≥ x %` with *lower bound · n not final*
  means some of those Returns are still so far: the average can rise and is not a final result;
  *all final* means every one is FINAL. A peak return, not profit.
- **LBank** (*Spot*, *Futures*) and **Bithumb**: whether the coin is listed now in LBank's Spot
  markets, LBank's Futures (perpetual) markets and Bithumb's Spot markets, each from its own list on
  CMC, by CMC id (section 4). *Unknown* means that list is not verified — not fetched yet, failed,
  incomplete or too old — and is never shown as *No*. The line above the table says when each list
  was fetched; filter with *LBank* (Spot and Futures, Spot only, Futures only, …, Unknown) and
  *Bithumb* (listed, not listed, unknown).
- Warnings: `FRESHNESS` / `UPDATE_FAILED` — the daily update has not run successfully; check the
  run's `forward` stage and the source health. `UPDATE_PARTIAL` — some Highs are not published
  yet; retried automatically. `INCOMPLETE_DAY0` — the signal day's High came before detection and no
  later High reached it. CMC's hourly Highs settle the rest of that day automatically (rules
  `star-forward-2`); what stays open is the detection hour when its High came before detection (or
  a day whose hourly data was not available), so the peak stays a lower bound.
- Outcomes are also compared by the pass pattern and the weighted points the coin had at detection
  (both stored with the event, never recalculated): use them to judge the 60 / 25 / 15 weights on
  later data, not as a forecast.
- Reprocessing a batch, *Reprocess latest batch* and the LBank refresh never create events, and
  signals from before deployment are not backfilled.

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
| `exchange-lists:status`                         | LBank Spot, LBank Futures and Bithumb lists behind the forward-test listings       |
| `exchange-lists:refresh`                        | Fetch the LBank Futures and Bithumb lists now (no rescan; not Tier 1 inputs)       |
| `daily:import-csv --id CMC_ID --file F`         | Import a CMC "Download CSV" history file as completed daily rows                   |
| `telegram:preview [--batch ID] [--fake]`        | Print the Telegram summary without sending                                         |
| `source:reset --provider coinmarketcap_web`     | Clear a suspended source after fixing the cause                                    |
| `forward:status [--json]`                       | Forward test: star groups, High coverage, last trigger and daily update, warnings  |
| `forward:events [--view V] [--stars N] [--json]` | Forward-test events (`active`, `final`, `incomplete`, `all`) with their latest outcome |
| `forward:update`                                | Run the daily High update now (normally automatic), then write its export          |
| `forward:export`                                | Write the forward-test CSVs, workbook and manifest                                 |

## 7. Troubleshooting

| Symptom                                  | Likely cause                                                                                            | Action                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Many `DAILY_ROW_MISSING`                 | Cold start, the daily stage hit its time / asset / budget bound, or CMC has not published yesterday yet | Wait for the next runs (retries after `TIER1_DAILY_RETRY_HOURS`); check `metrics.daily` on the run and the budget on _Runs & health_                                                                                                                                                                                                                 |
| Many `CURRENT_STALE`                     | The listing returned old provider timestamps                                                            | Compare provider update time and crawl time in the trace; persistent staleness means a source problem                                                                                                                                                                                                                                                |
| Source circuit `open` / `suspended`      | Repeated errors or 401/403 denials                                                                      | Stop and investigate (network, blocking, route change) before `source:reset`                                                                                                                                                                                                                                                                         |
| "The latest crawl batch … failed" banner | Network loss (e.g. the host slept), timeouts or server errors opened the circuit (15-minute cooldown)   | Once the cause is gone, press _Retry crawl now_ in the banner (needs `scan:operate`): it closes an `open` circuit, skipping the cooldown, and crawls the current hour again. It refuses while a run holds the lease, when this hour already completed, when the source is `suspended` (use `source:reset`) or while a provider Retry-After is active |
| Budget nearly used                       | Daily refresh volume above the monthly budget                                                           | Raise `CMC_WEB_MONTHLY_REQUEST_BUDGET` deliberately or reduce `TIER1_DAILY_MAX_ASSETS_PER_RUN`; the hourly listing keeps a reserve                                                                                                                                                                                                                   |
| A `failed` / `missed` row in Pipeline runs | The app was down, or a stage failed | As owner, press _Recover_ on the row. The current hour is crawled again; a past hour with a stored crawl is rescanned and re-exported; a past hour with nothing stored stays a gap (CMC serves only current quotes), and recovery fetches what is still available instead: the current hour, or daily history plus a rescan of the latest batch. The result shows in the row's Recovery column |
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

### Copy production to the local database

`npm run db:pull-prod` replaces the local database with the latest production data, then applies
the local migrations production does not have yet (`scripts/db/pull-prod.sh`):

1. Streams a read-only `pg_dump` of the production database over `ssh jahantalab` (`PROD_SSH`,
   `PROD_DIR` override the host and path) into `backups/coins-prod-<time>.dump`. Nothing is
   written on the server.
2. Backs up the local database to `backups/coins-local-before-pull-<time>.dump`.
3. Drops and recreates the local database (the one in `DATABASE_URL`, which must be the Docker
   Postgres on `127.0.0.1:${POSTGRES_PORT:-5433}`), restores the dump and runs `db:migrate`.
4. Clears sign-in sessions and the pipeline lease (they belong to the server) and puts back the
   local Telegram members and bot offset (`--server-telegram` keeps production's).

It asks you to type the database name first (`--yes` skips that) and refuses while the app or a
CLI command runs locally. `--download-only` only saves the dump; `--from <file>` restores a saved
one. Afterwards the local copy holds production's users: sign in with your production account.
Local runs then add their own batches on top; with live Telegram in `.env` they also send reports,
so use `TELEGRAM_MODE=dry_run` locally if the server already reports to the same people.

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

1. Stop the app (`npm start`, or `docker compose --profile app stop api`). With the Docker app
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
