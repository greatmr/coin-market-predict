import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import {
  AGENT_RUNNER,
  type AgentChatRequest,
  type AgentChatResult,
  type AgentRunner,
  emptyUsage,
} from '../src/modules/agent/agent-runner.js';
import { AgentModule } from '../src/modules/agent/agent.module.js';
import {
  ChatBusyError,
  ChatLimitError,
  ChatService,
} from '../src/modules/agent/chat/chat.service.js';
import { UsersService } from '../src/modules/auth/users.service.js';
import { invokeTool } from '../src/modules/mcp/tool-def.js';

import { resetDb, testConfig } from './utils/helpers.js';

class FakeRunner implements AgentRunner {
  requests: AgentChatRequest[] = [];
  fail = false;
  gate: Promise<void> | null = null;
  availability() {
    return { available: true, reason: null };
  }
  run(): Promise<never> {
    throw new Error('not used');
  }
  async chat(req: AgentChatRequest): Promise<AgentChatResult> {
    this.requests.push(req);
    if (this.gate) await this.gate;
    // Every tool the desk is given must be callable and read-only.
    for (const t of req.tools) expect(t.scope).toBe('read');
    if (this.fail)
      return {
        ok: false,
        text: null,
        errorKind: 'overloaded',
        errorMessage: 'busy',
        modelResponded: false,
        usage: emptyUsage(),
        deniedTools: [],
      };
    const t = req.tools.find((x) => x.name === 'get_strategy')!;
    await invokeTool(t, {});
    return {
      ok: true,
      text: 'Answer.',
      errorKind: null,
      errorMessage: null,
      modelResponded: true,
      usage: emptyUsage(),
      deniedTools: [],
    };
  }
}

let app: TestingModule;
let db: DataSource;
let chat: ChatService;
let runner: FakeRunner;
let owner: { id: string; username: string };

beforeAll(async () => {
  runner = new FakeRunner();
  app = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(testConfig({ CHAT_MAX_MESSAGES: '3' }), { http: false }),
      AgentModule,
    ],
  })
    .overrideProvider(AGENT_RUNNER)
    .useValue(runner)
    .compile();
  app.useLogger(false);
  await app.init();
  db = app.get(DataSource);
  await resetDb(db);
  chat = app.get(ChatService);
  const u = await app
    .get(UsersService)
    .create({ username: 'chatowner', password: 'Correct-Horse-9-Battery', role: 'owner' });
  owner = { id: u.id, username: 'chatowner' };
});
afterAll(async () => app.close());
beforeEach(async () => {
  runner.requests = [];
  runner.fail = false;
  runner.gate = null;
  await db.query('DELETE FROM chat_message');
  await db.query('DELETE FROM chat_conversation');
});

const input = (conversationId?: string, message = 'hello') => ({
  ...(conversationId ? { conversationId } : {}),
  message,
  model: 'claude-opus-5-5',
  effort: 'high' as const,
});

describe('chat', () => {
  it('answers, keeps history and stops at the message limit', async () => {
    let c = await chat.send(input(), owner);
    await chat.idle();
    c = await chat.get(c.id, owner);
    expect(c.messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'DONE'],
      ['assistant', 'DONE'],
    ]);
    expect(c.quota).toEqual({ max: 3, used: 1, remaining: 2 });
    for (const n of [2, 3]) {
      await chat.send(input(c.id, `m${n}`), owner);
      await chat.idle();
    }
    expect(runner.requests.at(-1)!.prompt).toContain('Conversation so far');
    await expect(chat.send(input(c.id, 'm4'), owner)).rejects.toBeInstanceOf(ChatLimitError);
  });

  it('does not use up a message when Claude failed before answering', async () => {
    runner.fail = true;
    const c = await chat.send(input(), owner);
    await chat.idle();
    const after = await chat.get(c.id, owner);
    expect(after.messages[1]!.status).toBe('FAILED');
    expect(after.quota.used).toBe(0);
  });

  it('runs one reply at a time and hides conversations of other users', async () => {
    let release!: () => void;
    runner.gate = new Promise((r) => (release = r));
    const c = await chat.send(input(), owner);
    await expect(chat.send(input(c.id, 'again'), owner)).rejects.toBeInstanceOf(ChatBusyError);
    await expect(
      chat.get(c.id, { id: '00000000-0000-4000-8000-000000000000', username: 'x' }),
    ).rejects.toThrow();
    release();
    await chat.idle();
  });
});
