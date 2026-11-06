# Example exports (SYNTHETIC)

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
