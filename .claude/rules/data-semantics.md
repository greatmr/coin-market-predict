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
- Classification only ever gets stricter (tags → name → price evidence in `classify.ts`); never
  use an ambiguous tag alone (`liquid-staking-derivatives`, `stablecoin-protocol`).
- History backfill stores only genuine source samples aligned to hourly slots; it never
  overwrites an existing observation. Derived rows exist only for the screen universe.
- Features: declare `minSnapshots` and fields in `features/registry.ts`; missing history →
  NULL + reason. Any formula change bumps `FEATURE_SET_VERSION`; strategy changes bump the
  strategy `version`.
- Sources: official APIs or the explicitly configured CMC website collector; respect budgets,
  Retry-After and circuit breakers; suspend on persistent denial. No CAPTCHA bypass or evasive proxies.
