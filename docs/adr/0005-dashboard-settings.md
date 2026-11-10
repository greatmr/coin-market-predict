# ADR-0005: Dashboard settings

- Status: accepted (2026-11-11)
- Changes: most variables of `.env.example` become owner-managed settings in the database

## Context
Every change of the schedule, a request budget, the Telegram mode or a retention period meant
editing `.env.prod` on the server and recreating the container. The operator asked to manage those
values in the dashboard and to keep only credentials and other critical values in the environment.
Constraints: the configuration is validated in one place before Nest boots (Zod,
`config/env.validation.ts`), several values are used when providers are built, a pipeline run must
use one consistent set of thresholds, and the owner must never be locked out of the dashboard by a
setting.

## Decision
- **Catalog** (`config/settings.catalog.ts`): the 34 settings an owner may change, each with a group,
  label, help text, kind, bounds and apply mode. It excludes credentials (`SECRET_KEYS`,
  `TELEGRAM_CHAT_ID`), the database connection, `NODE_ENV` / `HOST` / `PORT`, `COOKIE_SECURE` /
  `TRUST_PROXY` (a wrong value could lock the owner out) and file paths (`TIER1_EXPORT_DIR`,
  `TIER1_OVERRIDES_FILE`). The Zod schema stays the authority; a unit spec checks that the catalog's
  bounds, options and defaults match it.
- **Storage** (migration M010): `app_setting` (one row per saved key, scalar JSON value, who and
  when) and `app_setting_change`, an append-only history (a trigger refuses edits and deletions,
  except the foreign key clearing a deleted user; the name is kept).
- **Precedence per key: environment > saved setting > default.** A key set in the environment is
  locked in the dashboard. This keeps one-off overrides such as
  `TELEGRAM_MODE=dry_run npm run cli -- run-once` working, lets a deploy pin a value, and makes the
  move from `.env.prod` explicit: "Import from environment" (`settings:import-env`) copies the
  current values, then the operator removes the lines and restarts. Removing a line without
  importing it would fall back to the default (for example the synthetic data source).
- **One validation** of environment and saved settings together, before Nest boots: the server, the
  CLI and MCP stdio read `app_setting` with a short-lived connection (the server retries while the
  database starts; a database without M010 has no settings), then `loadConfig(env, saved)`. Saving
  re-validates the whole configuration, cross-field rules included (live Telegram needs the token
  and chat id from the environment; the LBank maximum age is at least the refresh interval), so an
  invalid combination is refused at save time. If the environment later changes underneath a saved
  value, start-up fails with a message naming the key and `settings:reset`.
- **Applying**: `APP_CONFIG` is one shared object that providers read at call time. `LiveConfig`
  copies `live` settings into it in place and notifies listeners: the scheduler reschedules or
  starts / stops its cron jobs (turning it back on records the hours it was off as missed and runs
  the current hour per the missed-run policy), the HTTP clients take new rate limits, budgets,
  retries and cache times, and the bot poller starts or stops. `restart` settings (`DATA_SOURCE`,
  `CMC_WEB_LISTING_PAGE_SIZE`, `SOURCE_MAX_MARKET_PAGES_PER_RUN`) are used when the adapters are
  built and apply at the next start; the dashboard says so.
- **Run consistency**: the pipeline lease holds the configuration. A change saved during a run waits
  until it ends, so a run's scan, export, Telegram report and forward test never mix two
  configurations. Result-affecting thresholds are part of each scan's configuration version, as
  before.
- **Access**: the new `settings:manage` permission, owner only, covers reading too (the settings
  describe the operation). Changes made with the CLI (`settings:set`, `settings:reset`) are picked
  up by the running server before its next scheduled run, or at a restart. The CLI works without
  booting the application, so it can repair settings that keep the server from starting.

## Consequences
- `.env.example` keeps only the server, database, credentials, proxy / cookie and file-path
  variables; `DASHBOARD_BASIC_AUTH` (unused since ADR-0003) is gone.
- Existing deployments keep working unchanged: every variable still in `.env.prod` takes
  precedence until it is imported and removed (`docs/deployment.md`).
- A saved setting changes behaviour without a deploy. The change history (dashboard, `settings:history`)
  is the record of who changed what and when.
- Tests never read `process.env` for application inputs: `makeApp` passes its environment
  explicitly (`ConfigInputs`), and the keys it sets are locked against saved settings.
