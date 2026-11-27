// "How it works" guides behind the help (?) buttons: one per page and per Data-page section, in
// plain words, condensed from docs/ (operator-guide.md, strategy-two-tier-vmc.md, forward-test.md,
// lbank-spot-observation.md, adr/0008-storage-scope.md). Keep them in step when those docs change.
import type { ReactNode } from 'react';

export interface GuideSection {
  h: string;
  items: ReactNode[];
}
export interface Guide {
  title: string;
  /** One or two sentences: what the page or section is for. */
  intro: ReactNode;
  sections: GuideSection[];
  /** The document in docs/ with the full rules. */
  doc?: string;
}

export type GuideKey =
  | 'overview'
  | 'queue'
  | 'observation'
  | 'observationResults'
  | 'forward'
  | 'forwardResults'
  | 'data'
  | 'dataQuality'
  | 'exclusions'
  | 'storage'
  | 'batches'
  | 'access'
  | 'users'
  | 'account';

const NOT_ADVICE =
  'Research material for a human reviewer: nothing here is a buy signal, a prediction or a profit claim, and no order is ever placed.';

export const GUIDES: Record<GuideKey, Guide> = {
  overview: {
    title: 'How the hourly screen works',
    intro:
      'Every hour the platform reads every coin CoinMarketCap lists, screens it with the Tier 1 rules and hands the coins that stand out to a human (Tier 2) for a chart review.',
    sections: [
      {
        h: 'One hourly run',
        items: [
          'Discover and collect: every listed coin is read; ranks 1–1,200 are stored as an hourly snapshot.',
          'LBank and daily rows: the LBank Spot markets list and the completed UTC daily rows of the screen candidates are refreshed.',
          'Scan (Tier 1): eligibility, then the volume-to-market-cap (VMC) windows; the coins with at least one star form the review queue.',
          'Export, notify and track: CSV exports, the Telegram summary, and each new star event is handed to the LBank Spot observation.',
        ],
      },
      {
        h: 'On this page',
        items: [
          'The ring shows the running run, or the countdown to the next one, with its stages.',
          'The funnel goes from every listed coin to ranks 1–1,200, to eligible coins, to the queue.',
          'A banner explains a withheld queue: an incomplete batch or an unavailable LBank list. No rule is relaxed to fill the queue.',
        ],
      },
    ],
    doc: 'docs/operator-guide.md § 2',
  },
  queue: {
    title: 'How the review queue is built',
    intro:
      'The coins whose trading activity is unusual compared with their own history, ranked for a human chart review.',
    sections: [
      {
        h: 'Eligible coins (all must hold)',
        items: [
          'Rank 101–1,200, circulating market cap at least $15M, listed at least 60 days.',
          'Not a stablecoin or tokenized asset, and a verified LBank Spot pair.',
          'Missing or ambiguous data never passes: such a coin is not evaluated for stars.',
        ],
      },
      {
        h: 'Stars',
        items: [
          'VMC = rolling 24 h volume ÷ circulating market cap.',
          'The current VMC is compared with the coin’s own means of completed UTC days over 3, 7 and 30 days (14 days is context only).',
          'A window is YES when the current VMC is at least 1.5 × its mean; stars = number of YES windows.',
        ],
      },
      {
        h: 'Order',
        items: [
          'By stars, then weighted points: 3-day 60 · 7-day 25 · 30-day 15 per YES. “≥ n” means a window was not available, so the score is a lower bound.',
          'Click a row for the coin page: the calculation trace, the live chart and the review form.',
        ],
      },
      { h: 'Remember', items: [NOT_ADVICE] },
    ],
    doc: 'docs/strategy-two-tier-vmc.md',
  },
  observation: {
    title: 'How the LBank price observation works',
    intro:
      'Each 1, 2 or 3-star event found by the hourly screen since the cutover is followed for exactly 168 hours from the moment the signal could be used, on LBank Spot (rules lbank-spot-obs-2, verified trades) and separately on LBank Futures (rules lbank-futures-sampled-1, sampled snapshots). Use Spot / Futures / Compare above the table to switch.',
    sections: [
      {
        h: 'Reading the table',
        items: [
          'Spot / Futures / Compare switches the venue. Compare stacks both venues in the same cells; each is measured only against its own reference.',
          'Window start: when the Review Queue holding the signal was published; underneath, how long after the CMC crawl that was (about 5 s normally, about 8.5 min at 00:07 UTC when the daily rows are refreshed first).',
          'Reference: the first verified trade after the start; underneath, its market delay (e.g. +0.660 s). That is market time, not how long the page took to show it: Details → Timing shows those separately.',
          'Provisional: the 168-hour window is still running or a needed trade is not verified yet, so values can change. Final (Spot only): the window is over and every needed trade was verified. A job that succeeded, or 168 hours passing, is not enough on its own.',
          'Sampling (Futures): the window is running and LBank Futures snapshots are being collected; it becomes Closed (sampled) at the end and is never Final.',
          'Status · data · flags: the status, any reason beyond “window running”, data through (how far LBank data has been fetched — the last job may only have recomputed), gaps, review flags and overlapping windows.',
          'Delayed: at least one whole minute after the window start passed without a trade before the reference trade.',
          'Thin high: the highest verified price occurred in a minute with exactly one trade. Thin low: the lowest verified price occurred in a minute with exactly one trade.',
          'Flags are interpretation aids, not proof of an error; flagged observations stay in every count. “N overlapping” is not a flag: it lists the same coin’s other windows that share time with this one.',
          'More filters (listing evidence, coverage, flags, crawl dates) opens a small panel; the button shows how many are set.',
        ],
      },
      {
        h: 'Events',
        items: [
          'One event per coin, UTC day and star count: a different star count on the same UTC day opens a new event whether the count is higher or lower; the same count again that day adds nothing; a new UTC day starts over.',
          'The CMC crawl time names the event (its UTC date) and decides the tracker at the cutover. The CMC price is context only and never used in a result.',
          'Events of the same coin can overlap in time: they follow one price path, so they are correlated. Click “overlapping” in a row to see them.',
        ],
      },
      {
        h: 'The window',
        items: [
          'It starts when the star signal was proven usable: the moment the Review Queue holding it was published (normally seconds, at 00:07 UTC several minutes, after the crawl). Never the crawl time.',
          'It ends exactly 168 hours later; a trade at the start counts, one at the end does not. It is never stretched to the end of a day.',
          'Without a publication record the start is when the event itself was stored (marked as later than the earliest possible moment).',
        ],
      },
      {
        h: 'Prices (all LBank Spot trades)',
        items: [
          'Reference price: the first LBank Spot trade at or after the start, with its exact time and delay. An observed trade, not an order that could have been filled.',
          'Delayed: at least one whole minute after the start passed without any trade. The delay is always shown; nothing is excluded.',
          'Highest and lowest: real trades only. 1-minute candles only point to where to look; a candle’s High or Low can be the previous close without any trade, so every deciding minute is checked trade by trade.',
          'Maximum rise = highest ÷ reference − 1 (never below 0). Maximum decline = lowest ÷ reference − 1 (never above 0). Two independent extremes: never summed, not profit, not a stop loss.',
          'Thin high: the highest verified price occurred in a minute with exactly one trade. Thin low: the lowest verified price occurred in a minute with exactly one trade. Flags help interpretation; they are not proof of an error and nothing is removed. Overlapping windows are a different thing, not a flag.',
        ],
      },
      {
        h: 'Futures: first price observed after the signal',
        items: [
          'The moment the Review Queue is published, we ask LBank Futures for its current market data. The first valid lastPrice returned by a request sent at or after that moment is the Futures reference: “First Futures price observed after signal”. Its delay is measured to when the response arrived; Details also shows when the request was sent and stored, and any failed attempts before it.',
          'This is the price LBank reported when we asked, not a trade we can time: LBank’s response has no trade time, so the price may come from a trade before the signal. It is not the first Futures trade after the signal and not the price an order of ours would have filled at (no order is placed).',
          'Nothing waits for a minute tick or a change in 24 h turnover; if the first request fails, it is retried within seconds and the real delay of the first valid price is shown, with what sent it (publication, retry or minute tick).',
          'Highest and lowest: the extreme prices our requests observed during the window (about once a minute), vs the first observed price. Observed quotes, not verified trades; LBank’s 24 h high/low is never used.',
          'Order book (Details): best bid and ask read right after the first price, as context only — never the reference, never an entry or fill price.',
          'Contract: the one LBank Futures contract CMC attributes to this coin’s CMC id (by its market link) that LBank lists; a ticker match alone never counts (Contract ambiguous).',
          'Older events (before 2026-11-27) keep their original Futures method, labelled “old method”: a turnover-rise snapshot pair, or “Not sampled at start”. Their first price observed after the fix is shown apart and is never treated as their entry. Futures values are never taken from Spot or a listing. Never Final: an ended Futures window is “Closed (sampled)”.',
        ],
      },
      {
        h: 'Listing evidence',
        items: [
          'Spot at the signal comes from LBank’s own candles and pair list around the signal.',
          'Futures listing (the filter under “More filters”) is a snapshot before (CMC’s LBank Futures list) and after (LBank’s contract list) the signal: listing evidence, not proof a contract was tradable at that instant.',
        ],
      },
      {
        h: 'Status',
        items: [
          'Active: the window is running or its data is still being fetched or verified. Values are provisional (marked *).',
          'Final: the 168 hours passed, the reference and every deciding trade verified, and no minute missing. Only Final events enter the statistics.',
          'No trades in window: every minute was verified and nothing traded (no percentage exists).',
          'Partial: the window is over but some minutes could not be fetched or verified after a day of retries; values cover the rest. Unverifiable: no first trade could be proven.',
          'Data unavailable, Mapping ambiguous, Eligibility unknown: no usable LBank pair, the pair cannot be tied to the coin, or Spot at the signal stayed unknown.',
          'A failed or rate-limited request is never read as a quiet market: it is a gap, retried until a day after the window.',
        ],
      },
      {
        h: 'Updates',
        items: [
          'A background job runs every 15 minutes, and also about a minute after each new event’s start minute closes (and every minute while a new reference is still pending), so a reference shows within a minute or two. “Update now” on the Data page starts it at once and says whether it fetched new data or only recomputed.',
          'Reference delay (+0.660 s) is market time from the start to the trade. Details → Timing shows separately when the job verified it and when this page showed it. The page reloads within 30 s of a job storing new results.',
          'Data through = how far LBank data was fetched; last recomputed is not new data. Each row shows its data through; “Details” lists every gap and the evidence behind each number.',
        ],
      },
      {
        h: 'Remember',
        items: [
          'A measurement, not a trade: no order, stop, target, fee, leverage or profit is modelled. 1-minute candles cannot tell the order of trades inside a minute.',
        ],
      },
    ],
    doc: 'docs/lbank-spot-observation.md (rules lbank-spot-obs-2; Futures § 13, lbank-futures-sampled-1)',
  },
  observationResults: {
    title: 'Reading the observation results',
    intro:
      'Summary of the LBank Spot price observation (rules lbank-spot-obs-2), counted on Final events only.',
    sections: [
      {
        h: 'Tiles',
        items: [
          'Cutover: from this UTC midnight new star events go to the LBank observation; earlier ones stay in the legacy forward test.',
          'Final is the denominator of every statistic, in events and in distinct coins. Active, partial, no-trade, unverifiable and unmeasured events are counted apart and never mixed in.',
          'Data freshness: how far behind the oldest open window’s LBank data is, and the last successful fetch, separate from when the job last ran.',
          'Last update: the most recent run of the 15-minute job and whether it fetched new LBank data or only recomputed.',
        ],
      },
      {
        h: 'Table',
        items: [
          'Median and 25th–75th percentile of the highest and the lowest return, per star count and per Spot / Futures evidence class.',
          'Events of one coin are correlated: the coin count shows how many independent price paths stand behind a row. No coin weighting is applied.',
          'Flagged events (thin-market extremes, delayed references) stay in the statistics; the tile shows how many.',
        ],
      },
    ],
    doc: 'docs/lbank-spot-observation.md § 8',
  },
  forward: {
    title: 'How the forward test works',
    intro:
      'The legacy tracker for star events found before the LBank cutover. It takes no new events and leaves the navigation once every event has a final outcome.',
    sections: [
      {
        h: 'Events and window',
        items: [
          'One event per coin, UTC day and star count, at the CMC price recorded when the coin was identified.',
          'The window runs 168 hours from identification, through the end of the UTC day in which those 168 hours end. Day 0 is the UTC date of identification.',
        ],
      },
      {
        h: 'Return',
        items: [
          'Return = highest High confirmed after identification ÷ identification price − 1: the maximum rise, not trading profit (a stop may have been hit first).',
          '“≥” means so far: the window is open, the final day is pending or a day is missing. Final values are exact.',
          'Highs come only from the coin’s CMC USD daily (and, for day 0, hourly) data: never the Close, sampled prices or LBank.',
        ],
      },
      {
        h: 'Day 0 (yellow)',
        items: [
          'The identification day’s High may come from before identification. It counts only when CMC dates it at or after identification; otherwise it is shown in yellow and left out of Return and every statistic.',
        ],
      },
      {
        h: 'High checks',
        items: [
          'Once per closed UTC day by the first hourly run after 00:00 UTC, again while a day’s High is missing, and on “Update Highs now” (Data page). Never when the page opens.',
          'Not checked yet · New record found · Checked, record unchanged · Data unavailable · Data retrieval error.',
        ],
      },
      {
        h: 'Other columns',
        items: [
          'Average Return (coin): the mean Return of all of the coin’s events, whatever the filters; “≥” while any of them is still a lower bound. Events without a Return are left out, never counted as 0 %.',
          'LBank Spot / Futures and Bithumb: whether the coin is listed there now, from each exchange’s own list on CMC by CMC id. Unknown = the list is not verified, never No.',
          'Overlapping: the same coin’s other events whose windows overlap this one. They follow one price path, so they are correlated.',
          'Stars, points and the 3d / 7d / 30d ratios are recorded at identification and never change.',
        ],
      },
    ],
    doc: 'docs/forward-test.md',
  },
  forwardResults: {
    title: 'Reading the forward-test results',
    intro: 'Summary of the legacy forward test: counts, results by stars and the High checks.',
    sections: [
      {
        h: 'Results',
        items: [
          'Active returns are so far (≥). Final statistics use Final events only; an unconfirmed day-0 High is never counted.',
          'By pass pattern and by weighted points group the outcomes by what the coin had at identification: use them to judge the 60 / 25 / 15 weights on later data, not as a forecast.',
          'Rejected triggers: queue rows that opened no event, with every reason.',
        ],
      },
      {
        h: 'Warnings',
        items: [
          'Daily update stale or failed: the High check has not succeeded recently; check the run’s forward stage and the source health.',
          'Partial update: some Highs are not published yet; they are retried automatically.',
          'Day 0 never confirmed: the signal day’s High came before identification and nothing later reached it, so those peaks are lower bounds.',
        ],
      },
    ],
    doc: 'docs/forward-test.md § 7–9',
  },
  data: {
    title: 'What the Data page shows',
    intro:
      'The health of the latest hourly batch, why coins are left out of the screen, the summaries of the two trackers and how much space the database takes.',
    sections: [
      {
        h: 'Sections',
        items: [
          'Data quality: quotes, the LBank mapping and list, scan warnings and the last export.',
          'Why coins are left out: every coin is screened each hour, but only the review queue is stored per coin; the others are counted here by reason.',
          'LBank Spot observation and Forward test: their statistics, exports and update buttons.',
          'Database storage: the size on disk, per area and per table.',
        ],
      },
    ],
    doc: 'docs/operator-guide.md § 2, docs/adr/0008-storage-scope.md',
  },
  dataQuality: {
    title: 'Reading data quality',
    intro: 'Whether the latest hourly batch can be trusted.',
    sections: [
      {
        h: 'What is checked',
        items: [
          'Quotes: each coin’s current volume and market cap must be fresh (provider update within 2 hours), timestamped and consistent; otherwise the coin fails closed.',
          'LBank list: a pair in LBank’s Spot markets list on CMC counts as tradable. The list is refreshed every 30 days or with “Refresh LBank list now”; older than 35 days withholds the queue.',
          'A batch is complete only when every listed coin was read and ranks 1–1,200 are contiguous; an incomplete batch withholds the queue.',
        ],
      },
    ],
    doc: 'docs/operator-guide.md § 2, § 4',
  },
  exclusions: {
    title: 'Why coins are left out',
    intro:
      'Every listed coin is screened every hour. Only the review queue is stored per coin, so these counts are the record of everything else.',
    sections: [
      {
        h: 'Reading the bars',
        items: [
          'Ranked above 1,200 or unranked: checked, but outside the screen’s range.',
          'Each other bar is one rule a coin failed: rank, market cap, listing age, stablecoin or tokenized asset, LBank pair, or missing or invalid data.',
          'A coin can fail several rules, so the bars can add up to more than the number of coins.',
          'Any coin still opens on its own page (search at the top), evaluated on request from that hour’s stored inputs.',
        ],
      },
    ],
    doc: 'docs/adr/0008-storage-scope.md',
  },
  storage: {
    title: 'How storage is kept small',
    intro:
      'Sizes come from PostgreSQL itself (tables, their indexes and large values); row counts are the planner’s estimates.',
    sections: [
      {
        h: 'What is kept',
        items: [
          'Hourly snapshots of ranks 1–1,200 are kept in full for the detail window; afterwards only the queue’s inputs, forward-test snapshots and BTC / ETH stay.',
          'LBank 1-minute candles are shared per pair; after their retention (once no unfinished observation needs them) each UTC day is archived compressed before the raw rows go. Verified trades are kept; results keep a hash of the candles and trades used.',
          'Review queue rows, daily rows, reviews and tracker data are never pruned.',
        ],
      },
      {
        h: 'If it grows',
        items: [
          'The largest tables are listed first. A growing candle table usually means many open observation windows.',
          'Earlier rows are removed only by the operator, after a backup (storage:prune).',
        ],
      },
    ],
    doc: 'docs/adr/0008-storage-scope.md, docs/lbank-spot-observation.md § 7',
  },
  batches: {
    title: 'Runs and health',
    intro: 'Whether the hourly pipeline and the data source are working.',
    sections: [
      {
        h: 'On this page',
        items: [
          'Source health: after repeated failures the source pauses (circuit open) and resumes by itself; a suspended source needs the cause fixed first.',
          'Request budget: the monthly number of requests to the CMC website collector.',
          'Batches: each hour’s crawl, with missing or duplicate ranks. A stored hour is never crawled again; the next hour usually recovers.',
          'Runs: each stage of the pipeline with its timing; a failed or missed run can be recovered.',
        ],
      },
    ],
    doc: 'docs/operator-guide.md § 7',
  },
  access: {
    title: 'Telegram',
    intro: 'Who receives the hourly summary, and reports that did not arrive.',
    sections: [
      {
        h: 'On this page',
        items: [
          'Pending requests: people who asked the bot for access; approve or decline them.',
          'Members: who receives the report. Missed reports can be sent again.',
          'The summary is review material, never trading advice.',
        ],
      },
    ],
  },
  users: {
    title: 'Users and roles',
    intro: 'Who can sign in to this dashboard and what each role may do.',
    sections: [
      {
        h: 'Roles',
        items: [
          'Owner: everything, including users, Telegram and the Claude agent.',
          'Analyzer: every data page, run health and exports; can reprocess a batch and refresh the LBank list.',
          'Reviewer: market pages and coin details; records reviews and LBank decisions.',
          'The last active owner can never be removed or demoted.',
        ],
      },
    ],
    doc: 'docs/adr/0003-dashboard-users.md',
  },
  account: {
    title: 'Preferences',
    intro:
      'Your sign-in details, what your role allows, and how the dashboard looks in this browser.',
    sections: [],
  },
};
