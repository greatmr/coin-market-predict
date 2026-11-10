# Example exports (SYNTHETIC)

Every coin, price and volume here comes from the synthetic fixture market (`DATA_SOURCE=fixture`)
and is invented; the files show the format only. `data_label` is `SYNTHETIC` on every row.

## Tier 1

Trimmed copies of the export of batch `2026-11-10T19:00Z` (the fixture's anchor date, when its
designed edge cases hold), ranked with the weighted star ranking `weighted_star_v1`
([strategy § 6a](../strategy-two-tier-vmc.md#6a-weighted-star-ranking-weighted_star_v1-operator-decision-d3)).

| File | Content |
|---|---|
| `tier1-review_queue.synthetic.csv` | Header + the first 3 queue rows (3★, 100 points) and every 2★ and 1★ row, in queue order: 85 → 85 lower bound (BADD, `YES/YES/N/A`) → 75 → 40 → 40 lower bound (ZBAS, `N/A/YES/YES`) → 60 → 60 lower bound (GAPD) → 25. Every 2-star row, the 40-point ones included, precedes every 1-star 60-point row |
| `tier1-needs_review.synthetic.csv` | Header + 5 rows: ambiguous LBank tickers (AMB, both TWIN), an ambiguous (wrapped) class, a missing rank |
| `tier1-excluded.synthetic.csv` | Header + 6 rows: rank 100 and 1201, 59-day listing age, no LBank pair, stablecoin, tokenized stock |
| `tier1-run_metadata.synthetic.csv` | The complete Run_Metadata sheet (batch status, field counts, counts, N/A reasons, LBank crawl, ranking version and queue-order rule, warnings) |

A real export directory also contains `all_eligible.csv`, `workbook.xlsx` (the five sheets) and
`manifest.json` (SHA-256 per file); see [the operator guide](../operator-guide.md#5-exports).
Column order: the PDF's 28 mandatory columns first (p.17), then reasons, LBank details,
`queue_order` with the ranking columns (`weighted_pass_points`, `score_complete`,
`weighted_strength`, `ranking_ruleset_version`), venue details, diagnostics, review fields, inputs
hash and versions. Ratios are plain decimals (0.2 = 20 %); N/A values are blank with a reason code
in the matching `reason_*` / `avg_*_reason` column.

## Star Event Forward Test

From a 10-day demonstration on the fixture market (two hourly runs per simulated UTC day,
31 Oct – 9 Nov 2026, then the run of 10 Nov 19:00 UTC and a daily update); see
[forward-test.md](../forward-test.md). Trimmed copies of one forward-test export:

| File | Content |
|---|---|
| `forward-events_final.synthetic.csv` | Header + 6 FINAL events, one per pass pattern (100, 85, 75, 40, 60 and 15 weighted points at detection): every included day covered, exact peak (`peak_kind = EXACT`) |
| `forward-events_active.synthetic.csv` | Header + 2 TRACKING and 2 AWAITING_FINAL_DAY events: provisional lower bounds |
| `forward-events_incomplete.synthetic.csv` | Header + 3 INCOMPLETE events: the fixture's designed missing day (`HIGH_MISSING:2026-11-05`) and two `INCOMPLETE_DAY0` |
| `forward-cohort_summary.synthetic.csv` | The complete report: by star count, by detection-time pass pattern and by weighted-points band (`dimension` column) |
| `forward-run_metadata.synthetic.csv` | The complete Run_Metadata sheet (definitions, counts, coverage, warnings) |

The synthetic market keeps each coin's stars constant within a UTC day, so the second run of each
day only re-sights existing events. A real export directory also has `distributions.csv`,
`rejected_triggers.csv`, `workbook.xlsx` and `manifest.json`. Money and percentages are plain
decimals at full precision; a provisional peak is a lower bound, never a final result.
