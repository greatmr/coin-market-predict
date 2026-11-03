import { Module } from "@nestjs/common";
import { McpController } from "./mcp.controller.js";
import { McpService } from "./mcp.service.js";

@Module({ providers: [McpService], controllers: [McpController], exports: [McpService] })
export class McpModule {}
