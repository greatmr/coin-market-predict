import { Module } from '@nestjs/common';

import { ForwardTestModule } from '../forward-test/forward-test.module.js';
import { ReadModelModule } from '../read-model/read-model.module.js';

import { AgentDataService } from './agent-data.service.js';
import { AGENT_RUNNER } from './agent-runner.js';
import { AgentService } from './agent.service.js';
import { ClaudeAgentRunner } from './claude-runner.js';

/**
 * Claude coin agent (owner-only, on demand; docs/adr/0005-coin-agent.md). Only the web server
 * composes it (the dashboard is its only entry point); the runner is swappable for tests.
 */
@Module({
  imports: [ReadModelModule, ForwardTestModule],
  providers: [
    AgentService,
    AgentDataService,
    { provide: AGENT_RUNNER, useClass: ClaudeAgentRunner },
  ],
  exports: [AgentService],
})
export class AgentModule {}
