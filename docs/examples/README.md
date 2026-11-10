# Example exports (SYNTHETIC)

## Tier 1

Trimmed copies of one Tier 1 export produced by the synthetic fixture market
(`DATA_SOURCE=fixture`, batch `2026-11-05T10:00Z`). Every coin, price and volume is invented; the
files show the format only. `data_label` is `SYNTHETIC` on every row.

| File | Content |
|---|---|
| `tier1-review_queue.synthetic.csv` | Header + the first 10 Review Queue rows, in queue order (3d → 7d → 30d result, then the 3-day multiple) |
| `tier1-needs_review.synthetic.csv` | Header + 5 rows: ambiguous LBank tickers, an ambiguous (wrapped) class, unverified LBank pairs |
| `tier1-excluded.synthetic.csv` | Header + 6 rows: rank 100 and 1201, 59-day listing age, no LBank pair, stablecoin, tokenized stock |
| `tier1-run_metadata.synthetic.csv` | The complete Run_Metadata sheet (batch status, field counts, counts, N/A reasons, LBank crawl, warnings) |

A real export directory also contains `all_eligible.csv`, `workbook.xlsx` (the five sheets) and
`manifest.json` (SHA-256 per file); see [the operator guide](../operator-guide.md#5-exports).
Column order: the PDF's 28 mandatory columns first (p.17), then reasons, LBank and venue details,
diagnostics, review fields, inputs hash and versions. Ratios are plain decimals (0.2 = 20 %);
N/A values are blank with a reason code in the matching `reason_*` / `avg_*_reason` column.

## Star Event Forward Test

From a 10-day demonstration on the fixture market (two hourly runs per simulated UTC day,
31 Oct – 9 Nov 2026, then a daily update at 10 Nov 18:50 UTC); see
[forward-test.md](../forward-test.md). Trimmed copies of one forward-test export:

| File | Content |
|---|---|
| `forward-events_final.synthetic.csv` | Header + 6 FINAL events: every included day covered, exact peak (`peak_kind = EXACT`) |
| `forward-events_active.synthetic.csv` | Header + 3 TRACKING and 2 AWAITING_FINAL_DAY events: provisional lower bounds |
| `forward-events_incomplete.synthetic.csv` | Header + 4 INCOMPLETE events: the fixture's designed missing day (`HIGH_MISSING:2026-11-05`), a missing final day together with an unproven signal day, and two `INCOMPLETE_DAY0` |
| `forward-cohort_summary.synthetic.csv` | The complete star-group report (1★, 2★, 3★, all) |
| `forward-run_metadata.synthetic.csv` | The complete Run_Metadata sheet (definitions, counts, coverage, warnings) |

The synthetic market keeps each coin's stars constant within a UTC day, so the second run of each
day only re-sights existing events; every detection falls at 06:08:30 UTC, hence a single
effective horizon (185.86 h). A real export directory also has `distributions.csv`,
`rejected_triggers.csv`, `workbook.xlsx` and `manifest.json`. Money and percentages are plain
decimals at full precision; a provisional peak is a lower bound, never a final result.
