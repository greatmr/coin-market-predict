import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { csvField, toCsv } from './csv.js';
import { buildXlsx, columnName } from './xlsx.js';

describe('export writers', () => {
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
  it('builds a deterministic XLSX zip whose sheets and cells can be read back', () => {
    const sheets = [
      {
        name: 'All_Eligible',
        rows: [
          ['cmc_id', 'symbol', 'multiple_3d'],
          [990001, 'A&B <x>', 2],
          [990002, 'C', null],
        ],
      },
      {
        name: 'Run_Metadata',
        rows: [
          ['key', 'value'],
          ['data_label', 'SYNTHETIC'],
        ],
      },
    ];
    const a = buildXlsx(sheets);
    expect(a.equals(buildXlsx(sheets))).toBe(true);
    const entries = unzip(a);
    expect(Object.keys(entries)).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml',
        'xl/worksheets/sheet2.xml',
        'xl/styles.xml',
      ]),
    );
    expect(entries['xl/workbook.xml']).toContain(
      '<sheet name="All_Eligible" sheetId="1" r:id="rId1"/>',
    );
    expect(entries['xl/worksheets/sheet1.xml']).toContain('<c r="A2"><v>990001</v></c>');
    expect(entries['xl/worksheets/sheet1.xml']).toContain('A&amp;B &lt;x&gt;');
    expect(entries['xl/worksheets/sheet1.xml']).not.toContain('r="C3"');
    expect(columnName(0)).toBe('A');
    expect(columnName(27)).toBe('AB');
    expect(() => buildXlsx([{ name: 'bad/name', rows: [] }])).toThrow();
  });
});

/** Minimal ZIP reader for the test (local headers; deflate). */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const method = buf.readUInt16LE(o + 8),
      csize = buf.readUInt32LE(o + 18),
      nameLen = buf.readUInt16LE(o + 26),
      extra = buf.readUInt16LE(o + 28);
    const name = buf.subarray(o + 30, o + 30 + nameLen).toString('utf8');
    const data = buf.subarray(o + 30 + nameLen + extra, o + 30 + nameLen + extra + csize);
    out[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    o += 30 + nameLen + extra + csize;
  }
  return out;
}
