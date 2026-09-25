// Client-side .xlsx reader (zero dependencies) -> array of objects keyed by first row headers.
// Pure ZIP decompressor: STORED entries copied directly, DEFLATE unpacked via native DecompressionStream('deflate-raw').
// Parses XML using lightweight custom parser (./xmlParser) — deliberately avoids DOMParser:
// user-provided files are untrusted data and must not be parsed into live DOM nodes.

import { parseXml, XmlParseError, type XmlElement } from './xmlParser';
import i18n from '../i18n';

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Response(bytes as any).body!.pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  offset: number;
}

// Reads ZIP central directory to enumerate entries.
function readZipEntries(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Finds End Of Central Directory record (0x06054b50) from end of file.
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(i18n.t('errors.notZipXlsx'));

  const cdCount = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let n = 0; n < cdCount; n++) {
    if (off + 46 > buf.length || dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOffset = dv.getUint32(off + 42, true);
    const name = dec.decode(buf.subarray(off + 46, off + 46 + nameLen));
    entries.push({ name, method, compSize, offset: localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Retrieves uncompressed entry payload.
async function readEntryData(buf: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(entry.offset, true) !== 0x04034b50) throw new Error(i18n.t('errors.zipLocalHeader'));
  const nameLen = dv.getUint16(entry.offset + 26, true);
  const extraLen = dv.getUint16(entry.offset + 28, true);
  const dataStart = entry.offset + 30 + nameLen + extraLen;
  const comp = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return comp.slice(); // stored
  if (entry.method === 8) return inflateRaw(comp); // deflate
  throw new Error(i18n.t('errors.zipMethodUnsupported', { method: entry.method }));
}

// Wraps parser so syntax errors surface as user-friendly import validation messages.
function parseXmlPart(text: string): XmlElement {
  try {
    return parseXml(text);
  } catch (e) {
    if (e instanceof XmlParseError)
      //  keeps the parser's own error reachable: the translated message says WHAT failed, the
      // cause says where in the XML.
      throw new Error(i18n.t('errors.xlsxXmlParse', { message: e.message }), { cause: e });
    throw e;
  }
}

// sharedStrings table: concatenates multiple rich text <t> nodes within each <si>.
function parseSharedStrings(doc: XmlElement): string[] {
  const out: string[] = [];
  const sis = doc.getElementsByTagName('si');
  for (let i = 0; i < sis.length; i++) {
    const ts = sis[i].getElementsByTagName('t');
    let s = '';
    for (let j = 0; j < ts.length; j++) s += ts[j].textContent || '';
    out.push(s);
  }
  return out;
}

// Cell reference ("B3") -> 0-based column index.
function colIndexFromRef(ref: string): number {
  let i = 0;
  for (let k = 0; k < ref.length; k++) {
    const c = ref.charCodeAt(k);
    if (c >= 65 && c <= 90) i = i * 26 + (c - 64);
    else if (c >= 97 && c <= 122) i = i * 26 + (c - 96);
    else break;
  }
  return i - 1;
}

// Built-in Excel date/time format IDs.
const BUILTIN_DATE_FMT = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

// Heuristic: custom formatCodes containing unescaped y/m/d/h/s characters denote datetime.
function looksLikeDateFormat(code: string): boolean {
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\\./g, '');
  return /[ymdhs]/i.test(stripped);
}

// Parses styles.xml -> boolean array for cellXfs indices: whether style represents date format.
function parseStyles(doc: XmlElement): boolean[] {
  const customIsDate = new Map<number, boolean>();
  const numFmts = doc.getElementsByTagName('numFmt');
  for (let i = 0; i < numFmts.length; i++) {
    const id = parseInt(numFmts[i].getAttribute('numFmtId') || '-1', 10);
    const code = numFmts[i].getAttribute('formatCode') || '';
    if (id >= 0) customIsDate.set(id, looksLikeDateFormat(code));
  }
  const cellXfs = doc.getElementsByTagName('cellXfs')[0];
  const result: boolean[] = [];
  if (!cellXfs) return result;
  const xfs = cellXfs.getElementsByTagName('xf');
  for (let i = 0; i < xfs.length; i++) {
    const numFmtId = parseInt(xfs[i].getAttribute('numFmtId') || '0', 10);
    let isDate = BUILTIN_DATE_FMT.has(numFmtId);
    if (!isDate && customIsDate.has(numFmtId)) isDate = customIsDate.get(numFmtId)!;
    result.push(isDate);
  }
  return result;
}

// Converts Excel serial date numbers to 'YYYY-MM-DD' strings (with time if fractional).
function excelSerialToDate(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30); // handles Excel 1900 leap year bug baseline
  const d = new Date(epoch + Math.round(serial * 86400000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const hasTime = Math.abs(serial - Math.floor(serial)) > 1e-9;
  return hasTime ? `${ymd} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : ymd;
}

function cellValue(c: XmlElement, shared: string[], xfIsDate: boolean[], date1904: boolean): any {
  const t = c.getAttribute('t');
  if (t === 'inlineStr') {
    const ts = c.getElementsByTagName('t');
    let s = '';
    for (let k = 0; k < ts.length; k++) s += ts[k].textContent || '';
    return s;
  }
  const vEl = c.getElementsByTagName('v')[0];
  const raw = vEl ? vEl.textContent || '' : '';
  if (t === 's') return shared[parseInt(raw, 10)] ?? '';
  if (t === 'b') return raw === '1';
  if (t === 'str') return raw;
  // number or empty
  if (raw === '') return null;
  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  // Numeric cell with date format style -> converts serial number to date string.
  const s = c.getAttribute('s');
  if (s !== null && xfIsDate[parseInt(s, 10)]) return excelSerialToDate(num, date1904);
  return num;
}

/** A sheet as a grid of cell values, exactly as laid out — no header interpretation. */
function sheetMatrix(doc: XmlElement, shared: string[], xfIsDate: boolean[], date1904: boolean): any[][] {
  const rowsEl = doc.getElementsByTagName('row');
  const matrix: any[][] = [];
  for (let i = 0; i < rowsEl.length; i++) {
    const cells = rowsEl[i].getElementsByTagName('c');
    const rowArr: any[] = [];
    for (let j = 0; j < cells.length; j++) {
      const c = cells[j];
      const ref = c.getAttribute('r') || '';
      const idx = ref ? colIndexFromRef(ref) : j;
      rowArr[idx >= 0 ? idx : j] = cellValue(c, shared, xfIsDate, date1904);
    }
    // `rowArr[5] = x` on an empty array leaves holes; the importer reads indexes, so fill them.
    matrix.push(Array.from(rowArr, (v) => (v === undefined ? null : v)));
  }
  return matrix;
}

function parseSheet(doc: XmlElement, shared: string[], xfIsDate: boolean[], date1904: boolean): any[] {
  const matrix = sheetMatrix(doc, shared, xfIsDate, date1904);
  if (matrix.length === 0) return [];

  const headerArr = matrix[0] || [];
  const header = headerArr.map((v, i) => (v === null || v === undefined || v === '' ? `col${i + 1}` : String(v)));
  const rows: any[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const arr = matrix[r] || [];
    // skip completely empty rows
    if (arr.every((v) => v === null || v === undefined || v === '')) continue;
    const obj: any = {};
    header.forEach((h, i) => {
      const v = arr[i];
      obj[h] = v === undefined ? null : v;
    });
    rows.push(obj);
  }
  return rows;
}

/**
 * Parses .xlsx buffer -> array of row objects (keyed by headers in first row of first sheet).
 */
export async function parseXlsx(buffer: ArrayBuffer): Promise<any[]> {
  const buf = new Uint8Array(buffer);
  const entries = readZipEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));

  const textOf = async (name: string): Promise<string | null> => {
    const e = byName.get(name);
    if (!e) return null;
    return new TextDecoder().decode(await readEntryData(buf, e));
  };

  // sharedStrings (if present)
  let shared: string[] = [];
  const ssText = await textOf('xl/sharedStrings.xml');
  if (ssText) shared = parseSharedStrings(parseXmlPart(ssText));

  // styles.xml -> date column detection
  const stylesText = await textOf('xl/styles.xml');
  const xfIsDate = stylesText ? parseStyles(parseXmlPart(stylesText)) : [];

  // Resolves first worksheet path via workbook + rels; falls back to sheet1.xml.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  let date1904 = false;
  const wbText = await textOf('xl/workbook.xml');
  const relsText = await textOf('xl/_rels/workbook.xml.rels');
  if (wbText) {
    try {
      const pr = parseXmlPart(wbText).getElementsByTagName('workbookPr')[0];
      const d = pr?.getAttribute('date1904');
      date1904 = d === '1' || d === 'true';
    } catch {
      /* default 1900 date system */
    }
  }
  if (wbText && relsText) {
    try {
      const wb = parseXmlPart(wbText);
      const firstSheet = wb.getElementsByTagName('sheet')[0];
      // getAttribute matches both full 'r:id' and local 'id' without namespace complexity.
      const rid = firstSheet?.getAttribute('r:id') || '';
      const rels = parseXmlPart(relsText);
      const relEls = rels.getElementsByTagName('Relationship');
      for (let i = 0; i < relEls.length; i++) {
        if (relEls[i].getAttribute('Id') === rid) {
          let target = (relEls[i].getAttribute('Target') || '').replace(/^\//, '');
          sheetPath = target.startsWith('xl/') ? target : 'xl/' + target;
          break;
        }
      }
    } catch {
      /* use fallback sheet1.xml */
    }
  }

  let sheetText = await textOf(sheetPath);
  if (!sheetText) sheetText = await textOf('xl/worksheets/sheet1.xml');
  if (!sheetText) throw new Error(i18n.t('errors.xlsxNoWorksheet'));

  return parseSheet(parseXmlPart(sheetText), shared, xfIsDate, date1904);
}

/**
 * Every worksheet of an .xlsx, in workbook order, each as a raw grid (`sheetMatrix`) — for the table
 * importer, which lets the user pick the sheet and say whether the first row is a header. Unlike
 * `parseXlsx`, nothing here decides what a header is.
 */
export async function readXlsxSheets(buffer: ArrayBuffer): Promise<{ name: string; rows: any[][] }[]> {
  const buf = new Uint8Array(buffer);
  const entries = readZipEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const textOf = async (name: string): Promise<string | null> => {
    const e = byName.get(name);
    if (!e) return null;
    return new TextDecoder().decode(await readEntryData(buf, e));
  };

  const ssText = await textOf('xl/sharedStrings.xml');
  const shared = ssText ? parseSharedStrings(parseXmlPart(ssText)) : [];
  const stylesText = await textOf('xl/styles.xml');
  const xfIsDate = stylesText ? parseStyles(parseXmlPart(stylesText)) : [];

  const wbText = await textOf('xl/workbook.xml');
  const relsText = await textOf('xl/_rels/workbook.xml.rels');
  let date1904 = false;
  const sheets: { name: string; path: string }[] = [];
  if (wbText) {
    const wb = parseXmlPart(wbText);
    const pr = wb.getElementsByTagName('workbookPr')[0];
    const d = pr?.getAttribute('date1904');
    date1904 = d === '1' || d === 'true';
    const targets = new Map<string, string>();
    if (relsText) {
      const relEls = parseXmlPart(relsText).getElementsByTagName('Relationship');
      for (let i = 0; i < relEls.length; i++) {
        const target = (relEls[i].getAttribute('Target') || '').replace(/^\//, '');
        targets.set(relEls[i].getAttribute('Id') || '', target.startsWith('xl/') ? target : 'xl/' + target);
      }
    }
    const sheetEls = wb.getElementsByTagName('sheet');
    for (let i = 0; i < sheetEls.length; i++) {
      const rid = sheetEls[i].getAttribute('r:id') || '';
      sheets.push({
        name: sheetEls[i].getAttribute('name') || `Sheet${i + 1}`,
        path: targets.get(rid) || `xl/worksheets/sheet${i + 1}.xml`,
      });
    }
  }
  if (sheets.length === 0) sheets.push({ name: 'Sheet1', path: 'xl/worksheets/sheet1.xml' });

  // Parallel: these are entries of a zip already in memory, not queries against a database.
  const texts = await Promise.all(sheets.map((s) => textOf(s.path)));
  const out = sheets.flatMap((s, i) => {
    const text = texts[i];
    return text ? [{ name: s.name, rows: sheetMatrix(parseXmlPart(text), shared, xfIsDate, date1904) }] : [];
  });
  if (out.length === 0) throw new Error(i18n.t('errors.xlsxNoWorksheet'));
  return out;
}
