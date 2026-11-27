import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { redact } from '../../../common/security/redact.js';

import { APP_CONFIG, type AppConfig } from '../../../config/index.js';

import { ObservationReadService } from '../../lbank-observation/observation-read.service.js';
import { McpService } from '../../mcp/mcp.service.js';
import { AgentDataService } from '../agent-data.service.js';
import { AGENT_RUNNER, type AgentRunner, describeAgentError } from '../agent-runner.js';
import { ChatConversation } from '../entities/chat-conversation.entity.js';
import { ChatMessage } from '../entities/chat-message.entity.js';

import { type ChatQuota, chatQuota } from './chat-limit.js';
import {
  type ChatTurn,
  buildChatPrompt,
  buildChatSystemPrompt,
  strategyFingerprint,
  strategyVersions,
} from './chat-prompt.js';
import { type ChatToolCall, buildChatTools, recordChatCalls } from './chat-tools.js';
import {
  CHAT_LOCK_KEY,
  CHAT_MODELS,
  CHAT_PROMPT_VERSION,
  CHAT_STALE_GRACE_MS,
  type ChatEffort,
  chatModelHasEffort,
} from './chat.constants.js';

export class ChatUnavailableError extends Error {}
export class ChatNotFoundError extends Error {}
export class ChatBusyError extends Error {}
export class ChatLimitError extends Error {
  constructor(readonly quota: ChatQuota) {
    super('chat message limit reached');
  }
}

export interface ChatUser {
  id: string;
  username: string;
}

const messageJson = (m: ChatMessage) => ({
  id: m.id,
  seq: m.seq,
  role: m.role,
  status: m.status,
  content: m.content,
  model: m.model,
  effort: m.effort,
  strategyVersion: m.strategyVersion,
  countsTowardLimit: m.countsTowardLimit,
  toolCalls: m.toolCalls.map((c) => ({ name: c.name, ok: c.ok })),
  errorKind: m.errorKind,
  errorMessage: m.errorMessage,
  createdAt: m.createdAt.toISOString(),
  finishedAt: m.finishedAt?.toISOString() ?? null,
});
export type ChatMessageJson = ReturnType<typeof messageJson>;

/**
 * The Claude chat (docs/adr/0012-owner-chat.md): an owner-only conversation with the analyst desk.
 * Strictly read-only towards the panel: the desk gets read tools only (`buildChatTools`) and this
 * service writes nothing but its own conversation rows. At most CHAT_MAX_MESSAGES user messages per
 * conversation; one reply at a time; the reply runs in the background and the page polls.
 */
@Injectable()
export class ChatService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(ChatService.name);
  private inFlight: Promise<void> | null = null;
  private abort: AbortController | null = null;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
    private readonly mcp: McpService,
    private readonly data: AgentDataService,
    private readonly observation: ObservationReadService,
  ) {}

  async onModuleInit() {
    await this.expireStale();
  }

  async onApplicationShutdown() {
    if (!this.inFlight) return;
    this.abort?.abort();
    await Promise.race([this.inFlight, new Promise((r) => setTimeout(r, 15_000))]);
  }

  idle(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  availability(): { enabled: boolean; available: boolean; reason: string | null } {
    if (!this.cfg.AGENT_ENABLED)
      return {
        enabled: false,
        available: false,
        reason: 'The Claude agent is switched off on this server (AGENT_ENABLED=false).',
      };
    return { enabled: true, ...this.runner.availability() };
  }

  /** Models, efforts, the limit and the strategy the desk currently knows. */
  status() {
    return {
      ...this.availability(),
      models: CHAT_MODELS,
      defaultModel: CHAT_MODELS.some((m) => m.id === this.cfg.AGENT_MODEL)
        ? this.cfg.AGENT_MODEL
        : CHAT_MODELS[0].id,
      defaultEffort: this.cfg.AGENT_EFFORT,
      maxMessages: this.cfg.CHAT_MAX_MESSAGES,
      promptVersion: CHAT_PROMPT_VERSION,
      strategy: { fingerprint: strategyFingerprint(), versions: strategyVersions() },
    };
  }

  private repo<T extends object>(e: new () => T, m: EntityManager = this.db.manager) {
    return m.getRepository(e);
  }

  async list(user: ChatUser) {
    const rows = (await this.db.query(
      `SELECT c.id, c.title, c.updated_at, c.strategy_version,
              count(m.id) FILTER (WHERE m.role = 'user' AND m.counts_toward_limit)::int AS used
         FROM chat_conversation c LEFT JOIN chat_message m ON m.conversation_id = c.id
        WHERE c.owner_id = $1
        GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 50`,
      [user.id],
    )) as Array<{
      id: string;
      title: string;
      updated_at: Date;
      strategy_version: string;
      used: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.updated_at.toISOString(),
      quota: chatQuota(r.used, this.cfg.CHAT_MAX_MESSAGES),
    }));
  }

  async get(id: string, user: ChatUser, m: EntityManager = this.db.manager) {
    const conv = await this.repo(ChatConversation, m).findOne({ where: { id, ownerId: user.id } });
    if (!conv) throw new ChatNotFoundError('conversation not found');
    const messages = await this.repo(ChatMessage, m).find({
      where: { conversationId: id },
      order: { seq: 'ASC' },
    });
    const used = messages.filter((x) => x.role === 'user' && x.countsTowardLimit).length;
    const current = strategyFingerprint();
    return {
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
      strategyVersion: conv.strategyVersion,
      currentStrategyVersion: current,
      strategyChanged: conv.strategyVersion !== current,
      quota: chatQuota(used, this.cfg.CHAT_MAX_MESSAGES),
      running: messages.some((x) => x.status === 'RUNNING'),
      messages: messages.map(messageJson),
    };
  }

  /** Store the owner's message and start the desk's reply in the background. */
  async send(
    input: { conversationId?: string; message: string; model: string; effort: ChatEffort },
    user: ChatUser,
  ) {
    const avail = this.availability();
    if (!avail.available) throw new ChatUnavailableError(avail.reason ?? 'chat unavailable');
    const now = new Date();
    const started = await this.db.transaction(async (m) => {
      await m.query('SELECT pg_advisory_xact_lock($1)', [CHAT_LOCK_KEY]);
      const running = await this.repo(ChatMessage, m).count({ where: { status: 'RUNNING' } });
      if (running > 0) throw new ChatBusyError('a reply is already being written');
      let conv: ChatConversation;
      if (input.conversationId) {
        const found = await this.repo(ChatConversation, m).findOne({
          where: { id: input.conversationId, ownerId: user.id },
        });
        if (!found) throw new ChatNotFoundError('conversation not found');
        conv = found;
      } else {
        conv = await this.repo(ChatConversation, m).save(
          this.repo(ChatConversation, m).create({
            ownerId: user.id,
            ownerName: user.username,
            title: input.message.replace(/\s+/g, ' ').slice(0, 60),
            strategyVersion: strategyFingerprint(),
            createdAt: now,
            updatedAt: now,
          }),
        );
      }
      const prior = await this.repo(ChatMessage, m).find({
        where: { conversationId: conv.id },
        order: { seq: 'ASC' },
      });
      const used = prior.filter((x) => x.role === 'user' && x.countsTowardLimit).length;
      const quota = chatQuota(used, this.cfg.CHAT_MAX_MESSAGES);
      if (quota.remaining <= 0) throw new ChatLimitError(quota);
      const seq = (prior.at(-1)?.seq ?? 0) + 1;
      const base = {
        conversationId: conv.id,
        model: input.model,
        effort: input.effort,
        createdAt: now,
      };
      await this.repo(ChatMessage, m).save([
        this.repo(ChatMessage, m).create({
          ...base,
          seq,
          role: 'user',
          status: 'DONE',
          content: input.message,
          finishedAt: now,
          toolCalls: [],
        }),
      ]);
      const reply = await this.repo(ChatMessage, m).save(
        this.repo(ChatMessage, m).create({
          ...base,
          seq: seq + 1,
          role: 'assistant',
          status: 'RUNNING',
          content: '',
          promptVersion: CHAT_PROMPT_VERSION,
          strategyVersion: strategyFingerprint(),
          toolCalls: [],
        }),
      );
      await this.repo(ChatConversation, m).update({ id: conv.id }, { updatedAt: now });
      return {
        conv,
        replyId: reply.id,
        userSeq: seq,
        history: pairTurns(prior),
      };
    });

    this.inFlight = this.reply(started, input).finally(() => {
      this.inFlight = null;
      this.abort = null;
    });
    return this.get(started.conv.id, user);
  }

  private async reply(
    s: { conv: ChatConversation; replyId: string; userSeq: number; history: ChatTurn[] },
    input: { message: string; model: string; effort: ChatEffort },
  ) {
    this.abort = new AbortController();
    const calls: ChatToolCall[] = [];
    let result: Awaited<ReturnType<AgentRunner['chat']>>;
    try {
      const tools = recordChatCalls(
        buildChatTools({ mcp: this.mcp, data: this.data, observation: this.observation }),
        calls,
      );
      const changedFrom =
        s.conv.strategyVersion !== strategyFingerprint() ? s.conv.strategyVersion : null;
      result = await this.runner.chat({
        model: input.model,
        ...(chatModelHasEffort(input.model) ? { effort: input.effort } : {}),
        maxTurns: this.cfg.AGENT_MAX_TURNS,
        maxBudgetUsd: this.cfg.AGENT_MAX_BUDGET_USD,
        timeoutMs: this.cfg.AGENT_TIMEOUT_SECONDS * 1000,
        systemPrompt: buildChatSystemPrompt({ changedFrom }),
        prompt: buildChatPrompt(s.history, input.message, new Date()),
        tools,
        signal: this.abort.signal,
      });
    } catch (err) {
      this.log.error(`chat reply failed: ${redact(err)}`);
      result = {
        ok: false,
        text: null,
        errorKind: 'sdk_error',
        errorMessage: describeAgentError('sdk_error'),
        modelResponded: false,
        usage: { ...emptyUsageLike() },
        deniedTools: [],
      };
    }
    const finished = new Date();
    await this.db.transaction(async (m) => {
      await this.repo(ChatMessage, m).update(
        { id: s.replyId },
        {
          status: result.ok ? 'DONE' : 'FAILED',
          content: result.ok ? (result.text ?? '') : '',
          toolCalls: [
            ...calls,
            ...result.deniedTools.map((name) => ({ name, input: null, at: '', ok: false })),
          ] as never,
          usage: result.usage,
          errorKind: result.errorKind,
          errorMessage: result.ok ? null : result.errorMessage,
          finishedAt: finished,
        },
      );
      // A failure before Claude answered does not use up one of the owner's messages.
      if (!result.ok && !result.modelResponded)
        await this.repo(ChatMessage, m).update(
          { conversationId: s.conv.id, seq: s.userSeq },
          { countsTowardLimit: false },
        );
      await this.repo(ChatConversation, m).update({ id: s.conv.id }, { updatedAt: finished });
    });
  }

  /** Replies left RUNNING by a crash or restart are closed as interrupted. */
  private async expireStale() {
    const cutoff = new Date(
      Date.now() - (this.cfg.AGENT_TIMEOUT_SECONDS * 1000 + CHAT_STALE_GRACE_MS),
    );
    const stale = await this.db
      .getRepository(ChatMessage)
      .createQueryBuilder('m')
      .where(`m.status = 'RUNNING' AND m.created_at < :cutoff`, { cutoff })
      .getMany();
    for (const r of stale) {
      await this.db.getRepository(ChatMessage).update(
        { id: r.id },
        {
          status: 'FAILED',
          errorKind: 'interrupted',
          errorMessage: describeAgentError('interrupted'),
          finishedAt: new Date(),
        },
      );
      await this.db
        .getRepository(ChatMessage)
        .update({ conversationId: r.conversationId, seq: r.seq - 1 }, { countsTowardLimit: false });
    }
  }
}

const emptyUsageLike = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: null,
  numTurns: null,
  durationMs: 0,
  durationApiMs: null,
  models: [] as string[],
  refusalFallback: false,
  sessionId: null,
});

/** Completed (user, desk) pairs of a conversation, oldest first; failed replies are left out. */
export function pairTurns(messages: readonly ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const bySeq = new Map(messages.map((m) => [m.seq, m]));
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const reply = bySeq.get(m.seq + 1);
    if (reply && reply.role === 'assistant' && reply.status === 'DONE')
      turns.push(
        { role: 'user', content: m.content },
        { role: 'assistant', content: reply.content },
      );
  }
  return turns;
}
