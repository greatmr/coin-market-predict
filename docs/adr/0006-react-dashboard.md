# ADR-0006: The dashboard is a separate React + TypeScript app talking REST to the API

- Status: accepted
- Date: 2026-11-15 (first version 2026-11-14: React in `front/`, served by the API)

## Context
The dashboard was one hand-written script (`public/app.js`, about 5,700 lines) served by NestJS
from `public/`. A first port to React (2026-11-14) kept that serving model, hash URLs (`#queue`)
and plain JavaScript, and showed the coin details in an overlay drawer that also hosted the heavy
TradingView iframe. The operator then asked for the front end and the back end to be deployed
separately (one container each, REST between them, ready for another host or subdomain), real URLs
with path and query parameters, TypeScript, and a fix for UI glitches around the live chart.

## Decision
- **Two deployables.** The NestJS app (repo root, `Dockerfile`) is API-only: REST under `/api`,
  MCP under `/mcp`, `/healthz`, the scheduler, the Telegram bot and the CLI. It no longer serves
  files. The dashboard (`front/`, `front/Dockerfile`) is a static React build served by an
  unprivileged nginx.
- **Same origin by default.** The web container serves the pages and proxies `/api`, `/mcp` and
  `/healthz` to the API container on the private Docker network, so the session cookie
  (HttpOnly, SameSite=Strict), the same-origin write guard and the CSP need no cross-origin setup,
  and the host's reverse proxy keeps one upstream. Optionally the API runs on its own subdomain
  (`deploy/docker-compose.api-subdomain.yml`): the web container's `API_BASE_URL` points the app
  at it (read at start from `/app-config.json`, so the same image serves both modes),
  `CSP_CONNECT_SRC` allows it, and the API's `CORS_ORIGINS` allows the dashboard origin with
  credentials; its writes pass the write guard. A subdomain of the same site keeps the
  SameSite=Strict cookie working.
- **Authentication unchanged.** Every `/api` route needs a session and the route's permission
  (`AuthGuard`), writes must be JSON from a trusted origin; the dashboard sends the cookie
  (`credentials: 'include'`). Export downloads are plain links to the API.
- **React 19 + TypeScript (strict) + Vite**, its own package. `npm run build` type-checks, then
  bundles. Layout: `src/lib/` (API client, runtime config, formatting, status vocabularies, routes,
  toast / tooltip / dialog stores), `src/state/` (session, signed-in app state), `src/components/`
  (tables, status chips, chart primitives, error boundaries), `src/types/api.ts` (shared payloads),
  `src/features/<section>/` (one folder per page, with its own `types.ts`).
- **React Router, browser history.** Pages are paths (`/queue`, `/forward`, `/runs`, …), list state
  is in the query string (`?q=…&page=2&rows=250&view=scatter`, `?view=final&stars=3`), a coin is
  a page (`/coins/:cmcId?tab=history&batch=…`), sign-in is `/login?next=…`. Old `#section` and
  `?coin=` links redirect. nginx (and the Vite dev server) answer every unknown path with
  `index.html`. Each route has an error element and each heavy panel an error boundary, so one
  failure never blanks the app.
- **Coin page instead of the drawer.** The TradingView chart is the advanced-chart widget only, in
  a fixed-size, isolated container (`contain: strict`, no backdrop blur), keyed by symbol so it
  does not reload when the page re-renders; the `symbol-info` strip (an oversized title with
  TradingView's floating badge, resized by TradingView's messages) is gone. It stays a sandboxed
  cross-origin iframe; CSP `frame-src` lists only the widget origin.
- **CSP** is sent by the web container with the pages (`front/nginx/`): scripts, styles and fonts
  from the same origin only, CMC logos as images, TradingView only as a frame. The API sends a
  `default-src 'none'` policy with its JSON and files. Untrusted text is rendered as React text,
  never with `dangerouslySetInnerHTML`; charts are hand-drawn SVG.
- **Typography**: Inter (variable weight and optical size), self-hosted from
  `@fontsource-variable/inter`. Tabular figures for data, proportional figures in prose; tickers
  and ids use Inter's unambiguous l / I / slashed-zero alternates.

## Consequences
- Locally: `npm start` runs the API on :3000 (no pages); `npm run front:dev` serves the dashboard
  with hot reload on :5173 and proxies `/api` to it. In Docker: `docker compose --profile app up`
  starts `api` and `web` (dashboard on :8080).
- Production runs `api` and `web` (`deploy/docker-compose.prod.yml`); the host's reverse proxy
  points at `web` as before. The first update from the single-container layout needs
  `--remove-orphans` so the old `app` container releases the port.
- Behind two proxies (host → web → api) the API trusts `loopback, uniquelocal` (`TRUST_PROXY`, set
  in the compose files) for client IPs and HTTPS detection.
- Root ESLint covers the API only; the dashboard is checked by `tsc` (`npm run front:typecheck`) and
  formatted by Prettier through an override in `.prettierrc` (`npm run front:format`).
