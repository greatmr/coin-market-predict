import 'reflect-metadata';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NestFactory } from '@nestjs/core';

import { RedactingLogger } from './common/logging/redacting.logger.js';
import { redact } from './common/security/redact.js';

import { loadConfigOrExit } from './config/load-config.js';

import { McpService } from './modules/mcp/mcp.service.js';
import { loadSavedSettings } from './modules/settings/settings.store.js';

import { AppModule } from './app.module.js';

/** This process never runs the schedule (the web server does). */
const FORCED = { SCHEDULER_ENABLED: 'false' };

/**
 * Local MCP server over stdio for MCP hosts on this machine (e.g. Claude Code / Desktop).
 * Read-only unless started with --allow-write. stdout carries the protocol; logs go to stderr.
 */
async function main() {
  const saved = await loadSavedSettings(process.env, { attempts: 3 });
  const cfg = loadConfigOrExit({ ...process.env, ...FORCED }, saved);
  const ctx = await NestFactory.createApplicationContext(
    AppModule.forRoot(cfg, { http: false, inputs: { env: process.env, forced: FORCED } }),
    { logger: new RedactingLogger(true) },
  );
  const scope = process.argv.includes('--allow-write') ? 'write' : 'read';
  const server = ctx.get(McpService).createServer(scope);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`coins-predicts MCP (stdio, scope=${scope}) ready\n`);
  const stop = async () => {
    await server.close();
    await ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  process.stderr.write(`${redact(err instanceof Error ? err.message : String(err))}\n`);
  process.exit(1);
});
