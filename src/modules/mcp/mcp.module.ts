import { Module } from '@nestjs/common';

import { ReadModelModule } from '../read-model/read-model.module.js';

import { McpController } from './mcp.controller.js';
import { McpService } from './mcp.service.js';

/** Read-only MCP tools over Streamable HTTP (`/mcp`, bearer tokens) and stdio (`src/mcp-stdio.ts`). */
@Module({
  imports: [ReadModelModule],
  providers: [McpService],
  controllers: [McpController],
  exports: [McpService],
})
export class McpModule {}
