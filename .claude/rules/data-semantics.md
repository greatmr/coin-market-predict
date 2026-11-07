---
paths:
  - "src/modules/sources/**"
  - "src/modules/ingestion/**"
  - "src/modules/daily-metrics/**"
  - "src/modules/venues/**"
  - "src/modules/strategy/**"
  - "src/modules/scan/**"
  - "src/modules/exports/**"
  - "src/database/**"
---
# Data semantics

- Time: store UTC; bucket observations into hourly `slotTime`; keep provider `observedAt`
  and our `collectedAt` separately. A scan's as-of time is its batch's crawl time (no look-ahead).
  Daily rows are completed UTC days only; the open day is never used. Display timezone is
  presentation only.
- Identity: canonical `Asset.id`; link providers via `AssetIdentity` (provider + provider id)
  and `AssetContract` (chain + contract; EVM lower-cased). Tier 1 keys on the CMC id
  (`CmcAsset`, `DailyMetric`, LBank `baseCurrencyId`). Never match by symbol; a symbol mismatch or
  one ticker on several ids is an ambiguous mapping for a reviewer.
- Market cap = circulating, never FDV. Current VMC = rolling-24h volume ÷ circulating cap from the
  same observation. Daily VMC = that day's volume ÷ that day's market cap. Never subtract
  overlapping 24h totals; never mix daily conventions in one window.
- Window means are arithmetic means of daily ratios over exactly the last N completed dates
  (never Σvolume ÷ Σcap). One missing or invalid day makes only the windows containing it N/A.
- Missing values are NULL with a reason (`nullReasons`, reason codes) — no estimates, no
  forward-fill, no interpolation. Unknown/ambiguous eligibility inputs → NEEDS_REVIEW.
- Revisions: daily rows keep every revision (source route, params, response SHA-256); a new
  revision only when normalized values change. Scans store the revision ids they used.
- Coverage: a batch is COMPLETE only when every listed coin was stored and ranks 1–1200 are
  contiguous and unique; otherwise the Review Queue is withheld.
- Classification only ever gets stricter (tags → name → price evidence in `classify.ts`); never
  use an ambiguous tag alone (`liquid-staking-derivatives`, `stablecoin-protocol`). Heuristic
  classes are CLASS_AMBIGUOUS (review), not exclusions; reviewed exceptions go in
  `config/tier1-overrides.json` with a version bump.
- Sources: official APIs or the explicitly configured CMC website collector; respect budgets,
  Retry-After and circuit breakers; suspend on persistent denial. No CAPTCHA bypass or evasive proxies.
