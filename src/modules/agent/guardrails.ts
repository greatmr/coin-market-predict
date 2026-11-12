import type { AgentConfidence } from './agent.constants.js';
import type { CoinAnalysis } from './agent.schemas.js';

/** Deterministic facts about the inputs the agent saw, taken from the stored Tier 1 record. */
export interface AnalysisFacts {
  /** Live market data (false = the synthetic fixture). */
  isLive: boolean;
  /** `scan_result.current_status` (OK, STALE, MISSING, …). */
  currentStatus: string | null;
  /** `crawl_batch.status` of the record's batch (COMPLETE, INCOMPLETE, FAILED). */
  batchStatus: string | null;
}

const LEVEL: Record<AgentConfidence, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * Confidence ceilings live in code, not in the prompt: synthetic data or an unusable current
 * observation caps the agent's confidence at LOW, an incomplete batch at MEDIUM. The outlook is
 * the agent's own view and is never changed; every adjustment is recorded as a note.
 */
export function applyGuardrails(
  analysis: CoinAnalysis,
  facts: AnalysisFacts,
): { analysis: CoinAnalysis; notes: string[] } {
  const notes: string[] = [];
  let confidence = analysis.confidence;
  const cap = (max: AgentConfidence, why: string) => {
    if (LEVEL[confidence] <= LEVEL[max]) return;
    notes.push(`Confidence lowered from ${confidence} to ${max}: ${why}.`);
    confidence = max;
  };
  if (!facts.isLive) cap('LOW', 'the data is the synthetic fixture, not market data');
  if (facts.currentStatus !== 'OK')
    cap(
      'LOW',
      `the current observation is ${facts.currentStatus ?? 'missing'}, so there is no valid current VMC`,
    );
  if (facts.batchStatus !== null && facts.batchStatus !== 'COMPLETE')
    cap('MEDIUM', `the crawl batch is ${facts.batchStatus}`);
  return { analysis: { ...analysis, confidence }, notes };
}
