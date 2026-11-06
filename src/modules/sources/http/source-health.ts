export const CIRCUIT_STATES = ['closed', 'open', 'half_open', 'suspended'] as const;
export type CircuitState = (typeof CIRCUIT_STATES)[number];

/** Persisted circuit-breaker and request-budget state for one provider. */
export interface SourceHealthState {
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveDenials: number;
  openedAt: Date | null;
  retryAfterUntil: Date | null;
  suspendedReason: string | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastStatusCode: number | null;
  budgetPeriodStart: Date | null;
  budgetUsed: number;
}

export interface SourceHealthStore {
  load(providerId: string): Promise<SourceHealthState>;
  save(providerId: string, state: SourceHealthState): Promise<void>;
}

export function initialHealth(): SourceHealthState {
  return {
    state: 'closed',
    consecutiveFailures: 0,
    consecutiveDenials: 0,
    openedAt: null,
    retryAfterUntil: null,
    suspendedReason: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastStatusCode: null,
    budgetPeriodStart: null,
    budgetUsed: 0,
  };
}

export class InMemorySourceHealthStore implements SourceHealthStore {
  private readonly states = new Map<string, SourceHealthState>();
  async load(providerId: string) {
    return structuredClone(this.states.get(providerId) ?? initialHealth());
  }
  async save(providerId: string, state: SourceHealthState) {
    this.states.set(providerId, structuredClone(state));
  }
}
