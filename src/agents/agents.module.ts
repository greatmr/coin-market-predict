import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/config.js";
import { AnalysisService } from "./analysis.service.js";
import { ClaudeAgentRunner } from "./claude-runner.js";
import { FixtureAgentRunner } from "./fixture-runner.js";
import { AGENT_RUNNER, type AgentRunner } from "./runner.js";

export function createRunner(cfg: AppConfig): AgentRunner {
  // "off" still needs a runner object; AnalysisService short-circuits before calling it.
  return cfg.AGENT_PROVIDER === "claude" ? new ClaudeAgentRunner(cfg) : new FixtureAgentRunner();
}

@Module({
  providers: [{ provide: AGENT_RUNNER, inject: [APP_CONFIG], useFactory: createRunner }, AnalysisService],
  exports: [AGENT_RUNNER, AnalysisService],
})
export class AgentsModule {}
