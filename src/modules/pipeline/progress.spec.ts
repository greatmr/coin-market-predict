import { describe, expect, it } from 'vitest';

import { STAGES, nextCronRun, runProgress } from './progress.js';

const now = new Date('2026-11-06T00:10:00Z');
const st = (stage: string, status: string, startedAt = '2026-11-06T00:07:00Z') => ({
  stage,
  status,
  startedAt,
});

describe('pipeline run progress', () => {
  it('counts finished stages and adds the item share of the running stage', () => {
    const p = runProgress({
      stages: [
        st('discover', 'succeeded'),
        st('collect', 'succeeded'),
        st('lbank', 'succeeded'),
        st('daily', 'running', '2026-11-06T00:08:00Z'),
      ],
      currentStage: 'daily',
      progress: { stage: 'daily', unit: 'coins', done: 60, total: 240 },
      now,
    });
    expect(p.stagesDone).toBe(3);
    expect(p.stagesTotal).toBe(STAGES.length);
    expect(STAGES).toHaveLength(9);
    expect(p.percent).toBe(Math.floor(((3 + 0.25) / 9) * 100));
    // 120 s for 60 coins → 2 s per coin → 180 coins left ≈ 360 s.
    expect(p.current).toEqual({
      stage: 'daily',
      unit: 'coins',
      done: 60,
      total: 240,
      etaSeconds: 360,
    });
  });

  it('ignores item progress left over from another stage', () => {
    const p = runProgress({
      stages: [st('daily', 'succeeded'), st('scan', 'running')],
      currentStage: 'scan',
      progress: { stage: 'daily', unit: 'coins', done: 5, total: 5 },
      now,
    });
    expect(p.current).toBeNull();
    expect(p.stagesDone).toBe(1);
  });

  it('counts a failed non-fatal stage as finished, never a re-running stage, and stays below 100 %', () => {
    const all = STAGES.map((s) => st(s, s === 'daily' ? 'failed' : 'succeeded'));
    expect(runProgress({ stages: all, currentStage: null, progress: null, now }).percent).toBe(99);
    const rerun = runProgress({
      stages: [st('discover', 'succeeded'), st('collect', 'failed')],
      currentStage: 'collect',
      progress: null,
      now,
    });
    expect(rerun.stagesDone).toBe(1);
  });

  it('rejects malformed progress and gives no ETA before the first item', () => {
    expect(
      runProgress({
        stages: [],
        currentStage: 'daily',
        progress: { stage: 'daily', unit: 'coins', done: 1, total: 0 },
        now,
      }).current,
    ).toBeNull();
    expect(
      runProgress({
        stages: [st('daily', 'running')],
        currentStage: 'daily',
        progress: { stage: 'daily', unit: 'coins', done: 0, total: 10 },
        now,
      }).current?.etaSeconds,
    ).toBeNull();
  });
});

describe('next scheduled run', () => {
  it('returns the next UTC fire time of the cron expression', () => {
    expect(nextCronRun('7 * * * *', new Date('2026-11-06T07:30:00Z'))).toBe(
      '2026-11-06T08:07:00.000Z',
    );
    expect(nextCronRun('7 * * * *', new Date('2026-11-06T07:05:00Z'))).toBe(
      '2026-11-06T07:07:00.000Z',
    );
  });

  it('returns null for an invalid expression', () => {
    expect(nextCronRun('not a cron')).toBeNull();
  });
});
