/**
 * The agent's run limit: at most `max` runs that count (all owners together) in any rolling window
 * of `windowHours`. A run counts from the moment it starts; a run that failed before Claude
 * produced any output is released again (see `AgentService`). Pure, so the window boundary is
 * unit-tested; the service applies it under a database lock.
 */
export interface AgentQuota {
  max: number;
  windowHours: number;
  /** Counted runs inside the window. */
  used: number;
  remaining: number;
  /** When the next run becomes possible while none remains (ISO, UTC); null while one remains. */
  nextFreeAt: string | null;
}

export function agentQuota(
  counted: readonly Date[],
  now: Date,
  max: number,
  windowHours: number,
): AgentQuota {
  const windowMs = windowHours * 3_600_000;
  // A run exactly `windowHours` old has left the window (the SQL uses requested_at > now - window).
  const inWindow = counted
    .filter((t) => now.getTime() - t.getTime() < windowMs)
    .sort((a, b) => a.getTime() - b.getTime());
  const used = inWindow.length;
  const remaining = Math.max(0, max - used);
  // Full: the next slot opens when enough of the oldest runs have left the window that fewer than
  // `max` remain, i.e. when the (used − max + 1)-th oldest run expires.
  const freeing = remaining > 0 ? undefined : inWindow[used - max];
  return {
    max,
    windowHours,
    used,
    remaining,
    nextFreeAt: freeing ? new Date(freeing.getTime() + windowMs).toISOString() : null,
  };
}
