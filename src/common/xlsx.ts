import { crc32, deflateRawSync } from "node:zlib";

/**
 * Minimal, dependency-free XLSX (Office Open XML) writer: inline strings, numeric cells, a bold
 * frozen header row. The ZIP container uses a fixed timestamp so identical content produces a
 * byte-identical file (stable checksums for exports).
 */
export interface XlsxSheet {
  /** ≤ 31 characters, no []:*?/\ */
  name: string;
  /** First row is the header. Numbers become numeric cells, everything else text; null → empty. */
  rows: Array<Array<string | number | null | undefined>>;
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

function esc(s: string): string {
  // Characters XML 1.0 cannot carry are dropped; the five specials are escaped.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function columnName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function sheetXml(rows: XlsxSheet["rows"]): string {
  const out: string[] = [`${XML_HEADER}<worksheet xmlns="${NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>`];
  rows.forEach((row, r) => {
    const cells = row.map((v, c) => {
      const ref = `${columnName(c)}${r + 1}`;
      const style = r === 0 ? ' s="1"' : "";
      if (v === null || v === undefined || v === "") return "";
      if (typeof v === "number") return Number.isFinite(v) ? `<c r="${ref}"${style}><v>${v}</v></c>` : "";
      const text = esc(String(v));
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
    });
    out.push(`<row r="${r + 1}">${cells.join("")}</row>`);
  });
  out.push("</sheetData></worksheet>");
  return out.join("");
}

const STYLES = `${XML_HEADER}<styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

export function buildXlsx(sheets: XlsxSheet[]): Buffer {
  if (!sheets.length) throw new Error("a workbook needs at least one sheet");
  for (const s of sheets) if (!/^[^[\]:*?/\\]{1,31}$/.test(s.name)) throw new Error(`invalid sheet name ${s.name}`);
  const files: Array<[string, string]> = [
    [
      "[Content_Types].xml",
      `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    ],
    ["_rels/.rels", `${XML_HEADER}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `${XML_HEADER}<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `${XML_HEADER}<Relationships xmlns="${PKG_REL}">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", STYLES],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)] as [string, string]),
  ];
  return zip(files.map(([name, text]) => ({ name, data: Buffer.from(text, "utf8") })));
}

/** ZIP (deflate) with a fixed 1980-01-01 timestamp and UTF-8 names. */
export function zip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const compressed = deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}
