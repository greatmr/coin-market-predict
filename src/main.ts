import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { loadConfigOrExit, RedactingLogger } from "./bootstrap.js";
import { describeConfig } from "./config/config.js";
import { basicAuth, securityHeaders } from "./dashboard/basic-auth.js";

async function main() {
  const cfg = loadConfigOrExit();
  const logger = new RedactingLogger();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg), { logger, bufferLogs: true });
  app.useLogger(logger);
  app.disable("x-powered-by");
  app.use(securityHeaders);
  // Liveness only (no data), so container health checks work behind dashboard auth.
  app.use("/healthz", (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ ok: true }));
  app.use(basicAuth(cfg.DASHBOARD_BASIC_AUTH));
  app.useStaticAssets(resolve(process.env.COINS_PUBLIC_DIR ?? "public"), { index: "index.html" });
  app.enableShutdownHooks();
  await app.listen(cfg.PORT, cfg.HOST);
  const d = describeConfig(cfg);
  logger.log(
    `Coins Predicts on http://${cfg.HOST}:${cfg.PORT} — data=${d.DATA_SOURCE}${cfg.DATA_SOURCE === "fixture" ? " (SYNTHETIC)" : ""}, agents=${d.AGENT_PROVIDER}, telegram=${d.TELEGRAM_MODE}, token=${d.CLAUDE_CODE_OAUTH_TOKEN}`,
    "Bootstrap",
  );
}

void main();
