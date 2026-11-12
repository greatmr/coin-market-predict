import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, LessThan, MoreThan } from 'typeorm';

import { redact } from '../../common/security/redact.js';

import { APP_CONFIG, type AppConfig } from '../../config/index.js';

import { ForwardReadService } from '../forward-test/forward-read.service.js';
import { ReadModelService } from '../read-model/read-model.service.js';
import { RULESET_VERSION } from '../strategy/index.js';

import { AgentDataService } from './agent-data.service.js';
import { buildSystemPrompt, buildUserPrompt } from './agent-prompt.js';
import { type AgentQuota, agentQuota } from './agent-quota.js';
import {
  AGENT_RUNNER,
  type AgentRunResult,
  type AgentRunner,
  describeAgentError,
  emptyUsage,
} from './agent-runner.js';
import { type ToolCallRecord, buildAgentTools, recordingTools } from './agent-tools.js';
import {
  AGENT_HORIZON_HOURS,
  AGENT_LOCK_KEY,
  AGENT_PROMPT_VERSION,
  AGENT_STALE_GRACE_MS,
} from './agent.constants.js';
import { type CoinAnalysis, CoinAnalysisSchema } from './agent.schemas.js';
import { AgentAnalysis } from './entities/agent-analysis.entity.js';
import { type AnalysisFacts, applyGuardrails } from './guardrails.js';

export class AgentUnavailableError extends Error {}
export class AgentNoRecordError extends Error {}
export class AgentBusyError extends Error {
  constructor(readonly running: AgentAnalysis) {
    super(`an analysis of ${running.symbol} is already running`);
  }
}
export class AgentLimitError extends Error {
  constructor(readonly quota: AgentQuota) {
    super('agent run limit reached');
  }
}

/** API view of a stored analysis (tool outputs stay in the database; only call names are shown). */
export function analysisJson(a: AgentAnalysis) {
  return {
    id: a.id,
    cmcId: a.cmcId,
    symbol: a.symbol,
    name: a.name,
    batchId: a.batchId,
    isLive: a.isLive,
    requestedBy: a.requestedBy,
    requestedAt: a.requestedAt.toISOString(),
    finishedAt: a.finishedAt?.toISOString() ?? null,
    status: a.status,
    countsTowardLimit: a.countsTowardLimit,
    model: a.model,
    fallbackModel: a.fallbackModel,
    effort: a.effort,
    promptVersion: a.promptVersion,
    rulesetVersion: a.rulesetVersion,
    outlook: a.outlook,
    confidence: a.confidence,
    output: a.output,
    guardrailNotes: a.guardrailNotes,
    toolCalls: a.toolCalls.map((c) =>
      'denied' in c
        ? { name: c.name, denied: true }
        : { name: c.name, input: c.input, ok: c.ok, at: c.at },
    ),
    usage: a.usage,
    errorKind: a.errorKind,
    errorMessage: a.errorMessage,
  };
}
export type AnalysisJson = ReturnType<typeof analysisJson>;

/**
 * The Claude coin agent (docs/adr/0005-coin-agent.md): an owner asks for one coin, the agent reads
 * that coin's stored data through read-only tools and returns its own structured view, which is
 * stored as history. At most AGENT_MAX_RUNS runs (all owners together) in any rolling
 * AGENT_WINDOW_HOURS, one at a time; the check and the start are serialized by a database lock.
 * Nothing here changes market data, scans or reviews.
 */
@Injectable()
export class AgentService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(AgentService.name);
  private inFlight: Promise<void> | null = null;
  private abort: AbortController | null = null;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
    private readonly read: ReadModelService,
    private readonly forward: ForwardReadService,
    private readonly data: AgentDataService,
  ) {}

  private repo(m: EntityManager = this.db.manager) {
    return m.getRepository(AgentAnalysis);
  }

  async onModuleInit() {
    await this.expireStale();
  }

  /** Server shutdown: stop a running analysis so it is stored as interrupted, not left RUNNING. */
  async onApplicationShutdown() {
    if (!this.inFlight) return;
    this.abort?.abort();
    await Promise.race([this.inFlight, new Promise((r) => setTimeout(r, 15_000))]);
  }

  /** Resolves when the background run (if any) has been stored. */
  idle(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  availability(): { enabled: boolean; available: boolean; reason: string | null } {
    if (!this.cfg.AGENT_ENABLED)
      return {
        enabled: false,
        available: false,
        reason: 'The agent is switched off on this server (AGENT_ENABLED=false).',
      };
    return { enabled: true, ...this.runner.availability() };
  }

  async quota(now = new Date(), m: EntityManager = this.db.manager): Promise<AgentQuota> {
    const windowMs = this.cfg.AGENT_WINDOW_HOURS * 3_600_000;
    const rows = await this.repo(m).find({
      where: { countsTowardLimit: true, requestedAt: MoreThan(new Date(now.getTime() - windowMs)) },
      select: { id: true, requestedAt: true },
    });
    return agentQuota(
      rows.map((r) => r.requestedAt),
      now,
      this.cfg.AGENT_MAX_RUNS,
      this.cfg.AGENT_WINDOW_HOURS,
    );
  }

  /** Everything the Agent tab shows for one coin: availability, the limit, a running run, history. */
  async forCoin(cmcId: number) {
    await this.expireStale();
    const [quota, rows, running] = await Promise.all([
      this.quota(),
      this.repo().find({
        where: { providerId: this.cfg.DATA_SOURCE, cmcId },
        order: { requestedAt: 'DESC' },
        take: 25,
      }),
      this.repo().findOne({ where: { status: 'RUNNING' }, order: { requestedAt: 'ASC' } }),
    ]);
    return {
      ...this.availability(),
      model: this.cfg.AGENT_MODEL,
      effort: this.cfg.AGENT_EFFORT,
      horizonHours: AGENT_HORIZON_HOURS,
      timeoutSeconds: this.cfg.AGENT_TIMEOUT_SECONDS,
      quota,
      running: running
        ? {
            id: running.id,
            cmcId: running.cmcId,
            symbol: running.symbol,
            requestedBy: running.requestedBy,
            requestedAt: running.requestedAt.toISOString(),
          }
        : null,
      analyses: rows.map(analysisJson),
    };
  }

  /**
   * Start an analysis of the coin's latest Tier 1 record and return its RUNNING row; the run
   * continues in the background (poll `forCoin`). Throws AgentUnavailableError, AgentNoRecordError,
   * AgentBusyError or AgentLimitError.
   */
  async start(cmcId: number, user: { id: string; username: string }): Promise<AnalysisJson> {
    const avail = this.availability();
    if (!avail.available)
      throw new AgentUnavailableError(avail.reason ?? 'The agent is not available.');
    const trace = await this.read.assetTrace(cmcId);
    if (!trace)
      throw new AgentNoRecordError(
        'This coin has no Tier 1 record yet, so there is nothing for the agent to read.',
      );
    const record = trace.record as Record<string, unknown>;
    const batch = trace.batch as Record<string, unknown>;
    await this.expireStale();
    const now = new Date();
    const row = await this.db.transaction(async (m) => {
      await m.query('SELECT pg_advisory_xact_lock($1)', [AGENT_LOCK_KEY]);
      const busy = await this.repo(m).findOne({
        where: { status: 'RUNNING' },
        order: { requestedAt: 'ASC' },
      });
      if (busy) throw new AgentBusyError(busy);
      const quota = await this.quota(now, m);
      if (quota.remaining <= 0) throw new AgentLimitError(quota);
      const repo = this.repo(m);
      return repo.save(
        repo.create({
          providerId: String(record.providerId),
          cmcId,
          symbol: String(record.symbol),
          name: String(record.name),
          batchId: String(batch.id),
          isLive: batch.isLive === true,
          requestedBy: user.username,
          requestedById: user.id,
          requestedAt: now,
          finishedAt: null,
          status: 'RUNNING',
          countsTowardLimit: true,
          model: this.cfg.AGENT_MODEL,
          fallbackModel: this.cfg.AGENT_FALLBACK_MODEL || null,
          effort: this.cfg.AGENT_EFFORT,
          promptVersion: AGENT_PROMPT_VERSION,
          rulesetVersion:
            typeof record.rulesetVersion === 'string' ? record.rulesetVersion : RULESET_VERSION,
          outlook: null,
          confidence: null,
          output: null,
          guardrailNotes: [],
          toolCalls: [],
          usage: null,
          errorKind: null,
          errorMessage: null,
        }),
      );
    });
    const facts: AnalysisFacts = {
      isLive: row.isLive,
      currentStatus: typeof record.currentStatus === 'string' ? record.currentStatus : null,
      batchStatus: typeof batch.status === 'string' ? batch.status : null,
    };
    const slotTime = typeof batch.slotTime === 'string' ? batch.slotTime : String(batch.slotTime);
    this.abort = new AbortController();
    this.inFlight = this.execute(row, facts, slotTime, this.abort.signal).finally(() => {
      this.inFlight = null;
      this.abort = null;
    });
    return analysisJson(row);
  }

  private async execute(
    row: AgentAnalysis,
    facts: AnalysisFacts,
    slotTime: string,
    signal: AbortSignal,
  ): Promise<void> {
    const calls: ToolCallRecord[] = [];
    let result: AgentRunResult<CoinAnalysis>;
    try {
      const tools = recordingTools(
        buildAgentTools({
          cmcId: row.cmcId,
          batchId: row.batchId,
          read: this.read,
          forward: this.forward,
          snapshots: (id, hours) => this.data.snapshots(id, hours),
        }),
        calls,
        (e) => redact(e).slice(0, 500),
      );
      result = await this.runner.run({
        model: row.model,
        fallbackModel: row.fallbackModel,
        effort: this.cfg.AGENT_EFFORT,
        maxTurns: this.cfg.AGENT_MAX_TURNS,
        maxBudgetUsd: this.cfg.AGENT_MAX_BUDGET_USD,
        timeoutMs: this.cfg.AGENT_TIMEOUT_SECONDS * 1000,
        systemPrompt: buildSystemPrompt(),
        prompt: buildUserPrompt(
          {
            cmcId: row.cmcId,
            symbol: row.symbol,
            name: row.name,
            batchId: row.batchId,
            slotTime,
            isLive: row.isLive,
          },
          new Date(),
        ),
        tools,
        outputSchema: CoinAnalysisSchema,
        signal,
      });
    } catch (err) {
      result = {
        ok: false,
        output: null,
        errorKind: 'sdk_error',
        errorMessage: redact(err).slice(0, 500),
        modelResponded: false,
        usage: emptyUsage(),
        deniedTools: [],
      };
    }
    const toolCalls = [
      ...calls,
      ...result.deniedTools.map((name) => ({ name, denied: true as const })),
    ];
    const finishedAt = new Date();
    const guarded = result.ok && result.output ? applyGuardrails(result.output, facts) : null;
    try {
      if (guarded)
        await this.repo().update(
          { id: row.id, status: 'RUNNING' },
          {
            status: 'SUCCEEDED',
            finishedAt,
            countsTowardLimit: true,
            outlook: guarded.analysis.outlook,
            confidence: guarded.analysis.confidence,
            output: guarded.analysis,
            guardrailNotes: guarded.notes,
            toolCalls,
            usage: result.usage,
          },
        );
      else {
        await this.repo().update(
          { id: row.id, status: 'RUNNING' },
          {
            status: 'FAILED',
            finishedAt,
            // A run Claude never answered (credentials, outage) does not use up the limit.
            countsTowardLimit: result.modelResponded,
            toolCalls,
            usage: result.usage,
            errorKind: result.errorKind ?? 'sdk_error',
            errorMessage: redact(
              result.errorMessage ?? describeAgentError(result.errorKind ?? 'sdk_error'),
            ).slice(0, 2000),
          },
        );
        this.log.warn(
          `agent analysis ${row.id} (${row.symbol}) failed: ${result.errorKind ?? 'sdk_error'}`,
        );
      }
    } catch (err) {
      this.log.error(`could not store agent analysis ${row.id}: ${redact(err)}`);
    }
  }

  /** Close runs left RUNNING by a restart or crash (older than the timeout plus a grace period). */
  private async expireStale(now = new Date()) {
    const cutoff = new Date(
      now.getTime() - this.cfg.AGENT_TIMEOUT_SECONDS * 1000 - AGENT_STALE_GRACE_MS,
    );
    const res = await this.repo().update(
      { status: 'RUNNING', requestedAt: LessThan(cutoff) },
      {
        status: 'FAILED',
        finishedAt: now,
        errorKind: 'interrupted',
        errorMessage: describeAgentError('interrupted'),
      },
    );
    if (res.affected) this.log.warn(`closed ${res.affected} interrupted agent analysis run(s)`);
  }
}
