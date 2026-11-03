import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { loadConfigOrExit, RedactingLogger } from "./bootstrap.js";
import { McpService } from "./mcp/mcp.service.js";

/**
 * Local MCP server over stdio for MCP hosts on this machine (e.g. Claude Code / Desktop).
 * Read-only unless started with --allow-write. stdout carries the protocol; logs go to stderr.
 */
async function main() {
  const cfg = loadConfigOrExit({ ...process.env, SCHEDULER_ENABLED: "false" });
  const ctx = await NestFactory.createApplicationContext(AppModule.forRoot(cfg, { http: false }), { logger: new RedactingLogger(true) });
  const scope = process.argv.includes("--allow-write") ? "write" : "read";
  const server = ctx.get(McpService).createServer(scope);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`coins-predicts MCP (stdio, scope=${scope}) ready\n`);
  const stop = async () => {
    await server.close();
    await ctx.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();
