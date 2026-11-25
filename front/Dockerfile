# syntax=docker/dockerfile:1
# Coins Predicts dashboard image: the React build (Vite) served by an unprivileged nginx, which also
# proxies /api, /mcp and /healthz to the API container on the same origin (the default), so the
# session cookie, the write guard and the CSP need no cross-origin setup.
#   API_UPSTREAM     where nginx sends /api, /mcp, /healthz            (default http://api:3000)
#   API_BASE_URL     the API's public origin when it is NOT this origin (default empty = same origin)
#   CSP_CONNECT_SRC  extra connect-src for the CSP, i.e. that origin    (default empty)
# Build context: front/.

FROM node:24-bookworm-slim AS build
WORKDIR /front
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
# The commit the bundle is built from, shown on the Data page next to the API's (/healthz).
ARG GIT_COMMIT=unknown
ENV VITE_BUILD_COMMIT=$GIT_COMMIT
# Type-checks (strict TypeScript), then bundles into dist/.
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
ENV API_UPSTREAM=http://api:3000 \
    API_BASE_URL= \
    CSP_CONNECT_SRC=
# Rendered by the image's entrypoint (envsubst) into /etc/nginx/conf.d/default.conf at start.
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /front/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/web-healthz || exit 1
