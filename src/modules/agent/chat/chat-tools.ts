import { z } from 'zod';

import type { ObservationReadService } from '../../lbank-observation/observation-read.service.js';
import type { McpService } from '../../mcp/mcp.service.js';
import { type ToolDef, defineTool } from '../../mcp/tool-def.js';
import { downsample, pointRows, priceSummary, regimeFacts } from '../agent-data.js';
import type { AgentDataService } from '../agent-data.service.js';
import { strategyBrief } from '../agent-prompt.js';
import { REGIME_ASSETS } from '../agent.constants.js';

import { implementationBrief, strategyFingerprint, strategyVersions } from './chat-prompt.js';

export interface ChatToolContext {
  mcp: Pick<McpService, 'tools'>;
  data: Pick<AgentDataService, 'snapshots'>;
  observation: Pick<ObservationReadService, 'summary'>;
}

const json = z.record(z.string(), z.unknown());
const MAX_POINTS = 180;

/** MCP tools the chat re-uses: stored Tier 1, batches and forward-test reads (all read scope). */
const MCP_TOOLS = new Set([
  'get_scan_summary',
  'get_scan_results',
  'get_asset_trace',
  'list_assets',
  'list_batches',
  'get_coverage',
  'get_forward_test_summary',
  'get_forward_events',
  'get_forward_event',
]);

/**
 * The desk's tools: read-only by construction. Only tools declared `scope: 'read'` are accepted
 * (this throws otherwise, so a future write tool can never reach the chat by accident), and none
 * of them writes anything. Same `ToolDef` shape as the MCP server.
 */
export function buildChatTools(ctx: ChatToolContext): ToolDef[] {
  const own: ToolDef[] = [
    defineTool({
      name: 'get_strategy',
      description:
        'The strategy and implementation exactly as currently built: every rule version, the Tier 1 rules and thresholds, the ranking weights and how observation works. Call it to answer questions about the rules.',
      scope: 'read',
      input: {},
      output: json,
      handler: async () => ({
        fingerprint: strategyFingerprint(),
        versions: strategyVersions(),
        strategy: strategyBrief(),
        implementation: implementationBrief(),
      }),
    }),
    defineTool({
      name: 'get_price_history',
      description: `Stored hourly observations of one coin by CMC id (UTC slot time, price, circulating market cap, rolling-24h volume, rank) over the last N hours (24 to 720, default 168), at most ${MAX_POINTS} evenly spaced rows, with an exact summary: price and volume change, high, low and distance from them.`,
      scope: 'read',
      input: {
        cmcId: z.number().int().positive().max(2_000_000_000),
        hours: z.number().int().min(24).max(720).optional(),
      },
      output: json,
      handler: async ({ cmcId, hours }) => {
        const span = hours ?? 168;
        const points = await ctx.data.snapshots(cmcId, span);
        return {
          cmcId,
          hours: span,
          volumeWindow: 'rolling 24h at each observation (not volume traded in that hour)',
          summary: priceSummary(points),
          rows: pointRows(downsample(points, MAX_POINTS)),
        };
      },
    }),
    defineTool({
      name: 'get_market_regime',
      description:
        'BTC and ETH from stored hourly observations: latest price and changes over 24 h, 72 h, 7 days and 30 days with the reference times.',
      scope: 'read',
      input: {},
      output: json,
      handler: async () => {
        const series = await Promise.all(
          REGIME_ASSETS.map((a) => ctx.data.snapshots(a.cmcId, 744)),
        );
        return {
          assets: Object.fromEntries(
            REGIME_ASSETS.map((a, i) => [
              a.symbol,
              { cmcId: a.cmcId, ...regimeFacts(series[i] ?? []) },
            ]),
          ),
        };
      },
    }),
    defineTool({
      name: 'get_observation_summary',
      description:
        'LBank Spot / Futures price observation: rules version, cutover, last run, freshness, final-only statistics and Futures status counts.',
      scope: 'read',
      input: {},
      output: json,
      handler: async () => (await ctx.observation.summary()) as unknown as Record<string, unknown>,
    }),
  ];
  const reused = ctx.mcp.tools().filter((t) => MCP_TOOLS.has(t.name));
  const all = [...own, ...reused];
  const bad = all.filter((t) => t.scope !== 'read');
  if (bad.length)
    throw new Error(`chat tools must be read-only: ${bad.map((t) => t.name).join(', ')}`);
  return all;
}

/** One recorded tool call of a reply (stored for audit). */
export interface ChatToolCall {
  name: string;
  input: unknown;
  at: string;
  ok: boolean;
}

/** Record each call (name and input only; outputs are not kept in the chat history). */
export function recordChatCalls(defs: readonly ToolDef[], log: ChatToolCall[]): ToolDef[] {
  return defs.map((d) => ({
    ...d,
    handler: async (args: Parameters<ToolDef['handler']>[0]) => {
      const at = new Date().toISOString();
      try {
        const out = await d.handler(args);
        log.push({ name: d.name, input: args, at, ok: true });
        return out;
      } catch (err) {
        log.push({ name: d.name, input: args, at, ok: false });
        throw err;
      }
    },
  }));
}
