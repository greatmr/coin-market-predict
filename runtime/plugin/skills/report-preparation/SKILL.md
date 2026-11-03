---
name: report-preparation
description: How the Coins Predicts coordinator merges analyst and reviewer outputs into final signals and a short, non-promotional report summary.
---

# Report preparation

1. Start from the analyst assessment for each asset.
2. Apply the reviewer verdict: `reject` → `no_signal` (or `insufficient_data` if the problem is
   data); `downgrade` → the reviewer's recommended status. Never output a status higher than
   both the analyst's and the reviewer's.
3. Counterevidence = analyst counterevidence + reviewer concerns + failure conditions.
4. Keep `entryTrigger`, `invalidation`, `exitConditions`, and `expiresAt` conditional and tied to
   hourly snapshots. Do not add exact future times other than the expiry.
5. `reportSummary` (≤ 3 sentences): how many assets were reviewed, how many remain
   candidate/watch, and the main caveats (data freshness, partial coverage, warm-up, hourly
   observation limits). It is acceptable — and common — to report that nothing qualifies.
6. Never mention guaranteed returns, "pumps", or certainty.
