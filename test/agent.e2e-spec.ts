import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, type Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import {
  AGENT_RUNNER,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
  emptyUsage,
} from '../src/modules/agent/agent-runner.js';
import { type ToolCallRecord } from '../src/modules/agent/agent-tools.js';
import { AgentModule } from '../src/modules/agent/agent.module.js';
import type { CoinAnalysis } from '../src/modules/agent/agent.schemas.js';
import {
  AgentBusyError,
  AgentLimitError,
  AgentNoRecordError,
  AgentService,
  AgentUnavailableError,
} from '../src/modules/agent/agent.service.js';
import { AgentAnalysis } from '../src/modules/agent/entities/agent-analysis.entity.js';
import { AppUser } from '../src/modules/auth/entities/app-user.entity.js';
import { UsersService } from '../src/modules/auth/users.service.js';
import { invokeTool } from '../src/modules/mcp/tool-def.js';
import { PipelineService } from '../src/modules/pipeline/pipeline.service.js';
import { ScanResult } from '../src/modules/scan/entities/scan-result.entity.js';

import { resetDb, testConfig } from './utils/helpers.js';

const ANSWER: CoinAnalysis = {
  outlook: 'PUMP_POSSIBLE',
  confidence: 'HIGH',
  headline: 'Volume is rising from a low base while the price is flat.',
  mindset: 'The 3-day window passes.\n\nThe data is synthetic, so I would not act on it.',
  strategyFit: 'Eligible with one star.',
  bullishFactors: [
    { point: 'Current VMC above its 3-day mean', evidence: 'windows[0].result = YES' },
  ],
  bearishFactors: [],
  risks: ['Synthetic data.'],
  dataGaps: ['No BTC or ETH observations in the fixture.'],
  watchNext: ['The next daily close.'],
  candleState: 'UNCERTAIN',
  marketRegime: 'UNCERTAIN',
};

const answered = (): AgentRunResult<unknown> => ({
  ok: true,
  output: ANSWER,
  errorKind: null,
  errorMessage: null,
  modelResponded: true,
  usage: { ...emptyUsage(), outputTokens: 800, models: ['claude-opus-5-5'] },
  deniedTools: ['Bash'],
});

/** Stands in for Claude: calls every tool the way the agent would, then answers. */
class FakeRunner implements AgentRunner {
  available = true;
  requests: Array<AgentRunRequest<unknown>> = [];
  behaviour: (req: AgentRunRequest<unknown>) => Promise<AgentRunResult<unknown>> = async (req) => {
    for (const t of req.tools)
      await invokeTool(t, t.name === 'get_price_history' ? { hours: 48 } : {});
    return answered();
  };
  availability() {
    return this.available
      ? { available: true, reason: null }
      : { available: false, reason: 'CLAUDE_CODE_OAUTH_TOKEN is not set.' };
  }
  run<T>(req: AgentRunRequest<T>): Promise<AgentRunResult<T>> {
    this.requests.push(req as AgentRunRequest<unknown>);
    return this.behaviour(req as AgentRunRequest<unknown>) as Promise<AgentRunResult<T>>;
  }
}

let app: TestingModule;
let db: DataSource;
let agent: AgentService;
let analyses: Repository<AgentAnalysis>;
let runner: FakeRunner;
let coin: ScanResult;
let owner: { id: string; username: string };

beforeAll(async () => {
  runner = new FakeRunner();
  app = await Test.createTestingModule({
    imports: [AppModule.forRoot(testConfig({ AGENT_MAX_RUNS: '3' }), { http: false }), AgentModule],
  })
    .overrideProvider(AGENT_RUNNER)
    .useValue(runner)
    .compile();
  app.useLogger(false);
  await app.init();
  db = app.get(DataSource);
  await resetDb(db);
  await app.get(PipelineService).runSlot();
  coin = await db
    .getRepository(ScanResult)
    .findOneOrFail({ where: { eligibilityStatus: 'ELIGIBLE' }, order: { cmcId: 'ASC' } });
  agent = app.get(AgentService);
  analyses = db.getRepository(AgentAnalysis);
});
afterAll(async () => app.close());

beforeEach(async () => {
  await db.query('DELETE FROM agent_analysis');
  await db.query('DELETE FROM user_session');
  await db.query('DELETE FROM app_user');
  const u = await app
    .get(UsersService)
    .create({ username: 'boss', role: 'owner', password: 'owner-pass-1' }, { temporary: false });
  owner = { id: u.id, username: u.username };
  runner.available = true;
  runner.requests = [];
  runner.behaviour = new FakeRunner().behaviour;
});

/** A finished run inserted directly (history from before the test); returns its request time. */
async function pastRun(hoursAgo: number, countsTowardLimit = true): Promise<Date> {
  const requestedAt = new Date(Date.now() - hoursAgo * 3_600_000);
  await analyses.insert({
    providerId: coin.providerId,
    cmcId: coin.cmcId,
    symbol: coin.symbol,
    name: coin.name,
    batchId: coin.batchId,
    isLive: false,
    requestedBy: 'earlier-owner',
    requestedById: null,
    requestedAt,
    finishedAt: new Date(requestedAt.getTime() + 60_000),
    status: 'FAILED',
    countsTowardLimit,
    model: 'claude-opus-5-5',
    fallbackModel: null,
    effort: 'high',
    promptVersion: 'coin-agent-1',
    rulesetVersion: coin.rulesetVersion,
    outlook: null,
    confidence: null,
    output: null,
    guardrailNotes: [],
    toolCalls: [],
    usage: null,
    errorKind: 'timeout',
    errorMessage: 'timed out',
  });
  return requestedAt;
}

describe('Claude coin agent', () => {
  it('reads the coin through its read-only tools and stores the guarded view with every tool call', async () => {
    const started = await agent.start(coin.cmcId, owner);
    expect(started).toMatchObject({ status: 'RUNNING', cmcId: coin.cmcId, requestedBy: 'boss' });
    await agent.idle();

    const row = await analyses.findOneByOrFail({ id: started.id });
    expect(row).toMatchObject({
      status: 'SUCCEEDED',
      outlook: 'PUMP_POSSIBLE',
      // Fixture data: the guardrail caps the agent's HIGH confidence.
      confidence: 'LOW',
      countsTowardLimit: true,
      batchId: coin.batchId,
      isLive: false,
      requestedBy: 'boss',
      requestedById: owner.id,
      model: 'claude-opus-5-5',
    });
    expect(row.finishedAt).not.toBeNull();
    expect(row.guardrailNotes[0]).toMatch(/synthetic fixture/);
    expect(row.output?.headline).toBe(ANSWER.headline);

    const calls = row.toolCalls.filter((c): c is ToolCallRecord => !('denied' in c));
    expect(calls.map((c) => c.name)).toEqual([
      'get_coin_trace',
      'get_price_history',
      'get_market_regime',
      'get_forward_test_context',
    ]);
    expect(calls.every((c) => c.ok)).toBe(true);
    const trace = calls[0]!.output as {
      coin: { cmcId: number };
      dataSource: { isLiveData: boolean };
    };
    expect([trace.coin.cmcId, trace.dataSource.isLiveData]).toEqual([coin.cmcId, false]);
    expect((calls[1]!.output as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
    expect(row.toolCalls).toContainEqual({ name: 'Bash', denied: true });

    const req = runner.requests[0]!;
    expect(req.prompt).toContain(`"cmcId":${coin.cmcId}`);
    expect(req.prompt).toContain('SYNTHETIC fixture data');
    expect([req.model, req.fallbackModel, req.effort]).toEqual([
      'claude-opus-5-5',
      'claude-opus-4-8',
      'high',
    ]);

    const view = await agent.forCoin(coin.cmcId);
    expect(view.analyses[0]).toMatchObject({ id: started.id, status: 'SUCCEEDED' });
    // Tool outputs stay in the database; the API lists only the calls.
    expect(JSON.stringify(view.analyses[0]!.toolCalls)).not.toContain('"output"');
  });

  it('allows at most AGENT_MAX_RUNS runs in any rolling window, all owners together', async () => {
    await pastRun(13); // outside the 12 h window
    const inside = await pastRun(2); // inside: counts
    await pastRun(1, false); // failed before Claude answered: does not count
    expect((await agent.quota()).used).toBe(1);

    await agent.start(coin.cmcId, owner);
    await agent.idle();
    await agent.start(coin.cmcId, owner);
    await agent.idle();
    const q = await agent.quota();
    expect([q.used, q.remaining]).toEqual([3, 0]);

    const refused = await agent.start(coin.cmcId, owner).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AgentLimitError);
    // The oldest counted run in the window (2 h ago) frees the next slot 12 h after it started.
    expect((refused as AgentLimitError).quota.nextFreeAt).toBe(
      new Date(inside.getTime() + 12 * 3_600_000).toISOString(),
    );
    expect(await analyses.count()).toBe(5);
    expect(runner.requests).toHaveLength(2);
  });

  it('does not count a run that Claude never answered (credentials, outage)', async () => {
    runner.behaviour = async () => ({
      ok: false,
      output: null,
      errorKind: 'authentication_failed',
      errorMessage: 'Claude rejected CLAUDE_CODE_OAUTH_TOKEN.',
      modelResponded: false,
      usage: emptyUsage(),
      deniedTools: [],
    });
    const started = await agent.start(coin.cmcId, owner);
    await agent.idle();
    expect(await analyses.findOneByOrFail({ id: started.id })).toMatchObject({
      status: 'FAILED',
      errorKind: 'authentication_failed',
      countsTowardLimit: false,
      output: null,
    });
    expect((await agent.quota()).used).toBe(0);
  });

  it('runs one analysis at a time', async () => {
    let release: () => void = () => undefined;
    runner.behaviour = () =>
      new Promise((resolve) => {
        release = () => resolve(answered());
      });
    const first = await agent.start(coin.cmcId, owner);
    await expect(agent.start(coin.cmcId, owner)).rejects.toBeInstanceOf(AgentBusyError);
    expect((await agent.forCoin(coin.cmcId)).running).toMatchObject({ id: first.id });
    release();
    await agent.idle();
    expect((await analyses.findOneByOrFail({ id: first.id })).status).toBe('SUCCEEDED');
  });

  it('refuses without credentials or without a Tier 1 record, and stores nothing', async () => {
    runner.available = false;
    await expect(agent.start(coin.cmcId, owner)).rejects.toBeInstanceOf(AgentUnavailableError);
    runner.available = true;
    await expect(agent.start(1_999_999_999, owner)).rejects.toBeInstanceOf(AgentNoRecordError);
    expect(await analyses.count()).toBe(0);
    expect(runner.requests).toHaveLength(0);
  });

  it('keeps a finished analysis immutable, and keeps the username when the account is deleted', async () => {
    const started = await agent.start(coin.cmcId, owner);
    await agent.idle();
    await expect(analyses.update({ id: started.id }, { outlook: 'PUMP_LIKELY' })).rejects.toThrow(
      /immutable/,
    );
    await db.getRepository(AppUser).delete({ id: owner.id });
    expect(await analyses.findOneByOrFail({ id: started.id })).toMatchObject({
      requestedById: null,
      requestedBy: 'boss',
      outlook: 'PUMP_POSSIBLE',
    });
  });

  it('closes a run left RUNNING by a restart, but a recent one still blocks new runs', async () => {
    const base = {
      providerId: coin.providerId,
      cmcId: coin.cmcId,
      symbol: coin.symbol,
      name: coin.name,
      batchId: coin.batchId,
      isLive: false,
      requestedBy: 'boss',
      requestedById: owner.id,
      finishedAt: null,
      status: 'RUNNING' as const,
      model: 'claude-opus-5-5',
      fallbackModel: null,
      effort: 'high',
      promptVersion: 'coin-agent-1',
      rulesetVersion: coin.rulesetVersion,
      outlook: null,
      confidence: null,
      output: null,
      guardrailNotes: [],
      toolCalls: [],
      usage: null,
      errorKind: null,
      errorMessage: null,
    };
    const lost = await analyses.save(
      analyses.create({ ...base, requestedAt: new Date(Date.now() - 8 * 60_000) }),
    );
    await agent.forCoin(coin.cmcId);
    expect(await analyses.findOneByOrFail({ id: lost.id })).toMatchObject({
      status: 'FAILED',
      errorKind: 'interrupted',
      countsTowardLimit: true,
    });

    await analyses.save(analyses.create({ ...base, requestedAt: new Date(Date.now() - 10_000) }));
    await expect(agent.start(coin.cmcId, owner)).rejects.toBeInstanceOf(AgentBusyError);
  });
});
