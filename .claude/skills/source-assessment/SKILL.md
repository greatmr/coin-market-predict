---
name: source-assessment
description: Procedure for evaluating a new or changed crypto market-data source (permissions, redistribution, rate limits, fields, history, coverage) before writing or enabling an adapter. Use when someone proposes a new data source or a provider changes its terms or plans.
---

# Source assessment

1. **Read primary documents, not summaries**: terms of use, API terms, pricing/plan page,
   robots.txt, official API reference. Record URL + retrieval date for each quote.
2. **Permission questions** (answer yes / no / unclear, with a quote):
   - Is automated access to this surface permitted? (robots.txt is not a licence.)
   - May the data be stored long-term? Is there a cache-refresh clause?
   - May derived results be shown on a dashboard and posted to a Telegram channel?
     Private vs public audience? Attribution text required?
   - Is this a documented endpoint? Undocumented/private APIs are out of scope.
3. **Capabilities**: fields (price, circulating market cap, volume + window, circulating supply,
   contracts, spread/depth), coverage (count of listed assets), history depth, freshness,
   pagination model.
4. **Limits**: requests/minute, monthly cap, credits per call, error codes for throttling.
   Compute requests per hourly sweep and per month; compare with the budget settings in
   `.env.example`.
5. **Maintenance**: auth needs, schema stability, anti-bot measures (any challenge page means
   the surface is not for automation — stop).
6. **Write up** in `docs/source-feasibility.md` (table row + quotes + limitations). Only then
   implement an adapter under `src/sources/<provider>/` with a saved fixture and parser tests,
   and keep it opt-in via `DATA_SOURCE`.
