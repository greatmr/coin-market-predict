import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ToolDef } from '../../mcp/tool-def.js';
import { defineTool } from '../../mcp/tool-def.js';
import { RANKING_RULESET_VERSION, RULES, RULESET_VERSION } from '../../strategy/index.js';

import { chatQuota } from './chat-limit.js';
import { buildChatPrompt, buildChatSystemPrompt, strategyFingerprint } from './chat-prompt.js';
import { buildChatTools } from './chat-tools.js';
import { CHAT_EFFORTS, CHAT_MODELS, chatModelHasEffort } from './chat.constants.js';

const fakeTool = (name: string, scope: 'read' | 'write'): ToolDef =>
  defineTool({
    name,
    description: name,
    scope,
    input: {},
    output: z.unknown(),
    handler: async () => ({}),
  });

const ctx = (mcpTools: ToolDef[]) => ({
  mcp: { tools: () => mcpTools },
  data: { snapshots: async () => [] },
  observation: { summary: async () => ({}) as never },
});

describe('chat prompt follows the strategy', () => {
  it('is built from the current strategy constants', () => {
    const p = buildChatSystemPrompt();
    expect(p).toContain(RULESET_VERSION);
    expect(p).toContain(RANKING_RULESET_VERSION);
    expect(p).toContain(`rank ${RULES.rankMin}–${RULES.rankMax}`);
    expect(p).toContain(strategyFingerprint().split(' | ')[0]!);
  });

  it('says it is a risk manager, trader and analyst, and read-only', () => {
    const p = buildChatSystemPrompt();
    for (const w of ['Risk manager', 'Pro trader', 'Market data analyst', 'You can only READ'])
      expect(p).toContain(w);
    expect(p).toMatch(/refuse/);
  });

  it('adds an update notice only when the conversation began under another strategy', () => {
    expect(buildChatSystemPrompt()).not.toContain('# Strategy update');
    expect(buildChatSystemPrompt({ changedFrom: 'old | x' })).toContain('# Strategy update');
  });
});

describe('chat prompt history', () => {
  it('drops the oldest turns first and keeps the new message', () => {
    const history = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      content: `turn-${i} ${'x'.repeat(2000)}`,
    }));
    const p = buildChatPrompt(history, 'latest question', new Date('2026-11-27T00:00:00Z'));
    expect(p).toContain('latest question');
    expect(p).toContain('turn-39');
    expect(p).not.toContain('turn-0 ');
  });
});

describe('chat is read-only', () => {
  it('accepts read tools only', () => {
    const tools = buildChatTools(ctx([fakeTool('get_scan_summary', 'read')]));
    expect(tools.every((t) => t.scope === 'read')).toBe(true);
    expect(tools.map((t) => t.name)).toContain('get_strategy');
  });

  it('refuses a write tool that slips into the list', () => {
    // Only whitelisted names are reused, so even a mislabelled write tool must be refused.
    expect(() => buildChatTools(ctx([fakeTool('get_scan_summary', 'write')]))).toThrow(/read-only/);
  });

  it('exposes no tool whose name suggests a change', () => {
    const names = buildChatTools(ctx([])).map((t) => t.name);
    for (const n of names) expect(n).toMatch(/^(get|list)_/);
  });
});

describe('chat limits and options', () => {
  it('counts the remaining messages', () => {
    expect(chatQuota(3, 10)).toEqual({ max: 10, used: 3, remaining: 7 });
    expect(chatQuota(10, 10).remaining).toBe(0);
    expect(chatQuota(12, 10).remaining).toBe(0);
  });

  it('lists models and efforts; Haiku has no effort setting', () => {
    expect(CHAT_MODELS.length).toBeGreaterThan(1);
    expect(CHAT_EFFORTS).toContain('high');
    expect(chatModelHasEffort('claude-haiku-5-5')).toBe(false);
    expect(chatModelHasEffort('claude-opus-5-5')).toBe(true);
  });
});
