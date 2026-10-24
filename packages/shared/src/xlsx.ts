/**
 * Minimal .xlsx reader (Office Open XML) that works in the browser and in Node.
 *
 * Returns every sheet as rows of strings, as a user would see them:
 *  - text cells exactly as typed (leading zeros, spaces kept)
 *  - date-formatted cells as CCYY-MM-DD
 *  - numbers without floating-point noise (0.30000000000000004 → 0.3)
 *  - booleans as TRUE/FALSE, formula cells as their cached result
 */
import { strFromU8, unzipSync } from 'fflate';

export interface XlsxSheet {
  name: string;
  rows: string[][];
  /** Excel row number (1-based) for each entry in `rows`. Empty rows are skipped. */
  rowNumbers: number[];
}

export function isXlsx(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : undefined;
};

/** Concatenate all <t> runs inside a fragment (handles rich text). */
const textRuns = (xml: string) => {
  let out = '';
  for (const m of xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) out += decode(m[1]);
  // Self-closing <t/> contributes nothing.
  return out;
};

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function isDateFormat(code: string): boolean {
  // Strip quoted text, escaped chars and colour/condition blocks, then look for date tokens.
  const cleaned = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  return /[dmyhs]/i.test(cleaned) && !/^[#0.,%\s]*$/.test(cleaned);
}

function serialToIso(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + Math.round(serial * 86400000));
  return d.toISOString().slice(0, 10);
}

function cleanNumber(raw: string): string {
  const x = Number(raw);
  if (!Number.isFinite(x)) return raw;
  return String(parseFloat(x.toPrecision(15)));
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readXlsx(bytes: Uint8Array): XlsxSheet[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('This file is not a valid .xlsx workbook. Older .xls files must be re-saved as .xlsx or .csv.');
  }
  const read = (p: string) => (files[p] ? strFromU8(files[p]) : undefined);

  const workbook = read('xl/workbook.xml');
  if (!workbook) throw new Error('This file is not a valid .xlsx workbook.');
  const date1904 = /date1904="(1|true)"/.test(workbook);

  // Relationships: r:id → target path
  const rels = new Map<string, string>();
  for (const m of (read('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }

  // Shared strings
  const shared: string[] = [];
  for (const m of (read('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    // Ignore phonetic runs (<rPh>) which are not part of the visible text.
    shared.push(textRuns(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')));
  }

  // Styles → which style indexes are dates
  const stylesXml = read('xl/styles.xml') ?? '';
  const customFormats = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    const code = attr(m[0], 'formatCode') ?? '';
    customFormats.set(id, code);
  }
  const dateStyles = new Set<number>();
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  let xfIndex = 0;
  for (const m of cellXfs.matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const fmt = Number(attr(m[0], 'numFmtId') ?? 0);
    if (BUILTIN_DATE_FORMATS.has(fmt) || (customFormats.has(fmt) && isDateFormat(customFormats.get(fmt)!))) dateStyles.add(xfIndex);
    xfIndex++;
  }

  const sheets: XlsxSheet[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name') ?? `Sheet${sheets.length + 1}`;
    const rid = attr(m[0], 'r:id') ?? attr(m[0], 'id');
    const path = rid ? rels.get(rid) : undefined;
    const xml = path ? read(path) : undefined;
    if (!xml) continue;

    const rows: string[][] = [];
    const rowNumbers: number[] = [];
    for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const rowNum = Number(attr(`<row ${rm[1]}>`, 'r') ?? rows.length + 1);
      const cells: string[] = [];
      let next = 0;
      for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const head = `<c ${cm[1]}>`;
        const ref = attr(head, 'r');
        const idx = ref ? colIndex(ref) : next;
        next = idx + 1;
        const t = attr(head, 't');
        const style = Number(attr(head, 's') ?? 0);
        const inner = cm[2] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value = '';
        if (t === 's') value = v !== undefined ? (shared[Number(v)] ?? '') : '';
        else if (t === 'inlineStr') value = textRuns(inner);
        else if (t === 'str') value = v !== undefined ? decode(v) : '';
        else if (t === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (t === 'e') value = v !== undefined ? decode(v) : '';
        else if (t === 'd') value = v !== undefined ? decode(v).slice(0, 10) : '';
        else if (v !== undefined) value = dateStyles.has(style) && Number.isFinite(Number(v)) ? serialToIso(Number(v), date1904) : cleanNumber(v);
        while (cells.length < idx) cells.push('');
        cells[idx] = value;
      }
      if (cells.some((c) => c !== '')) {
        rows.push(cells);
        rowNumbers.push(rowNum);
      }
    }
    sheets.push({ name, rows, rowNumbers });
  }
  return sheets;
}
