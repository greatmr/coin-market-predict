# syntax=docker/dockerfile:1
# Coins Predicts application image. Secrets are NEVER copied into the image: they are read at
# runtime from environment variables or mounted files (*_FILE), see docker-compose.yml.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json ./
COPY src ./src
# prisma generate needs no database, but prisma.config.ts resolves DATABASE_URL: use a placeholder.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate \
    && npx tsc -p tsconfig.build.json && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    COINS_RUNTIME_DIR=/app/runtime \
    COINS_PUBLIC_DIR=/app/public \
    COINS_STATE_DIR=/app/var/agent
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json prisma.config.ts ./
COPY --chown=node:node prisma ./prisma
# Production runtime instructions and skills the Agent SDK loads explicitly.
COPY --chown=node:node runtime ./runtime
COPY --chown=node:node public ./public
COPY --chown=node:node docker/entrypoint.sh ./docker/entrypoint.sh
RUN mkdir -p /app/var/agent && chown -R node:node /app/var && chmod 0755 /app/docker/entrypoint.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["node", "dist/main.js"]
