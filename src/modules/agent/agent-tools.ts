import { z } from 'zod';

import type { ForwardReadService } from '../forward-test/forward-read.service.js';
import { type ToolDef, defineTool } from '../mcp/tool-def.js';
import type { ReadModelService } from '../read-model/read-model.service.js';

import {
  type SnapshotPoint,
  downsample,
  pointRows,
  priceSummary,
  regimeFacts,
  slimTrace,
} from './agent-data.js';
import { REGIME_ASSETS } from './agent.constants.js';

export interface AgentToolContext {
  /** The coin under analysis and the batch of its Tier 1 record: every tool is bound to them. */
  cmcId: number;
  batchId: string;
  read: Pick<ReadModelService, 'assetTrace' | 'overview'>;
  forward: Pick<ForwardReadService, 'summary' | 'events'>;
  /** Stored hourly observations of a CMC id over the last `hours`, oldest first, exact decimals. */
  snapshots: (cmcId: number, hours: number) => Promise<SnapshotPoint[]>;
}

const json = z.record(z.string(), z.unknown());
const MAX_POINTS = 180;

/** One recorded tool call of a run (stored with the analysis for audit). */
export interface ToolCallRecord {
  name: string;
  input: unknown;
  at: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

/**
 * The agent's tools: read-only, bound to one coin (no id parameter to wander to other assets),
 * returning stored data only. Same `ToolDef` shape as the external MCP server.
 */
export function buildAgentTools(ctx: AgentToolContext): ToolDef[] {
  return [
    defineTool({
      name: 'get_coin_trace',
      description:
        "The coin's Tier 1 record from the latest scan: identity, data source (live or synthetic), the current observation and current VMC, the 3/7/14/30-day window means with multiples and YES/NO/N/A results, stars, queue position and weighted ranking, eligibility and reasons, LBank Spot pairs, CMC venue concentration, the completed UTC daily rows (volume, market cap, close, daily VMC) and the latest human reviews.",
      scope: 'read',
      input: {},
      output: json,
      handler: async () => {
        const trace = await ctx.read.assetTrace(ctx.cmcId, ctx.batchId);
        return trace ? slimTrace(trace) : { found: false };
      },
    }),
    defineTool({
      name: 'get_price_history',
      description: `Stored hourly observations of this coin (UTC slot time, price, circulating market cap, rolling-24h volume, CMC rank) over the last N hours (24 to 720, default 168), at most ${MAX_POINTS} evenly spaced rows, with an exact summary: price and volume change, high, low and distance from them.`,
      scope: 'read',
      input: {
        hours: z
          .number()
          .int()
          .min(24)
          .max(720)
          .optional()
          .describe('Hours of history (default 168).'),
      },
      output: json,
      handler: async ({ hours }) => {
        const span = hours ?? 168;
        const points = await ctx.snapshots(ctx.cmcId, span);
        return {
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
        'Market context: BTC and ETH from stored hourly observations (latest price; changes over 24 h, 72 h, 7 days and 30 days with the reference times) and the breadth of the latest Tier 1 scan (queue status and counts).',
      scope: 'read',
      input: {},
      output: json,
      handler: async () => {
        const [overview, ...series] = await Promise.all([
          ctx.read.overview(),
          ...REGIME_ASSETS.map((a) => ctx.snapshots(a.cmcId, 744)),
        ]);
        const scan = (overview.scan ?? null) as Record<string, unknown> | null;
        return {
          isLiveData: overview.isLiveData ?? null,
          assets: Object.fromEntries(
            REGIME_ASSETS.map((a, i) => [
              a.symbol,
              { cmcId: a.cmcId, ...regimeFacts(series[i] ?? []) },
            ]),
          ),
          latestScan: scan
            ? {
                batchId: scan.batchId ?? null,
                asOf: scan.asOf ?? null,
                queueStatus: scan.queueStatus ?? null,
                counts: scan.counts ?? null,
                warnings: scan.warnings ?? [],
              }
            : null,
          crawlAgeMinutes: overview.crawlAgeMinutes ?? null,
          banners: overview.banners ?? [],
        };
      },
    }),
    defineTool({
      name: 'get_forward_test_context',
      description:
        'Star Event Forward Test: what followed earlier star events. Cohorts by star count, detection-time pass pattern and weighted-points band (event counts; median and quartiles of the highest High within 168 h as a % of the detection price), freshness warnings, and every earlier star event of this coin with its outcome. Observed maxima, not trade returns.',
      scope: 'read',
      input: {},
      output: json,
      handler: async () => {
        const [summary, events] = await Promise.all([
          ctx.forward.summary(),
          ctx.forward.events({ view: 'all', search: String(ctx.cmcId), limit: 50, offset: 0 }),
        ]);
        return {
          notice: summary.notice,
          horizon: summary.horizon,
          isLive: summary.isLive,
          counts: summary.counts,
          warnings: summary.warnings,
          cohortByStars: summary.cohort,
          cohortByPattern: summary.cohortByPattern,
          cohortByPointsBand: summary.cohortByPointsBand,
          thisCoin: events.rows
            .filter((e) => e.cmcId === ctx.cmcId)
            .map((e) => ({
              detectedAt: e.detectedAt,
              starCount: e.starCount,
              passPattern: e.passPattern,
              weightedPassPoints: e.weightedPassPoints,
              referencePriceUsd: e.referencePriceUsd,
              status: e.status,
              peakReturnPct: e.outcome?.peakReturnPct ?? null,
              peakKind: e.outcome?.peakKind ?? null,
              peakAt: e.outcome?.peakAt ?? null,
              coverageStatus: e.outcome?.coverageStatus ?? null,
            })),
        };
      },
    }),
  ];
}

/** Wrap tools so every call (input, output or error) is recorded for the stored analysis. */
export function recordingTools(
  defs: readonly ToolDef[],
  log: ToolCallRecord[],
  redactError: (e: unknown) => string,
): ToolDef[] {
  return defs.map((d) => ({
    ...d,
    handler: async (args: Parameters<ToolDef['handler']>[0]) => {
      const at = new Date().toISOString();
      try {
        const output = await d.handler(args);
        log.push({ name: d.name, input: args, at, ok: true, output });
        return output;
      } catch (err) {
        log.push({ name: d.name, input: args, at, ok: false, error: redactError(err) });
        throw err;
      }
    },
  }));
}
