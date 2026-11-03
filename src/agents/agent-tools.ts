import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { MarketContext } from "../features/compute.js";
import { defineTool, invokeTool, toSdkTool, type ToolCallResult, type ToolDef } from "../mcp/tool-def.js";
import type { ReadModelService } from "../read-model/read-model.service.js";
import type { EvidencePack } from "../screening/evidence.js";
import { HIGH_PUMP_SCORE } from "../screening/recommend.js";
import type { StrategyParams } from "../screening/strategy.js";
import type { AgentRole } from "./runner.js";

export const AGENT_MCP_SERVER = "coins";

export interface AgentToolContext {
  packs: Map<string, EvidencePack>;
  market: MarketContext;
  readModel: ReadModelService;
  collectionHealth: Record<string, unknown>;
  strategy?: StrategyParams;
}

const json = z.record(z.string(), z.unknown());

/** Tool catalog for production agents. All tools are read-only. */
export function buildAgentTools(ctx: AgentToolContext): ToolDef[] {
  const assetIdArg = { assetId: z.string().uuid().describe("Canonical asset id from the shortlist") };
  const requirePack = (id: string) => {
    const p = ctx.packs.get(id);
    if (!p) throw new Error(`asset ${id} is not on this run's shortlist`);
    return p;
  };
  return [
    defineTool({
      name: "get_shortlist",
      description: "List the shortlisted assets for this run (id, symbol, classification, heuristic score).",
      scope: "read",
      input: {},
      output: z.array(json),
      handler: async () =>
        [...ctx.packs.values()].map((p) => ({
          assetId: p.assetId,
          symbol: p.identity.symbol,
          name: p.identity.name,
          classification: p.screening.classification,
          heuristicScore: p.screening.heuristicScore,
          warmupState: p.warmupState,
        })),
    }),
    defineTool({
      name: "get_evidence",
      description:
        "Full evidence pack for one shortlisted asset: identity, source URL and timestamps, latest snapshot, recent hourly snapshots, computed features (with reasons for unavailable ones), screening result, and the deterministic paper scenario.",
      scope: "read",
      input: assetIdArg,
      output: json,
      handler: async ({ assetId }) => requirePack(assetId) as unknown as Record<string, unknown>,
    }),
    defineTool({
      name: "get_market_context",
      description: "BTC/ETH 1h returns, market median 1h/2h returns, breadth and advancing share for this slot.",
      scope: "read",
      input: {},
      output: json,
      handler: async () => ctx.market as unknown as Record<string, unknown>,
    }),
    defineTool({
      name: "get_asset_history",
      description: "Stored hourly snapshots for a shortlisted asset (up to 72 hours).",
      scope: "read",
      input: { ...assetIdArg, hours: z.number().int().min(1).max(72).describe("Hours of history") },
      output: json,
      handler: async ({ assetId, hours }) => {
        requirePack(assetId);
        const res = await ctx.readModel.snapshots(assetId, hours);
        const snaps = (res.snapshots as Array<Record<string, unknown>>).map((s) => ({
          slotTime: s.slotTime,
          observedAt: s.observedAt,
          priceUsd: s.price,
          marketCapUsd: s.marketCap,
          volume24hUsd: s.volumeRolling24h,
          isStale: s.isStale,
          qualityFlags: s.qualityFlags,
        }));
        return { assetId, volumeWindow: "rolling_24h", snapshots: snaps };
      },
    }),
    defineTool({
      name: "get_strategy",
      description:
        "The base strategy the screen applied: thresholds, pattern definitions, how the pump chance is graded, and what buy / hold / sell mean in this paper-trading system.",
      scope: "read",
      input: {},
      output: json,
      handler: async () => ({
        version: ctx.strategy?.version ?? null,
        params: ctx.strategy ?? null,
        patterns: {
          advance_candidate: "rolling-24h volume up >= advanceMinVolumeBuild over 2h, accel_1h > 0, ret_2h between advanceMinRet2h and underwayRet2h, rs_market_2h > 0",
          move_underway: "ret_2h >= underwayRet2h: detection of a move already in progress, not an early signal",
          gradual_trend: "small steady gains without acceleration or volume build",
          market_wide: "moving with a broad rally (market median 2h >= marketRallyRet2h) without relative strength",
          overextended: "ret_2h >= overextendedRet2h or 24h change >= overextendedChange24h",
        },
        pumpChance: {
          high: `advance_candidate with heuristic score >= ${HIGH_PUMP_SCORE}`,
          medium: `advance_candidate below ${HIGH_PUMP_SCORE}; move_underway with score >= ${HIGH_PUMP_SCORE}; or a forming setup (3 of 4 early-surge conditions, score >= minShortlistScore)`,
          low: "everything else, and any coin with wash-trading or volume > market cap flags",
          note: "A heuristic level from deterministic rules, not a probability.",
        },
        stances: {
          buy: "take the paper long only if the entry trigger prints before expiry",
          hold: "no new entry; wait for confirmation (or keep an existing paper position)",
          sell: "avoid or exit: setup exhausted, risky or invalid",
          combined: "Code combines your stance with the strategy and guardrails: buy only when strategy, status (candidate) and agents agree; any sell or rejection means avoid.",
        },
        context: "Each evidence pack has context.threeDay (72h price change/high/low from stored hourly snapshots) and context.vmc (24h volume / market cap now vs the six-month daily mean). Cite them as context.threeDay.change, context.vmc.multiple, etc.",
      }),
    }),
    defineTool({
      name: "get_collection_health",
      description: "Coverage and collection health for this run (provider, live/fixture, coverage label, stale count, missing fields, source circuit state).",
      scope: "read",
      input: {},
      output: json,
      handler: async () => ctx.collectionHealth,
    }),
  ];
}

/** Least-privilege tool sets per role. */
export const ROLE_TOOLS: Record<AgentRole, string[]> = {
  market_analyst: ["get_shortlist", "get_evidence", "get_market_context", "get_asset_history", "get_strategy"],
  risk_reviewer: ["get_evidence", "get_asset_history", "get_market_context", "get_collection_health", "get_strategy"],
  coordinator: ["get_evidence"],
};

export interface AgentToolset {
  readonly names: string[];
  /** Fully qualified names for allowedTools: mcp__coins__<tool>. */
  readonly qualifiedNames: string[];
  call(name: string, args: unknown): Promise<ToolCallResult>;
  sdkServer(): ReturnType<typeof createSdkMcpServer>;
}

export function toolsetFor(role: AgentRole, all: ToolDef[]): AgentToolset {
  const names = ROLE_TOOLS[role];
  const defs = all.filter((d) => names.includes(d.name) && d.scope === "read");
  return {
    names: defs.map((d) => d.name),
    qualifiedNames: defs.map((d) => `mcp__${AGENT_MCP_SERVER}__${d.name}`),
    call: (name, args) => {
      const d = defs.find((x) => x.name === name);
      if (!d) return Promise.resolve({ isError: true, content: [{ type: "text", text: `tool ${name} not permitted for ${role}` }] });
      return invokeTool(d, args);
    },
    sdkServer: () =>
      createSdkMcpServer({
        name: AGENT_MCP_SERVER,
        version: "1.0.0",
        instructions: "Read-only access to Coins Predicts evidence for the current run.",
        tools: defs.map(toSdkTool),
        alwaysLoad: true,
      }),
  };
}
