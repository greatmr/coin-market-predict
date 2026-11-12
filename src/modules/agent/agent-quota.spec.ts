import { describe, expect, it } from 'vitest';

import { agentQuota } from './agent-quota.js';

const now = new Date('2026-11-12T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

describe('agent run limit (5 runs in any rolling 12 hours by default)', () => {
  it('has every run left when nothing ran', () => {
    expect(agentQuota([], now, 5, 12)).toEqual({
      max: 5,
      windowHours: 12,
      used: 0,
      remaining: 5,
      nextFreeAt: null,
    });
  });

  it('counts only runs inside the window; a run exactly 12 h old has left it', () => {
    const q = agentQuota([hoursAgo(12), hoursAgo(11.99), hoursAgo(1)], now, 5, 12);
    expect([q.used, q.remaining, q.nextFreeAt]).toEqual([2, 3, null]);
  });

  it('when full, names the moment the oldest run leaves the window', () => {
    const runs = [hoursAgo(1), hoursAgo(9), hoursAgo(3), hoursAgo(2), hoursAgo(5)];
    const q = agentQuota(runs, now, 5, 12);
    expect([q.used, q.remaining]).toEqual([5, 0]);
    expect(q.nextFreeAt).toBe(new Date(hoursAgo(9).getTime() + 12 * 3_600_000).toISOString());
  });

  it('after the limit is lowered, waits until enough old runs have left', () => {
    // 4 runs against a limit of 2: a new run needs at most 1 left in the window, so three must
    // expire and the third-oldest decides.
    const q = agentQuota([hoursAgo(10), hoursAgo(8), hoursAgo(4), hoursAgo(1)], now, 2, 12);
    expect([q.used, q.remaining]).toEqual([4, 0]);
    expect(q.nextFreeAt).toBe(new Date(hoursAgo(4).getTime() + 12 * 3_600_000).toISOString());
  });
});
