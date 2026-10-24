/**
 * Builds a draft file-type definition from an uploaded file, so administrators
 * don't have to type 70 columns by hand. Two kinds of input are understood:
 *
 *  1. A layout specification — a sheet with a header row such as
 *     "Field | Description | Datatype | Required / Optional | Format | Column #"
 *     (e.g. ODR Attachments D, E, H, I). Datatypes, required flags, lengths,
 *     fixed values, allowed values and organization-specific values are read
 *     from the text, using the column order and real header names from a
 *     "layout" sheet when one exists.
 *  2. A sample data file (CSV or Excel) — the first row is taken as the column
 *     headers and types/required flags are inferred from the values.
 *
 * Everything returned is a *suggestion* for the admin to review.
 */
import { DELIMITER_LABEL, columnLetter, detectDelimiter, parseCsv } from './csv';
import { isIsoDate } from './expression';
import type { ColumnDefinition, CsvOptions, DataType, FileTypeDefinition, LookupList, RowRule } from './types';
import { isSensitiveColumn, normalizeHeader } from './validator';
import type { XlsxSheet } from './xlsx';

export interface ProposedColumn extends ColumnDefinition {
  /** Explanations of what was inferred and anything needing review. */
  notes: string[];
  /** Values seen in sample data that look like a closed list (not applied automatically). */
  suggestedAllowed?: string[];
}

export interface ImportResult {
  kind: 'spec' | 'data';
  sourceSheet: string;
  columns: ProposedColumn[];
  rowRules: RowRule[];
  meta: { id?: string; name?: string; description?: string; fileNamePattern?: string; csv?: CsvOptions; formats?: { csv: boolean; xlsx: boolean } };
  notes: string[];
  rowsAnalyzed?: number;
}

interface Table {
  name: string;
  rows: string[][];
  rowNumbers: number[];
}

export function toKey(header: string): string {
  const words = header
    .replace(/[’']/g, '')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const key = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
  return /^[A-Za-z]/.test(key) ? key : `c${key || 'olumn'}`;
}

function uniqueKeys<T extends { key: string }>(cols: T[]): T[] {
  const seen = new Map<string, number>();
  return cols.map((c) => {
    const n = (seen.get(c.key) ?? 0) + 1;
    seen.set(c.key, n);
    return n === 1 ? c : { ...c, key: `${c.key}${n}` };
  });
}

const cleanHeader = (h: string) => h.replace(/\s+/g, ' ').replace(/\*+$/, '').trim();
const smartQuotes = (s: string) => s.replace(/[“”„]/g, '"').replace(/[‘’]/g, "'");

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface ImportOptions {
  /** Row holding the headers in a sample data file (default 1). */
  headerRow?: number;
  /** Row where sample data starts (default headerRow + 1). */
  dataStartRow?: number;
}

export function analyzeWorkbook(sheets: XlsxSheet[], lookups: LookupList[] = [], opts: ImportOptions = {}): ImportResult {
  for (const sheet of sheets) {
    const spec = findSpecHeader(sheet);
    if (spec) return analyzeSpec(sheet, spec, sheets, lookups);
  }
  const data = sheets.filter((s) => s.rows.length > 0).sort((a, b) => b.rows.length - a.rows.length)[0];
  if (!data) throw new Error('The workbook is empty.');
  const res = analyzeData(data, opts);
  res.meta.formats = { csv: true, xlsx: true };
  return res;
}

export function analyzeCsvText(text: string, name = 'CSV', opts: ImportOptions = {}): ImportResult {
  const delimiter = detectDelimiter(text);
  const parsed = parseCsv(text, { delimiter });
  if (parsed.rows.length === 0) throw new Error('The file is empty.');
  const res = analyzeData({ name, rows: parsed.rows, rowNumbers: parsed.rows.map((_, i) => i + 1) }, opts);
  const le = parsed.lineEndings;
  res.meta.csv = { delimiter, encoding: parsed.hadBom ? 'utf-8-bom' : 'utf-8', quote: '"', lineEnding: le.crlf && !le.lf ? 'crlf' : le.lf && !le.crlf ? 'lf' : 'any' };
  if (delimiter !== ',') res.notes.unshift(`Detected ${DELIMITER_LABEL[delimiter] ?? `"${delimiter}"`} as the delimiter.`);
  return res;
}

/** Turn an import into a FileTypeDefinition draft (columns re-lettered). */
export function importToDefinition(base: FileTypeDefinition, result: ImportResult, mode: 'replace' | 'append', include: boolean[]): FileTypeDefinition {
  const picked = result.columns.filter((_, i) => include[i] !== false).map(({ notes: _n, suggestedAllowed: _s, ...c }) => c as ColumnDefinition);
  const existing = mode === 'append' ? base.columns : [];
  const keys = new Set(existing.map((c) => c.key));
  const merged = uniqueKeys([...existing, ...picked.map((c) => (keys.has(c.key) ? { ...c, key: `${c.key}New` } : c))]);
  const columns = merged.map((c, i) => ({ ...c, letter: columnLetter(i) }));
  const validKeys = new Set(columns.map((c) => c.key));
  const rowRules = [
    ...(mode === 'append' ? base.rowRules : []),
    ...result.rowRules.filter((r) => r.type !== 'equalColumns' || r.columns.every((k) => validKeys.has(k))),
  ];
  return {
    ...base,
    id: base.id || result.meta.id || '',
    name: base.name || result.meta.name || '',
    description: base.description || result.meta.description,
    fileNamePattern: base.fileNamePattern || result.meta.fileNamePattern,
    csv: base.columns.length === 0 && result.meta.csv ? result.meta.csv : base.csv,
    columns,
    rowRules,
  };
}

// ---------------------------------------------------------------------------
// Layout specification
// ---------------------------------------------------------------------------

interface SpecHeader {
  row: number; // index into sheet.rows
  field: number;
  datatype: number;
  description?: number;
  required?: number;
  format?: number;
  columnRef?: number;
  length?: number;
  allowed?: number;
}

function findSpecHeader(sheet: Table): SpecHeader | undefined {
  for (let r = 0; r < Math.min(sheet.rows.length, 15); r++) {
    const cells = sheet.rows[r].map((c) => c.trim().toLowerCase());
    const find = (re: RegExp, exclude: number[] = []) => cells.findIndex((c, i) => !exclude.includes(i) && re.test(c));
    const field = find(/^(field|field name|column name|column|name|element)$/);
    const datatype = find(/data\s*type|^type$/);
    if (field < 0 || datatype < 0) continue;
    const used = [field, datatype];
    const pick = (re: RegExp) => {
      const i = find(re, used);
      if (i >= 0) used.push(i);
      return i >= 0 ? i : undefined;
    };
    return {
      row: r,
      field,
      datatype,
      required: pick(/required|optional|^r\s*\/\s*o$|mandatory/),
      format: pick(/format|rule/),
      columnRef: pick(/column\s*(#|no|number|letter|position)|^col\b|^position$/),
      length: pick(/length|size|max/),
      allowed: pick(/allowed|valid values|values|codes/),
      description: pick(/desc/),
    };
  }
  return undefined;
}

function mapDataType(raw: string, format: string, notes: string[]): DataType {
  const t = raw.toLowerCase();
  if (/ccyy|yyyy-mm-dd|\bdate\b/i.test(format) && !/money|amount/i.test(t)) return 'date';
  if (/date/.test(t)) return 'date';
  if (/money|currency|amount|decimal/.test(t)) return 'money';
  if (/^int|integer/.test(t)) return 'int';
  if (/numeric|number|digit/.test(t)) return 'numeric';
  if (/char|text|string|alpha|chr/.test(t)) return 'varchar';
  notes.push(`Unrecognised data type "${raw}" — treated as text.`);
  return 'varchar';
}

function analyzeSpec(sheet: Table, h: SpecHeader, all: XlsxSheet[], lookups: LookupList[]): ImportResult {
  const notes: string[] = [];
  const fields: { cells: string[]; rowNumber: number }[] = [];
  let lastRow = sheet.rowNumbers[h.row];
  for (let r = h.row + 1; r < sheet.rows.length; r++) {
    const rowNumber = sheet.rowNumbers[r];
    if (fields.length > 0 && rowNumber - lastRow > 1) break; // a gap ends the field table
    lastRow = rowNumber;
    const cells = sheet.rows[r];
    const field = (cells[h.field] ?? '').trim();
    const dt = (cells[h.datatype] ?? '').trim();
    if (field && dt) fields.push({ cells, rowNumber });
  }
  if (fields.length === 0) throw new Error(`Found a layout header in sheet "${sheet.name}" but no field rows below it.`);

  const cell = (cells: string[], i?: number) => (i === undefined ? '' : smartQuotes((cells[i] ?? '').trim()));

  // Order by an explicit column reference (A, B, … or 1, 2, …) when present.
  if (h.columnRef !== undefined) {
    const pos = (v: string) => (/^[A-Z]{1,3}$/i.test(v) ? lettersToIndex(v.toUpperCase()) : /^\d+$/.test(v) ? Number(v) - 1 : undefined);
    if (fields.every((f) => pos(cell(f.cells, h.columnRef)) !== undefined)) {
      fields.sort((a, b) => pos(cell(a.cells, h.columnRef))! - pos(cell(b.cells, h.columnRef))!);
    }
  }

  // Use real header text from a layout/data sheet that lines up with the spec.
  const specNames = fields.map((f) => cleanHeader(cell(f.cells, h.field)));
  const layout = findLayoutHeaders(all, sheet.name, specNames);
  if (layout) notes.push(`Header names taken from sheet "${layout.sheet}" (the actual file layout).`);

  const conditional = new Map<string, string[]>();
  const rowRules: RowRule[] = [];
  let columns: ProposedColumn[] = fields.map((f, i) => {
    const colNotes: string[] = [];
    const header = layout ? layout.headers[i] : specNames[i];
    const description = cell(f.cells, h.description);
    const format = cell(f.cells, h.format);
    const reqText = cell(f.cells, h.required);
    const text = `${format} ${description}`;
    const dataType = mapDataType(cell(f.cells, h.datatype), format, colNotes);
    const col: ProposedColumn = { key: toKey(header), letter: columnLetter(i), header, dataType, required: true, notes: colNotes };
    if (description) col.description = description;
    if (layout && normalizeHeader(header) !== normalizeHeader(specNames[i])) colNotes.push(`Spec calls this field "${specNames[i]}".`);

    // Required / optional / conditional
    const r = reqText.toLowerCase();
    if (!reqText) {
      col.required = false;
      colNotes.push('No required/optional flag — set to optional.');
    } else if (/^(o|opt|optional|no|n)\b/.test(r)) col.required = false;
    else if (/\(for\s+([^)]+)\)|if known|\bif\b|when|conditional/.test(r)) {
      col.required = false;
      const who = /\(for\s+([^)]+)\)/.exec(reqText)?.[1]?.trim() ?? 'some records';
      conditional.set(who, [...(conditional.get(who) ?? []), header]);
      colNotes.push(`Conditionally required ("${reqText}") — set to optional; add an IF/THEN rule.`);
    }

    // Fixed values / organization-specific values
    const fixed =
      /hard[\s-]*cod(?:e|ed)\b[^=]*=\s*"?([A-Za-z0-9 _.\-]+?)"?\s*$/i.exec(format) ?? /\(\s*always\s+"?([A-Za-z0-9 _.\-]+?)"?\s*\)/i.exec(`${description} ${format}`);
    if (fixed) {
      col.fixedValue = fixed[1].trim();
      colNotes.push(`Fixed value "${col.fixedValue}".`);
    } else if (/hard[\s-]*cod/i.test(format) && /provid|assign|from|will be/i.test(format)) {
      col.orgValue = col.key;
      colNotes.push(`Organization-specific value — checked against each organization's "${col.key}" setting.`);
    }

    // Prefer the exact spelling used in the layout sheet's example rows.
    if (col.fixedValue && layout) {
      const sample = layout.samples.map((r) => (r[i] ?? '').trim()).find((v) => v && v !== col.fixedValue && v.toLowerCase() === col.fixedValue!.toLowerCase());
      if (sample) {
        colNotes.push(`Spec says "${col.fixedValue}" but the example data in "${layout.sheet}" uses "${sample}" — using "${sample}". Please confirm.`);
        col.fixedValue = sample;
      }
    }

    // Lengths
    const hashes = /(?<![#.])(#{2,})(?![#.])/.exec(format);
    const digits = /(\d+)[\s-]*(digit|character|char)\b/i.exec(text);
    if (hashes && (dataType === 'numeric' || dataType === 'int')) col.exactLength = hashes[1].length;
    else if (digits && !/\bor\b/i.test(format)) {
      const nlen = Number(digits[1]);
      if ((dataType === 'numeric' || dataType === 'int') && /digit/i.test(digits[2])) col.exactLength = nlen;
      else col.maxLength = nlen;
    }
    const lenCell = cell(f.cells, h.length);
    if (/^\d+$/.test(lenCell)) col.maxLength = Number(lenCell);
    if (col.exactLength) colNotes.push(`Exactly ${col.exactLength} characters.`);
    if (col.maxLength) colNotes.push(`At most ${col.maxLength} characters.`);

    // Money sign
    if (dataType === 'money' && /negative|include the sign/i.test(format) && !/no sign\b(?![\s\S]*negative)/i.test(format)) {
      col.allowNegative = true;
      colNotes.push('Negative amounts allowed (leading "-").');
    }

    // Allowed values
    if (!col.fixedValue) {
      const allowed = extractAllowed(format, description, sheet);
      if (allowed && allowed.length > 0) {
        if (allowed.length === 1 && !col.required) {
          col.allowedValues = allowed;
          colNotes.push(`When provided, must be "${allowed[0]}".`);
        } else if (allowed.length === 1) {
          col.fixedValue = allowed[0];
          colNotes.push(`Fixed value "${allowed[0]}".`);
        } else {
          col.allowedValues = allowed;
          colNotes.push(`Allowed values: ${allowed.join(', ')}.`);
        }
      }
      const allowedCell = cell(f.cells, h.allowed);
      if (allowedCell && !col.allowedValues) {
        const list = splitList(allowedCell);
        if (list.length > 1) col.allowedValues = list;
      }
    }

    // State codes → lookup list if available
    if (!col.allowedValues && !col.fixedValue && /state\s*(abbr|code)/i.test(text)) {
      const foreign = /foreign/i.test(text);
      const list = lookups.find((l) => l.id === (foreign ? 'STATES_OR_FOREIGN' : 'US_STATES')) ?? lookups.find((l) => /state/i.test(l.name));
      if (list) {
        col.lookupListId = list.id;
        colNotes.push(`Checked against lookup list "${list.name}".`);
      }
    }

    // "Same as column L"
    const same = /same as column\s+([A-Z]{1,3})\b/i.exec(text);
    if (same) colNotes.push(`Must equal column ${same[1].toUpperCase()} — rule added.`);

    if (dataType === 'date') colNotes.push('Date in CCYY-MM-DD.');
    if (isSensitiveColumn(col)) col.sensitive = true;
    return col;
  });

  columns = uniqueKeys(columns).map((c) => (c.orgValue ? { ...c, orgValue: c.key } : c));

  // Cross-column "same as" rules (after keys are final)
  const seenPairs = new Set<string>();
  columns.forEach((c, i) => {
    const m = /same as column\s+([A-Z]{1,3})\b/i.exec(`${fields[i] ? cell(fields[i].cells, h.description) : ''} ${fields[i] ? cell(fields[i].cells, h.format) : ''}`);
    if (!m) return;
    const other = columns[lettersToIndex(m[1].toUpperCase())];
    if (!other || other.key === c.key) return;
    const pair = [c.key, other.key].sort().join('|');
    if (seenPairs.has(pair)) return;
    seenPairs.add(pair);
    rowRules.push({ id: `import.same.${c.key}`, type: 'equalColumns', description: `${c.header} must equal ${other.header}`, columns: [other.key, c.key], severity: 'error' });
  });

  for (const [who, cols] of conditional) notes.push(`Required only for ${who}: ${cols.join(', ')}. Add an IF/THEN rule on the Cross-field rules tab.`);

  return { kind: 'spec', sourceSheet: sheet.name, columns, rowRules, meta: extractMeta(all), notes };
}

function lettersToIndex(l: string): number {
  let n = 0;
  for (const ch of l) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function splitList(text: string): string[] {
  return text
    .split(/\s*(?:,|;|\/|\bor\b)\s*/i)
    .map((v) => v.replace(/^["']|["']$/g, '').trim())
    .filter((v) => v && !/^etc\.?$|^<blank>$/i.test(v));
}

function extractAllowed(format: string, description: string, sheet: Table): string[] | undefined {
  // "must be one of the below Recall Reason Codes" → table further down the sheet
  const below = /one of the (?:below|following)\s+([A-Za-z ]+)/i.exec(format);
  if (below) {
    const label = normalizeHeader(below[1]);
    if (label.length > 3) {
      for (let start = 0; start < sheet.rows.length; start++) {
        const first = sheet.rows[start][0] ?? '';
        if (!first || !normalizeHeader(first).includes(label) || first.length > below[1].length + 30) continue;
        const values: string[] = [];
        let last = sheet.rowNumbers[start];
        for (let i = start + 1; i < sheet.rows.length; i++) {
          if (sheet.rowNumbers[i] - last > 1) break;
          last = sheet.rowNumbers[i];
          const v = (sheet.rows[i][0] ?? '').trim();
          if (v) values.push(v);
        }
        if (values.length) return values;
      }
    }
  }
  if (/etc\.?/i.test(format)) return undefined;
  // Quoted options: "I" or "C"
  const quoted = [...format.matchAll(/"([^"]{1,40})"/g)].map((m) => m[1].trim());
  if (quoted.length >= 2 && /\bor\b|,/i.test(format)) return [...new Set(quoted)];
  if (quoted.length === 1 && format.replace(/"[^"]*"/g, '').trim() === '') return quoted;
  // "Possible debt types: Fine, Fee, Penalty"
  const listed = /(?:possible|accepted|valid|allowed)[^:]*:\s*(.+)$/i.exec(format) ?? /(?:possible|accepted|valid|allowed)[^:]*:\s*(.+)$/i.exec(description);
  if (listed) {
    const list = splitList(listed[1]);
    if (list.length >= 2) return list;
  }
  // "one of the line item types" + "(Principal, Interest, Penalty)" in the description
  if (/one of/i.test(format)) {
    const paren = /\(([^)]+,[^)]+)\)/.exec(description);
    if (paren) return splitList(paren[1]);
  }
  // Unquoted "Agency Increase or Agency Decrease"
  const or = /^([A-Za-z][A-Za-z ]{0,30}?)\s+or\s+([A-Za-z][A-Za-z ]{0,30})$/i.exec(format.trim());
  if (or && !/justify|digit|zip|code|blank|abbr|number|format|text/i.test(format)) return [or[1].trim(), or[2].trim()];
  return undefined;
}

function findLayoutHeaders(sheets: XlsxSheet[], specSheet: string, specNames: string[]): { sheet: string; headers: string[]; samples: string[][] } | undefined {
  let best: { sheet: string; headers: string[]; samples: string[][]; score: number } | undefined;
  for (const s of sheets) {
    if (s.name === specSheet || s.rows.length === 0) continue;
    const headers = s.rows[0].map((c) => cleanHeader(c));
    while (headers.length && headers[headers.length - 1] === '') headers.pop();
    if (headers.length !== specNames.length || headers.some((x) => x === '')) continue;
    const score = headers.filter((x, i) => similar(x, specNames[i])).length / headers.length;
    if (score >= 0.6 && (!best || score > best.score)) best = { sheet: s.name, headers, samples: s.rows.slice(1), score };
  }
  return best;
}

function similar(a: string, b: string): boolean {
  const na = normalizeHeader(a);
  const nb = normalizeHeader(b);
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const wa = new Set(a.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const wb = b.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const common = wb.filter((w) => wa.has(w)).length;
  return common >= Math.max(1, Math.min(wa.size, wb.length) - 1);
}

function extractMeta(sheets: XlsxSheet[]): ImportResult['meta'] {
  const meta: ImportResult['meta'] = {};
  const all = sheets.flatMap((s) => s.rows.flat()).map(smartQuotes);
  for (const text of all) {
    const ft = /FILE TYPE:\s*([^(/]+?)\s*\(([A-Z]{2,6})\)/i.exec(text);
    if (ft && !meta.id) {
      meta.id = ft[2].toUpperCase();
      meta.name = ft[1].replace(/\bfile\b/i, '').replace(/^agency\s+/i, '').trim() || ft[1].trim();
    }
    const purpose = /PURPOSE:\s*(.+?)(?:\s*\/\s*[A-Z][A-Z ]+:|$)/.exec(text);
    if (purpose && !meta.description) meta.description = purpose[1].trim();
    const example = /\(example\s+([^)]+\.(?:csv|xlsx|txt))\)/i.exec(text);
    if (example && !meta.fileNamePattern) {
      const parts = example[1].trim().split('_');
      meta.fileNamePattern = parts
        .map((p, i) => (i === 0 ? '{ORG}' : /^\d{8}(\.\w+)?$/.test(p) ? p.replace(/^\d{8}/, '{YYYYMMDD}') : meta.id && p.toUpperCase() === meta.id ? '{TYPE}' : p))
        .join('_');
    }
  }
  if (!meta.name) {
    const title = sheets[0]?.rows[0]?.[0];
    if (title && title.length < 80) meta.name = title.split(/\s+-\s+/)[0].trim();
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

function analyzeData(t: Table, opts: ImportOptions = {}): ImportResult {
  const notes: string[] = [];
  const hr = opts.headerRow ?? 1;
  const hIdx = t.rowNumbers.indexOf(hr);
  if (hIdx < 0) throw new Error(`Row ${hr} (the header row set for this file type) is empty in "${t.name}".`);
  const headerRow = t.rows[hIdx].map((c) => cleanHeader(c));
  while (headerRow.length && headerRow[headerRow.length - 1] === '') headerRow.pop();
  if (headerRow.length === 0) throw new Error('The first row is empty — it must contain the column headers.');
  const start = opts.dataStartRow ?? hr + 1;
  const data = t.rows.filter((_, i) => t.rowNumbers[i] >= start).slice(0, 5000);
  if (headerRow.filter((h) => /^-?\d+(\.\d+)?$/.test(h) || isIsoDate(h)).length > headerRow.length / 2) {
    notes.push('The first row looks like data rather than headers — check the header names.');
  }
  if (data.length === 0) notes.push('Only a header row was found — data types default to text. Upload a file with sample rows for better suggestions.');

  const columns: ProposedColumn[] = headerRow.map((header, i) => {
    const name = header || `Column ${columnLetter(i)}`;
    const values = data.map((r) => (r[i] ?? '').trim());
    const filled = values.filter((v) => v !== '');
    const colNotes: string[] = [];
    const col: ProposedColumn = { key: toKey(name), letter: columnLetter(i), header: name, dataType: 'varchar', required: false, notes: colNotes };
    if (!header) colNotes.push('Header was blank — please name this column.');
    if (isSensitiveColumn(col)) {
      col.sensitive = true;
      colNotes.push('Looks sensitive (SSN/FEIN) — can be masked in reports.');
    }
    if (filled.length === 0) {
      if (data.length) colNotes.push('No sample values — treated as optional text.');
      return col;
    }
    const all = (re: RegExp) => filled.every((v) => re.test(v));
    if (filled.every((v) => isIsoDate(v))) col.dataType = 'date';
    else if (all(/^\d+$/)) {
      col.dataType = 'numeric';
      const lens = new Set(filled.map((v) => v.length));
      if (lens.size === 1 && filled[0].length > 1 && filled.length >= 3) {
        col.exactLength = filled[0].length;
        colNotes.push(`All samples are ${col.exactLength} digits.`);
      }
      if (filled.some((v) => v.length > 1 && v.startsWith('0'))) colNotes.push('Leading zeros present — kept as digits.');
    } else if (all(/^-?\d+(\.\d{1,2})?$/) && filled.some((v) => v.includes('.'))) {
      col.dataType = 'money';
      if (filled.some((v) => v.startsWith('-'))) col.allowNegative = true;
    } else if (all(/^-?\d+$/)) col.dataType = 'int';
    colNotes.push(`${filled.length} of ${data.length} sample rows filled; longest ${Math.max(...filled.map((v) => v.length))} chars.`);
    if (filled.length === data.length && data.length >= 3) {
      col.required = true;
      colNotes.push('Never blank in the sample — set to required.');
    }
    const distinct = [...new Set(filled)];
    if (col.dataType === 'varchar' && distinct.length <= 8 && filled.length >= 5 && distinct.length < filled.length / 2) {
      col.suggestedAllowed = distinct.sort();
    }
    return col;
  });
  return { kind: 'data', sourceSheet: t.name, columns: uniqueKeys(columns), rowRules: [], meta: {}, notes, rowsAnalyzed: data.length };
}
