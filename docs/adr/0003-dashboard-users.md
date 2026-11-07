# ADR-0003: Dashboard users, roles and sessions

- Status: accepted (2026-11-08)
- Replaces: optional HTTP Basic auth (`DASHBOARD_BASIC_AUTH`) and the "writes only on loopback" rule

## Context
The dashboard is moving to a server and will be used by more than one person. HTTP Basic auth gave
one shared credential with no roles, and writes were allowed only on a loopback bind, which does
not fit a server. The operator asked for three kinds of user (owner, analyzer, reviewer), sign-in
with a username and password, an owner who can change their own details and manage the others, and
a way to recover the owner when the database is emptied.

## Decision
- **Accounts** live in PostgreSQL (`app_user`, migration M007): lowercase unique usernames, a
  scrypt hash (Node's built-in, no native dependency), a role, an active flag, a "must change
  password" flag and a lockout counter.
- **Sessions** are random 32-byte tokens in an HttpOnly, SameSite=Strict cookie (`Secure` over
  HTTPS); only the token's SHA-256 is stored (`user_session`). The expiry slides on use
  (`SESSION_TTL_HOURS`). Password changes, resets, role changes and disabling end sessions.
- **Permissions** are one table (`modules/auth/permissions.ts`). A global guard protects every
  `/api` route: session required unless `@Public` (sign-in, sign-out), a pending password change
  blocks all but the account routes, and the route's `@RequirePermission` (default `data:read`) is
  checked. Writes must be same-origin JSON. The dashboard hides what a role can't use, but the
  server is the authority.
- **Roles**: the owner can do everything; the analyzer reads all data, health and exports and may
  reprocess / refresh the LBank list; the reviewer reads market data and records reviews and LBank
  decisions. The reviewer of record is the signed-in username.
- **Owner bootstrap**: the web server creates `owner` / `owner` (or `INITIAL_OWNER_PASSWORD`) with
  "must change" when no active owner exists, so a fresh or emptied database never locks the owner
  out. The CLI recovers it (`users:reset-owner`) and manages users without the web UI.
- **Invariants** in `UsersService`: at least one active owner always remains; an owner can't
  demote, disable or delete themselves from the dashboard.

## Consequences
- `DASHBOARD_BASIC_AUTH` is removed; binding to a non-loopback `HOST` no longer needs it.
- MCP keeps its own bearer tokens and `/healthz` stays open; neither is under `/api`.
- The default password is public by design, so it is usable only to reach the "choose a new
  password" form. Operators who expose the server before the first sign-in should set
  `INITIAL_OWNER_PASSWORD`.
