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
    title: 'How the LBank Spot observation works',
    intro:
      'Each 1, 2 or 3-star event found by the hourly screen since the cutover is followed on LBank Spot for exactly 168 hours, to see how far the price rose and fell.',
    sections: [
      {
        h: 'Events',
        items: [
          'One event per coin, UTC day and star count: the same stars again that day add nothing; more stars open a new event.',
          'The signal time (t0) is the hourly batch’s crawl time. The CMC price at t0 is context only and never used in a result.',
          'Events of the same coin can overlap in time: they follow one price path, so they are correlated. Click “overlap” in a row to see them.',
        ],
      },
      {
        h: 'Prices (all LBank Spot, 1-minute candles)',
        items: [
          'Entry: the opening price of the first 1-minute bar at or after t0. More than 2 minutes late → no entry; no trade in the hour before → the entry is stale.',
          'Maximum rise = highest High ÷ entry − 1. Maximum drop = lowest Low ÷ entry − 1.',
          'Only minutes with trades count. The window ends exactly at t0 + 168 h; the minute that straddles the end is not used.',
          'If the High and the Low fall in the same minute, their order is unknown.',
        ],
      },
      {
        h: 'Spot / Futures at the signal',
        items: [
          'Spot comes from LBank’s own candles and pair list around t0. Futures needs CMC’s LBank Futures list before t0 and LBank’s contract list after t0 to agree.',
          'Anything not proven stays Unknown: it is never shown as Yes or No.',
        ],
      },
      {
        h: 'Status',
        items: [
          'Active: the window is running or its last minutes are still being fetched. Values are provisional (marked *).',
          'Final: the 168 hours passed with every minute present, a fresh entry and at least one trade. Only Final events enter the statistics.',
          'Partial: the window is over but minutes were missing, the entry was stale or nothing traded.',
          'Data unavailable, Mapping ambiguous, Eligibility unknown: no usable LBank price, the pair cannot be tied to the coin, or Spot at the signal stayed unknown.',
        ],
      },
      {
        h: 'Updates',
        items: [
          'A background job runs every 15 minutes; “Update now” on the Data page starts it at once.',
          'Statistics, the cutover and the export are on the Data page.',
        ],
      },
      {
        h: 'Remember',
        items: [
          'Two independent price extremes, not a trade: no stop, target, fee, leverage or profit is modelled, and Futures is an eligibility label only.',
        ],
      },
    ],
    doc: 'docs/lbank-spot-observation.md',
  },
  observationResults: {
    title: 'Reading the observation results',
    intro: 'Summary of the LBank Spot observation, counted on Final events only.',
    sections: [
      {
        h: 'Tiles',
        items: [
          'Cutover: from this UTC midnight new star events go to the LBank observation; earlier ones stay in the legacy forward test.',
          'Final is the denominator of every statistic. Provisional (active, partial) and unmeasured events are counted apart and never mixed in.',
          'Last update: the most recent run of the 15-minute job.',
        ],
      },
      {
        h: 'Table',
        items: [
          'Median, 25th and 75th percentile of maximum rise and maximum drop, per star count and per Spot / Futures class.',
          'Events of one coin are correlated: the coin count shows how many independent price paths stand behind a row.',
        ],
      },
    ],
    doc: 'docs/lbank-spot-observation.md § 6',
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
          'LBank 1-minute candles are shared per pair and deleted after their retention once no unfinished observation needs them. Results keep a hash of the exact candles used.',
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
