import { describe, expect, it } from 'vitest';

import { readFixture } from '../../common/testing/fixtures.js';
import { dec } from '../../common/utils/decimal.js';

import { dailyRatio } from '../strategy/index.js';

import { parseCmcHistoryCsv } from './csv-import.js';

describe('manual CMC history CSV import (daily:import-csv)', () => {
  it('keeps exact digits, skips the open UTC day and orders completed days ascending', () => {
    const text = readFixture('cmc-history-litecoin.csv');
    const r = parseCmcHistoryCsv(text, 2, new Date('2026-11-03T16:00:00Z'));
    expect(r.skippedIncomplete).toBe(1); // 2026-11-03 is the current, open day
    expect(r.skippedUnparseable).toBe(0);
    expect(r.rows).toHaveLength(12);
    expect(r.rows[0]!.dateUtc).toBe('2026-10-22');
    const last = r.rows.at(-1)!;
    expect(last).toMatchObject({
      cmcId: 2,
      dateUtc: '2026-11-02',
      volume: '149922575',
      marketCap: '4171991578',
      close: '53.63',
      invalidReasons: [],
    });
    expect(last.periodEnd?.toISOString()).toBe('2026-11-02T23:59:59.999Z');
    // Same formula as the website rows: that day's volume ÷ that day's market cap.
    expect(dailyRatio(dec(last.volume), dec(last.marketCap)).ratio!.toFixed(12)).toBe(
      '0.035935493204',
    );
  });

  it('tolerates comma exports with month-name dates and $ thousands separators; flags non-numeric cells', () => {
    const text =
      'Date,Open,High,Low,Close,Volume,"Market Cap"\n"Nov 02, 2026","$55.55","$56.10","$53.59","$53.63","$149,922,575","$4,171,991,578"\n"Nov 01, 2026",1,1,1,1,n/a,"4,320,624,915"\nnot a date,1,1,1,1,1,1\n';
    const r = parseCmcHistoryCsv(text, 2, new Date('2026-11-03T00:00:00Z'));
    expect(r.skippedUnparseable).toBe(1);
    expect(r.rows.map((x) => x.dateUtc)).toEqual(['2026-11-01', '2026-11-02']);
    expect(r.rows[1]).toMatchObject({
      volume: '149922575',
      marketCap: '4171991578',
      invalidReasons: [],
    });
    expect(r.rows[0]).toMatchObject({ volume: null, invalidReasons: ['volume_not_numeric'] });
    expect(() => parseCmcHistoryCsv('a;b\n1;2', 2, new Date())).toThrow(/volume and marketCap/);
  });
});
