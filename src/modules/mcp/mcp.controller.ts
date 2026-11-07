import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { redact } from '../../common/security/redact.js';

import { APP_CONFIG, type AppConfig, isLoopback } from '../../config/index.js';

import { resolveScope } from './mcp-auth.js';
import { McpService } from './mcp.service.js';

/**
 * Streamable HTTP MCP endpoint (stateless). Every request must carry a bearer token; the read
 * token grants read tools, the write token additionally grants publish_signal_report.
 */
@Controller('mcp')
export class McpController {
  constructor(
    private readonly mcp: McpService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @All()
  async handle(@Req() req: Request, @Res() res: Response) {
    if (!this.cfg.MCP_HTTP_ENABLED || (!this.cfg.MCP_READ_TOKEN && !this.cfg.MCP_WRITE_TOKEN)) {
      res
        .status(503)
        .json({ error: 'MCP over HTTP is disabled (set MCP_READ_TOKEN and/or MCP_WRITE_TOKEN)' });
      return;
    }
    const scope = resolveScope(req.headers.authorization, {
      read: this.cfg.MCP_READ_TOKEN,
      write: this.cfg.MCP_WRITE_TOKEN,
    });
    if (!scope) {
      res
        .status(401)
        .setHeader('WWW-Authenticate', 'Bearer')
        .json({ error: 'missing or invalid bearer token' });
      return;
    }
    const server = this.mcp.createServer(scope);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      ...(isLoopback(this.cfg.HOST)
        ? {
            enableDnsRebindingProtection: true,
            allowedHosts: [
              `127.0.0.1:${this.cfg.PORT}`,
              `localhost:${this.cfg.PORT}`,
              `[::1]:${this.cfg.PORT}`,
            ],
          }
        : {}),
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent)
        res.status(500).json({ error: redact(err instanceof Error ? err.message : err) });
    }
  }
}
