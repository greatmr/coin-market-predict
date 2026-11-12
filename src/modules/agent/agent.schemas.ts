import { z } from 'zod';

import { CANDLE_STATES, MARKET_REGIMES } from '../strategy/index.js';

import { AGENT_CONFIDENCES, AGENT_OUTLOOKS } from './agent.constants.js';

/**
 * The agent's structured answer. It is validated twice: by the SDK against the JSON Schema
 * (draft-07) and again here with Zod before anything is stored. There is deliberately no
 * probability, price target or position size: the outlook is a qualitative view for the owner's
 * own chart review.
 */

const text = (max: number) => z.string().trim().min(1).max(max);

export const AgentFactorSchema = z.object({
  point: text(400).describe('What you observed and why it matters for a pump within 7 days.'),
  evidence: text(300).describe(
    'The tool fields and values it rests on, quoted exactly as returned (for example "windows[0].multiple = 2.41").',
  ),
});
export type AgentFactor = z.infer<typeof AgentFactorSchema>;

export const CoinAnalysisSchema = z.object({
  outlook: z
    .enum(AGENT_OUTLOOKS)
    .describe(
      'PUMP_LIKELY: several independent signs of an outsized up-move within 7 days that has not started. PUMP_POSSIBLE: a real setup with serious counter-evidence or missing confirmation. PUMP_UNLIKELY: the evidence does not support one, or the move already happened. INSUFFICIENT_DATA: key inputs are missing, stale, synthetic or contradictory.',
    ),
  confidence: z
    .enum(AGENT_CONFIDENCES)
    .describe('How sure you are of the outlook given the data quality. Not a probability.'),
  headline: text(240).describe('One sentence: your call on this coin for the next 7 days.'),
  mindset: text(3500).describe(
    'Your own reasoning in the first person: 3 to 6 short paragraphs separated by blank lines.',
  ),
  strategyFit: text(1000).describe(
    'How the coin stands against the Two-Tier VMC rules: eligibility, each window, stars, queue position, LBank status.',
  ),
  bullishFactors: z.array(AgentFactorSchema).max(8),
  bearishFactors: z.array(AgentFactorSchema).max(8),
  risks: z
    .array(text(400))
    .max(8)
    .describe('What could make the view wrong or the trade dangerous.'),
  dataGaps: z
    .array(text(300))
    .max(10)
    .describe(
      'Missing, stale or synthetic inputs and what you could not see (news, order books, intrahour prices).',
    ),
  watchNext: z
    .array(text(300))
    .max(6)
    .describe(
      'What the owner should check next on the TradingView 1D chart or in the coming scans.',
    ),
  candleState: z
    .enum(CANDLE_STATES)
    .describe(
      'Your read of the Tier 2 candle state from the price data: PRE_MOVE, ALREADY_PUMPED or UNCERTAIN.',
    ),
  marketRegime: z
    .enum(MARKET_REGIMES)
    .describe('Your read of the BTC/ETH regime: FAVORABLE, UNFAVORABLE or UNCERTAIN.'),
});
export type CoinAnalysis = z.infer<typeof CoinAnalysisSchema>;

/** JSON Schema (draft-07, as the Agent SDK requires) for an output schema. */
export function toSdkSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
}
