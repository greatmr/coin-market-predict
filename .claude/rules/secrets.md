# Secrets (applies everywhere)

- Never print, `cat`, `grep`, or echo values from `.env`, `.env.*` (except `.env.example`),
  or `secrets/`. Check configuration by key name and length only, e.g.
  `awk -F= '/^NAME=/{print $1, length($2)}' .env`, or `npm run cli -- config:check`.
- New secrets: add the key to `SECRET_KEYS` in `src/config/env.validation.ts` (masking, `_FILE`
  support) and a placeholder to `.env.example`. Secrets never become dashboard settings
  (`src/config/settings.catalog.ts`; its spec refuses them): they would be stored in the database
  and shown to owners.
- Agents receive only `buildAgentEnv()` (allowlist). Never spread `process.env` into the SDK.
- Errors and logs pass through `redact()`; Telegram bot tokens appear in API URLs.
- Never add `ANTHROPIC_API_KEY` fallbacks: agent auth is the subscription OAuth token only.
