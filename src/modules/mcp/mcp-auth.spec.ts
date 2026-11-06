import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { resolveScope } from './mcp-auth.js';
import { defineTool, invokeTool } from './tool-def.js';

describe('MCP access boundaries', () => {
  const tokens = { read: 'r'.repeat(32), write: 'w'.repeat(32) };
  it('grants scopes only for exact bearer tokens', () => {
    expect(resolveScope(`Bearer ${tokens.read}`, tokens)).toBe('read');
    expect(resolveScope(`Bearer ${tokens.write}`, tokens)).toBe('write');
    expect(resolveScope(`Bearer ${tokens.read}x`, tokens)).toBeNull();
    expect(resolveScope(undefined, tokens)).toBeNull();
    expect(resolveScope(`Basic ${tokens.read}`, tokens)).toBeNull();
  });

  it('validates tool inputs strictly and withholds invalid outputs', async () => {
    const t = defineTool({
      name: 't',
      description: 'd',
      scope: 'read',
      input: { n: z.number().int() },
      output: z.object({ ok: z.boolean() }),
      handler: async ({ n }) => ({ ok: n > 0 }),
    });
    expect((await invokeTool(t, { n: 1 })).structuredContent).toMatchObject({ data: { ok: true } });
    expect((await invokeTool(t, { n: '1' })).isError).toBe(true);
    expect((await invokeTool(t, { n: 1, sql: 'drop' })).isError).toBe(true);
    const bad = defineTool({
      name: 'b',
      description: 'd',
      scope: 'read',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: async () => ({ ok: 'yes' }) as never,
    });
    expect((await invokeTool(bad, {})).content[0]!.text).toMatch(/withheld/);
  });
});
