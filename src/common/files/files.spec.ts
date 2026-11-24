import { describe, expect, it } from 'vitest';

import { csvField, toCsv } from './csv.js';

describe('CSV writer', () => {
  it('CSV quotes per RFC 4180 and leaves N/A numerics blank', () => {
    expect(csvField('a,"b"')).toBe('"a,""b"""');
    expect(csvField(null)).toBe('');
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['x', null],
          [1.5, 'y\nz'],
        ],
      ),
    ).toBe('a,b\r\nx,\r\n1.5,"y\nz"\r\n');
  });
});
