import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { type CoinAnalysis, CoinAnalysisSchema, toSdkSchema } from './agent.schemas.js';
import { consumeMessage, initialRunState, qualifiedToolName } from './claude-runner.js';

const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage;
const fold = (...messages: SDKMessage[]) =>
  messages.reduce(
    (s, m) => consumeMessage(s, m, CoinAnalysisSchema),
    initialRunState<CoinAnalysis>(),
  );

const answer: CoinAnalysis = {
  outlook: 'PUMP_POSSIBLE',
  confidence: 'MEDIUM',
  headline: 'Volume is up three-fold while price is flat.',
  mindset: 'First paragraph.\n\nSecond paragraph.',
  strategyFit: 'Eligible, 2 stars, queue position 4.',
  bullishFactors: [
    { point: 'VMC well above its 3-day mean', evidence: 'windows[0].multiple = 3.1' },
  ],
  bearishFactors: [],
  risks: ['Thin order books are not visible to me.'],
  dataGaps: ['No intrahour prices.'],
  watchNext: ['A daily close above the range high.'],
  candleState: 'PRE_MOVE',
  marketRegime: 'UNCERTAIN',
};
const init = msg({ type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's1' });
const reply = msg({ type: 'assistant', parent_tool_use_id: null, message: { content: [] } });
const result = (over: Record<string, unknown>) =>
  msg({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 6,
    duration_api_ms: 42_000,
    total_cost_usd: 0.42,
    session_id: 's1',
    modelUsage: {
      'claude-opus-5-5': {
        inputTokens: 1000,
        outputTokens: 900,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 10,
        costUSD: 0.4,
      },
      'claude-opus-4-8': {
        inputTokens: 100,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.02,
      },
    },
    ...over,
  });

describe('Claude Agent SDK messages → stored run result', () => {
  it('accepts a schema-valid structured answer and sums usage across models (fallback included)', () => {
    const s = fold(init, reply, result({ structured_output: answer }));
    expect([s.ok, s.errorKind, s.modelResponded]).toEqual([true, null, true]);
    expect(s.output).toEqual(answer);
    expect(s.usage).toMatchObject({
      inputTokens: 1100,
      outputTokens: 1000,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      costUsd: 0.42,
      numTurns: 6,
      models: ['claude-opus-5-5', 'claude-opus-4-8'],
      sessionId: 's1',
    });
  });

  it('rejects an answer outside the schema (e.g. a probability field instead of an outlook)', () => {
    const s = fold(init, reply, result({ structured_output: { ...answer, outlook: '87%' } }));
    expect([s.ok, s.errorKind]).toEqual([false, 'invalid_output']);
    expect(s.errorMessage).toMatch(/outlook/);
  });

  it('maps credential, limit and turn failures to stable kinds without leaking details', () => {
    const auth = fold(
      init,
      msg({ type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed' }),
      result({
        subtype: 'error_during_execution',
        errors: ['401 sk-ant-oat01-SECRETVALUE'],
        modelUsage: {},
      }),
    );
    expect([auth.errorKind, auth.modelResponded]).toEqual(['authentication_failed', false]);
    expect(auth.errorMessage).toMatch(/claude setup-token/);
    expect(auth.errorMessage).not.toMatch(/SECRETVALUE/);
    expect(fold(init, reply, result({ subtype: 'error_max_turns', errors: [] })).errorKind).toBe(
      'max_turns',
    );
    expect(
      fold(init, reply, result({ subtype: 'error_max_budget_usd', errors: [] })).errorKind,
    ).toBe('budget_exceeded');
    expect(
      fold(init, msg({ type: 'assistant', parent_tool_use_id: null, error: 'rate_limit' }))
        .errorKind,
    ).toBe('rate_limit');
  });

  it('records a refusal, and a refusal fallback that still answered', () => {
    const refused = fold(
      init,
      msg({ type: 'system', subtype: 'model_refusal_no_fallback', session_id: 's1' }),
      result({ structured_output: undefined, is_error: true, result: 'declined', modelUsage: {} }),
    );
    expect([refused.ok, refused.errorKind]).toEqual([false, 'refusal']);
    const rescued = fold(
      init,
      msg({ type: 'system', subtype: 'model_refusal_fallback', session_id: 's1' }),
      reply,
      result({ structured_output: answer }),
    );
    expect([rescued.ok, rescued.usage.refusalFallback]).toEqual([true, true]);
  });

  it('stops a run that would authenticate with an API key', () => {
    const s = fold(
      msg({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', session_id: 's1' }),
    );
    expect([s.abort, s.errorKind]).toEqual([true, 'authentication_failed']);
  });

  it('names tools for the permission rules and exports a draft-07 schema without probabilities', () => {
    expect(qualifiedToolName('get_coin_trace')).toBe('mcp__coins__get_coin_trace');
    const schema = toSdkSchema(CoinAnalysisSchema);
    expect(schema.$schema).toMatch(/draft-07/);
    expect(Object.keys(schema.properties as object)).not.toContain('probability');
    expect((schema.required as string[]).sort()).toEqual(Object.keys(answer).sort());
  });
});
