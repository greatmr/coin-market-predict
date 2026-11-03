---
paths:
  - "src/sources/**"
  - "src/ingestion/**"
  - "src/features/**"
  - "src/screening/**"
  - "prisma/**"
---
# Data semantics

- Time: store UTC; bucket observations into hourly `slotTime`; keep provider `observedAt`
  and our `collectedAt` separately. Display timezone is presentation only.
- Identity: canonical `Asset.id`; link providers via `AssetIdentity` (provider + provider id)
  and `AssetContract` (chain + contract; EVM lower-cased). Never match by symbol.
- Market cap = circulating. If missing, calculate from circulating supply and set
  `marketCapProvenance = calculated_from_circulating_supply`. Never use FDV.
- Volume: `volumeRolling24h` is the provider's rolling total. `volumeHourly` only from sources
  with real hourly bars. Never subtract overlapping 24h totals.
- Missing values are NULL with a reason in `nullReasons` — no estimates, no forward-fill.
- Coverage: "complete" only when the full listing was read and every listed asset collected.
- Features: declare `minSnapshots` and fields in `features/registry.ts`; missing history →
  NULL + reason. Any formula change bumps `FEATURE_SET_VERSION`; strategy changes bump the
  strategy `version`.
- Sources: documented, permitted access only; respect budgets, Retry-After, circuit breaker;
  suspend on persistent denial. No scraping of sites whose terms forbid it.
