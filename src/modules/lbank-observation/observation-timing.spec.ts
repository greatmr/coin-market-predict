import { describe, expect, it } from 'vitest';

import { type TimingRecords, actionableTiming } from './observation-timing.js';

const t = (s: string) => new Date(s);
const base = (over: Partial<TimingRecords> = {}): TimingRecords => ({
  crawlAt: t('2026-11-25T00:07:00.053Z'),
  cmcQuoteAt: t('2026-11-25T00:06:48.080Z'),
  pipelineRunId: 'run-1',
  scanStage: {
    status: 'succeeded',
    startedAt: t('2026-11-25T00:15:31.457Z'),
    finishedAt: t('2026-11-25T00:15:32.510Z'),
    attempts: 1,
  },
  scanRun: { finishedAt: t('2026-11-25T00:15:32.506Z'), attempts: 1, queueStatus: 'PUBLISHED' },
  intakeAt: t('2026-11-25T00:17:46.692Z'),
  eventCommittedAt: null,
  jobSeenAt: null,
  ...over,
});

describe('the observation start: the earliest proven usable time, never the crawl time', () => {
  it('a scan published minutes after the crawl start (recorded 00:00 batch: +8 min 32 s)', () => {
    const r = actionableTiming(base())!;
    expect(r.source).toBe('SCAN_COMMIT');
    expect(r.at.toISOString()).toBe('2026-11-25T00:15:32.510Z');
    expect(r.uncertain).toBe(false);
    expect(r.evidence).toMatchObject({
      crawlAt: '2026-11-25T00:07:00.053Z',
      cmcQuoteAt: '2026-11-25T00:06:48.080Z',
      lowerBound: '2026-11-25T00:15:32.506Z',
      uncertaintyMs: 4,
      afterCrawlMs: 512_457,
    });
  });

  it('a signal crawled before midnight and published after it starts on the next UTC day', () => {
    const r = actionableTiming(
      base({
        crawlAt: t('2026-11-25T23:07:00.051Z'),
        scanStage: {
          status: 'succeeded',
          startedAt: t('2026-11-25T23:58:00.000Z'),
          finishedAt: t('2026-11-26T00:02:10.000Z'),
          attempts: 1,
        },
        scanRun: {
          finishedAt: t('2026-11-26T00:02:09.996Z'),
          attempts: 1,
          queueStatus: 'PUBLISHED',
        },
        intakeAt: t('2026-11-26T00:02:30.000Z'),
      }),
    )!;
    expect(r.at.toISOString()).toBe('2026-11-26T00:02:10.000Z');
  });

  it('without a scan record: the event commit, then the first job sighting (labelled uncertain)', () => {
    const e = actionableTiming(
      base({ scanStage: null, eventCommittedAt: t('2026-11-25T00:17:46.900Z') }),
    )!;
    expect(e).toMatchObject({ source: 'EVENT_COMMIT', uncertain: true });
    const j = actionableTiming(base({ scanStage: null, jobSeenAt: t('2026-11-25T00:30:00Z') }))!;
    expect(j).toMatchObject({ source: 'JOB_FIRST_SEEN', uncertain: true });
    expect(actionableTiming(base({ scanStage: null }))).toBeNull();
  });

  it('a stage record that cannot prove the publication is not used', () => {
    // Not succeeded, finished before the crawl, or after the intake read the queue.
    for (const scanStage of [
      { status: 'failed', startedAt: null, finishedAt: t('2026-11-25T00:15:32Z'), attempts: 1 },
      { status: 'succeeded', startedAt: null, finishedAt: t('2026-11-25T00:06:00Z'), attempts: 1 },
      { status: 'succeeded', startedAt: null, finishedAt: t('2026-11-25T00:20:00Z'), attempts: 2 },
    ])
      expect(
        actionableTiming(base({ scanStage, eventCommittedAt: t('2026-11-25T00:17:47Z') }))!.source,
      ).toBe('EVENT_COMMIT');
  });
});
