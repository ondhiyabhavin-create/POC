import { ConditionEngine } from './conditions';
import { DELIMITER_LABEL, columnLetter, detectDelimiter, isBlankRow, parseCsv } from './csv';
import { isIsoDate, safeRegex } from './expression';
import { DEFAULT_CSV_OPTIONS } from './types';
import type {
  ColumnCheck,
  CsvOptions,
  ColumnDefinition,
  Condition,
  FileRule,
  FileTypeDefinition,
  IssueCategory,
  RowRule,
  Severity,
  ValidationContext,
  ValidationIssue,
  ValidationResult,
  ValidationStatus,
} from './types';
import { readXlsx, type XlsxSheet } from './xlsx';

export const isValidIsoDate = isIsoDate;
export const DEFAULT_FILE_NAME_PATTERN = '{ORG}_{TYPE}_{YYYYMMDD}.csv';

export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function displayValue(v: string): string {
  return v === '' ? '(blank)' : `"${v}"`;
}

/** Rows to validate, with their physical line numbers. */
export interface DataTable {
  rows: string[][];
  /** Row number shown to users for each entry (CSV: record number; Excel: sheet row number). */
  lineNumbers: number[];
  parseErrors?: { line: number; message: string }[];
  /** File-level format problems (encoding, line endings…) found while reading. */
  formatIssues?: { severity: Severity; message: string }[];
  /** Excel files drop empty trailing cells; pad short rows to the header width. */
  padRows?: boolean;
  sheetName?: string;
  format?: 'csv' | 'xlsx';
}

const csvOpts = (def?: Pick<FileTypeDefinition, 'csv'>): CsvOptions => ({ ...DEFAULT_CSV_OPTIONS, ...(def?.csv ?? {}) });

export function tableFromCsv(text: string, def?: Pick<FileTypeDefinition, 'csv'>): DataTable {
  const o = csvOpts(def);
  const p = parseCsv(text, { delimiter: o.delimiter, quote: o.quote });
  const formatIssues: DataTable['formatIssues'] = [];
  const le = p.lineEndings;
  if (o.lineEnding === 'crlf' && (le.lf > 0 || le.cr > 0)) formatIssues.push({ severity: 'error', message: `Lines must end with Windows line endings (CRLF), but ${le.lf + le.cr} line(s) use Unix/Mac endings (LF).` });
  if (o.lineEnding === 'lf' && le.crlf > 0) formatIssues.push({ severity: 'error', message: `Lines must end with Unix line endings (LF), but ${le.crlf} line(s) use Windows endings (CRLF).` });
  if (o.encoding === 'utf-8-bom' && !p.hadBom) formatIssues.push({ severity: 'error', message: 'The file must be saved as "UTF-8 with BOM" (byte order mark missing).' });
  if (o.encoding === 'utf-8-no-bom' && p.hadBom) formatIssues.push({ severity: 'error', message: 'The file must be saved as UTF-8 without a BOM (byte order mark found). In Excel choose "CSV (Comma delimited)" rather than "CSV UTF-8".' });
  // Wrong delimiter: header splits into one field but another delimiter would split it.
  if (p.rows[0]?.length === 1) {
    const guess = detectDelimiter(text);
    const d = o.delimiter === '\\t' ? '\t' : o.delimiter;
    if (guess !== d && text.split(/\r?\n/, 1)[0].includes(guess)) {
      formatIssues.push({ severity: 'error', message: `The file appears to be separated by ${DELIMITER_LABEL[guess] ?? `"${guess}"`}, but this file type expects ${DELIMITER_LABEL[d] ?? `"${d}"`}.` });
    }
  }
  return { rows: p.rows, lineNumbers: p.rows.map((_, i) => i + 1), parseErrors: p.errors.map((e) => ({ line: p.lineNumbers.findIndex((l) => l >= e.line) + 1 || e.line, message: e.message })), formatIssues, format: 'csv' };
}

/** Pick the sheet whose header row best matches the expected headers. */
export function tableFromXlsx(bytes: Uint8Array, def: Pick<FileTypeDefinition, 'columns' | 'headerRow'>): DataTable {
  const sheets = readXlsx(bytes).filter((s) => s.rows.length > 0);
  if (sheets.length === 0) return { rows: [], lineNumbers: [], padRows: true, format: 'xlsx' };
  const expected = new Set(def.columns.map((c) => normalizeHeader(c.header)));
  const hr = def.headerRow ?? 1;
  const headerOf = (s: XlsxSheet) => s.rows[s.rowNumbers.indexOf(hr)] ?? s.rows[0];
  const score = (s: XlsxSheet) => headerOf(s).filter((h) => expected.has(normalizeHeader(h))).length;
  const best = [...sheets].sort((a, b) => score(b) - score(a))[0];
  return { rows: best.rows, lineNumbers: best.rowNumbers, padRows: true, sheetName: best.name, format: 'xlsx' };
}

/** Decode CSV bytes according to the file type's encoding setting. */
export function decodeCsv(bytes: Uint8Array, def?: Pick<FileTypeDefinition, 'csv'>): { text: string; error?: string } {
  const o = csvOpts(def);
  if (o.encoding === 'windows-1252') return { text: new TextDecoder('windows-1252').decode(bytes) };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return {
      text: new TextDecoder('windows-1252').decode(bytes),
      error: 'The file is not valid UTF-8 text. It may have been saved with a different encoding (e.g. ANSI/Windows-1252). Re-save it as "CSV UTF-8".',
    };
  }
}

const TOKEN_HELP: Record<string, string> = { YYYYMMDD: 'YYYYMMDD', YYMMDD: 'YYMMDD', MMDDYYYY: 'MMDDYYYY' };

/** Build the file-name regex; `extensions` replaces the pattern's own extension when given. */
export function fileNameRegex(pattern: string, typeId: string, orgCode?: string, extensions?: string[]): RegExp {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let body = pattern;
  let ext = '';
  const m = /\.(csv|xlsx|txt)$/i.exec(body);
  if (m) {
    body = body.slice(0, -m[0].length);
    ext = m[1].toLowerCase();
  }
  const exts = extensions?.length ? extensions : ext ? (ext === 'csv' ? ['csv', 'xlsx'] : [ext]) : [];
  let src = '';
  for (const part of body.split(/(\{[A-Za-z#]+\})/)) {
    const t = /^\{([A-Za-z#]+)\}$/.exec(part)?.[1];
    if (!t) src += esc(part);
    else if (t === 'ORG') src += orgCode ? `(?<org>${esc(orgCode)})` : '(?<org>[A-Za-z0-9]+)';
    else if (t === 'TYPE') src += `(?<type>${esc(typeId)})`;
    else if (t === 'YYYYMMDD' || t === 'MMDDYYYY') src += `(?<${t === 'YYYYMMDD' ? 'date' : 'mdy'}>\\d{8})`;
    else if (t === 'YYMMDD') src += '(?<ymd6>\\d{6})';
    else if (t === 'ANY') src += '.+?';
    else if (/^X+$/i.test(t)) src += `[A-Za-z0-9]{${t.length}}`;
    else if (/^#+$/.test(t)) src += `\\d{${t.length}}`;
    else src += esc(part);
  }
  if (exts.length) src += `\\.(?:${exts.map(esc).join('|')})`;
  return new RegExp(`^${src}$`, 'i');
}

export function describeFileName(pattern: string, typeId: string, orgCode?: string, exts?: string[]): string {
  const p = exts?.length ? `${pattern.replace(/\.(csv|xlsx|txt)$/i, '')}.${exts.join(' or .')}` : pattern;
  return p
    .replace('{ORG}', orgCode ?? 'ORG')
    .replace('{TYPE}', typeId)
    .replace(/\{(YYYYMMDD|YYMMDD|MMDDYYYY)\}/g, (_, t: string) => TOKEN_HELP[t])
    .replace('{ANY}', '…');
}

function isValidYyyymmdd(v: string): boolean {
  return /^\d{8}$/.test(v) && isIsoDate(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`);
}

const SENSITIVE_RE = /\b(ssn|fein|ein|tin|itin|social\s*security|tax\s*id)\b/i;
export const isSensitiveColumn = (c: Pick<ColumnDefinition, 'sensitive' | 'key' | 'header'>) =>
  c.sensitive ?? (SENSITIVE_RE.test(c.header) || /^(ssn|fein|ein|tin|itin)$/i.test(c.key));
export const maskValue = (v: string) => {
  const t = v.trim();
  if (t.length <= 4) return '*'.repeat(t.length || 4);
  return `${'*'.repeat(t.length - 4)}${t.slice(-4)}`;
};

/** Validate CSV text. */
export function validateFile(csvText: string, ctx: ValidationContext): ValidationResult {
  return validateTable(tableFromCsv(csvText, ctx.fileType), ctx);
}

/** Validate an uploaded file (CSV or XLSX, detected from the bytes). */
export function validateBytes(bytes: Uint8Array, ctx: ValidationContext): ValidationResult {
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  const formats = ctx.fileType.formats ?? { csv: true, xlsx: true };
  const reject = (message: string) => validateTable({ rows: [], lineNumbers: [], formatIssues: [{ severity: 'error', message }] }, ctx);
  if (isZip) {
    if (!formats.xlsx) return reject(`Excel files are not accepted for ${ctx.fileType.name}. Save the file as CSV and try again.`);
    try {
      return validateTable(tableFromXlsx(bytes, ctx.fileType), ctx);
    } catch (e) {
      return reject((e as Error).message);
    }
  }
  if (bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf) return reject('Old Excel 97-2003 (.xls) files are not supported. Save the file as .xlsx or .csv.');
  if (!formats.csv) return reject(`CSV files are not accepted for ${ctx.fileType.name}. Upload an Excel (.xlsx) file.`);
  const { text, error } = decodeCsv(bytes, ctx.fileType);
  const table = tableFromCsv(text, ctx.fileType);
  if (error) table.formatIssues = [{ severity: 'error', message: error }, ...(table.formatIssues ?? [])];
  return validateTable(table, ctx);
}

/**
 * Validate a parsed table against a file-type definition.
 * Pure function: no I/O, safe to run in Lambda, Node or the browser.
 */
export function validateTable(table: DataTable, ctx: ValidationContext): ValidationResult {
  const started = Date.now();
  const { fileType, organization } = ctx;
  const columns = fileType.columns;
  const colIndex = new Map(columns.map((c, i) => [c.key, i]));
  const engine = new ConditionEngine(columns);
  const issues: ValidationIssue[] = [];
  const add = (issue: ValidationIssue) => issues.push(issue);
  const cellLabel = (row: number, col: ColumnDefinition) => `Row ${row}, Column ${col.letter} (${col.header})`;
  const formats = fileType.formats ?? { csv: true, xlsx: true };
  const exts = [formats.csv && 'csv', formats.xlsx && 'xlsx'].filter(Boolean) as string[];

  // ---------- File name ----------
  for (const rule of fileType.fileRules) {
    if (rule.type !== 'fileName') continue;
    const pattern = fileType.fileNamePattern || DEFAULT_FILE_NAME_PATTERN;
    const expected = describeFileName(pattern, fileType.id, organization?.code, exts);
    const m = fileNameRegex(pattern, fileType.id, organization?.code, exts).exec(ctx.fileName);
    let problem: string | undefined;
    if (!m) {
      const loose = fileNameRegex(pattern, fileType.id, undefined, exts).exec(ctx.fileName);
      problem =
        loose && organization && pattern.includes('{ORG}')
          ? `File name must start with your organization code "${organization.code}" (found "${loose.groups?.org}"). Expected ${expected}.`
          : `File name "${ctx.fileName}" does not follow the naming convention ${expected}.`;
    } else if (m.groups?.date && !isValidYyyymmdd(m.groups.date)) {
      problem = `File name date "${m.groups.date}" is not a valid date in YYYYMMDD format.`;
    } else if (m.groups?.ymd6 && !isValidYyyymmdd(`20${m.groups.ymd6}`)) {
      problem = `File name date "${m.groups.ymd6}" is not a valid date in YYMMDD format.`;
    } else if (m.groups?.mdy && !isValidYyyymmdd(`${m.groups.mdy.slice(4)}${m.groups.mdy.slice(0, 4)}`)) {
      problem = `File name date "${m.groups.mdy}" is not a valid date in MMDDYYYY format.`;
    }
    if (problem) add({ severity: rule.severity, ruleId: rule.id, category: 'File Name', message: problem, value: ctx.fileName });
  }

  for (const f of table.formatIssues ?? []) add({ severity: f.severity, ruleId: 'structure.format', category: 'Structure', message: f.message });
  for (const e of table.parseErrors ?? []) {
    add({ severity: 'error', ruleId: 'structure.parse', category: 'Structure', row: e.line, message: `Row ${e.line}: ${e.message}` });
  }

  let structuralFailure = (table.parseErrors ?? []).length > 0 || (table.formatIssues ?? []).some((f) => f.severity === 'error');
  let displayCols = columns;
  const finish = (dataRowCount: number, rowsWithErrors: Set<number>, rowsWithWarnings: Set<number>) =>
    buildResult(maskIssues(issues, fileType, displayCols), dataRowCount, rowsWithErrors, rowsWithWarnings, structuralFailure, started, displayCols);

  // ---------- Header / data rows ----------
  const headerRowNo = fileType.headerRow ?? 1;
  const dataStart = fileType.dataStartRow ?? headerRowNo + 1;
  const headerIdx = table.lineNumbers.indexOf(headerRowNo);

  if (table.rows.length === 0 || headerIdx < 0) {
    if (table.rows.length === 0 && !structuralFailure) add({ severity: 'error', ruleId: 'structure.empty', category: 'Structure', message: `The file is empty. Row ${headerRowNo} must contain the column headers.` });
    else if (table.rows.length > 0) add({ severity: 'error', ruleId: 'structure.noHeader', category: 'Structure', row: headerRowNo, message: `Row ${headerRowNo} must contain the column headers, but it is empty or missing${table.sheetName ? ` in sheet "${table.sheetName}"` : ''}.` });
    structuralFailure = true;
    return finish(0, new Set(), new Set());
  }
  const dataPairs = table.rows.map((r, i) => ({ r, line: table.lineNumbers[i] })).filter((x) => x.line >= dataStart);

  // Configuration problems (bad formulas etc.) are reported once, not per row.
  const brokenRules = new Set<string>();
  for (const rule of fileType.rowRules) {
    if (rule.type !== 'conditional') continue;
    const problems = engine.check(rule.when, [...rule.then, ...(rule.else ?? [])]);
    if (problems.length) {
      brokenRules.add(rule.id);
      add({ severity: 'warning', ruleId: rule.id, category: 'Conditional', message: `Rule "${rule.name ?? rule.id}" was skipped because it is misconfigured: ${problems[0]} Contact your administrator.` });
    }
  }

  const header = [...table.rows[headerIdx]];
  if (table.padRows) while (header.length > columns.length && header[header.length - 1].trim() === '') header.pop();
  const headerEq = (found: string, expected: string) =>
    fileType.headerMatch === 'strict' ? found.trim() === expected : normalizeHeader(found) === normalizeHeader(expected);
  const sheetNote = table.sheetName ? ` (sheet "${table.sheetName}")` : '';
  const ordered = fileType.enforceColumnOrder !== false;
  /** For each defined column, its position in the file (when order is not enforced). */
  let mapping: number[] | undefined;
  let headerOk = true;

  if (!ordered) {
    const used = new Set<number>();
    mapping = columns.map((col) => {
      const at = header.findIndex((h, i) => !used.has(i) && headerEq(h, col.header));
      if (at >= 0) used.add(at);
      return at;
    });
    columns.forEach((col, i) => {
      if (mapping![i] < 0) {
        headerOk = false;
        add({ severity: 'error', ruleId: 'structure.missingColumn', category: 'Structure', row: headerRowNo, field: col.header, message: `Row ${headerRowNo}${sheetNote}: required column "${col.header}" is missing. Columns may be in any order, but every column must be present.` });
      }
    });
    header.forEach((h, i) => {
      if (!used.has(i) && h.trim() !== '') {
        headerOk = false;
        add({ severity: 'error', ruleId: 'structure.unexpectedColumn', category: 'Structure', row: headerRowNo, column: columnLetter(i), value: h, message: `Row ${headerRowNo}, Column ${columnLetter(i)}: unexpected column ${displayValue(h)} is not part of the ${fileType.name} layout.` });
      }
    });
    if (headerOk) displayCols = columns.map((c, i) => ({ ...c, letter: columnLetter(mapping![i]) }));
  } else if (header.length !== columns.length) {
    headerOk = false;
    const missing = columns.length - header.length;
    add({
      severity: 'error',
      ruleId: 'structure.columnCount',
      category: 'Structure',
      row: headerRowNo,
      message:
        `Header row ${headerRowNo}${sheetNote} has ${header.length} columns but the ${fileType.name} layout requires exactly ${columns.length} ` +
        `(columns A through ${columns[columns.length - 1]?.letter ?? 'A'}). ` +
        (missing > 0 ? `${missing} column(s) appear to be missing or deleted.` : `${-missing} extra column(s) were found.`) +
        ' Row-level validation was skipped until the layout is corrected.',
    });
    const remaining = [...header];
    for (const col of columns) {
      const at = remaining.findIndex((h) => headerEq(h, col.header));
      if (at >= 0) remaining.splice(at, 1);
      else
        add({ severity: 'error', ruleId: 'structure.missingColumn', category: 'Structure', row: headerRowNo, column: col.letter, field: col.header, message: `Row ${headerRowNo}: required column ${col.letter} "${col.header}" is missing. All columns must be present even when the value is blank.` });
    }
    for (const extra of remaining.filter((h) => h.trim() !== '')) {
      add({ severity: 'error', ruleId: 'structure.unexpectedColumn', category: 'Structure', row: headerRowNo, value: extra, message: `Row ${headerRowNo}: unexpected column ${displayValue(extra)} is not part of the ${fileType.name} layout.` });
    }
  } else {
    columns.forEach((col, i) => {
      if (!headerEq(header[i], col.header)) {
        structuralFailure = true;
        add({
          severity: 'error',
          ruleId: 'structure.header',
          category: 'Structure',
          row: headerRowNo,
          column: col.letter,
          field: col.header,
          value: header[i],
          message: `Row ${headerRowNo}, Column ${col.letter}: header should be "${col.header}". Current value: ${displayValue(header[i])}. Columns must be in this exact order and must not be renamed, hidden or deleted.`,
        });
      }
    });
  }
  if (!headerOk) structuralFailure = true;

  const rowsWithErrors = new Set<number>();
  const rowsWithWarnings = new Set<number>();
  const nonBlank = dataPairs.filter((x) => !isBlankRow(x.r)).length;

  // ---------- Record count ----------
  const min = Math.max(1, fileType.minRecords ?? 1);
  const max = fileType.maxRecords;
  const notEmptyRule = fileType.fileRules.find((r) => r.type === 'notEmpty');
  if (nonBlank < min) {
    add({
      severity: notEmptyRule?.severity ?? 'error',
      ruleId: 'structure.recordCount',
      category: 'Structure',
      message: nonBlank === 0 ? `The file contains no data records (data must start on row ${dataStart}).` : `The file has ${nonBlank} record(s) but at least ${min} are required.`,
    });
  } else if (max !== undefined && nonBlank > max) {
    add({ severity: 'error', ruleId: 'structure.recordCount', category: 'Structure', message: `The file has ${nonBlank} records but no more than ${max} are allowed.` });
  }

  if (!headerOk) return finish(nonBlank, rowsWithErrors, rowsWithWarnings);

  const track = (issue: ValidationIssue) => {
    add(issue);
    if (issue.row !== undefined) (issue.severity === 'error' ? rowsWithErrors : rowsWithWarnings).add(issue.row);
  };

  const validRows: { line: number; values: string[] }[] = [];
  const width = mapping ? header.length : columns.length;
  let dataRowCount = 0;

  for (const { r: rowValues, line } of dataPairs) {
    let values = rowValues;
    if (isBlankRow(values)) {
      track({ severity: 'warning', ruleId: 'structure.blankRow', category: 'Structure', row: line, message: `Row ${line}: blank row will be ignored. Remove empty rows from the file.` });
      continue;
    }
    dataRowCount++;
    if (table.padRows && values.length < width) values = [...values, ...Array(width - values.length).fill('')];
    if (table.padRows && values.length > width && values.slice(width).every((v) => v.trim() === '')) values = values.slice(0, width);
    if (values.length !== width) {
      track({ severity: 'error', ruleId: 'structure.rowColumnCount', category: 'Structure', row: line, message: `Row ${line}: has ${values.length} values but ${width} are required. Check for extra or missing separators.` });
      continue;
    }
    if (mapping) values = mapping.map((i) => values[i]);
    validRows.push({ line, values });

    for (let c = 0; c < columns.length; c++) {
      const issue = checkCell(displayCols[c], values[c], line, ctx, cellLabel);
      if (issue) track(issue);
    }
    for (const rule of fileType.rowRules) {
      if (brokenRules.has(rule.id)) continue;
      for (const issue of evaluateRowRule(rule, values, line, displayCols, colIndex, engine, cellLabel)) track(issue);
    }
  }

  for (const rule of fileType.fileRules) {
    for (const issue of evaluateFileRule(rule, validRows, displayCols, colIndex, ctx)) track(issue);
  }

  return finish(dataRowCount, rowsWithErrors, rowsWithWarnings);
}

/** Replace sensitive values in issues with masked versions when the file type asks for it. */
function maskIssues(issues: ValidationIssue[], def: FileTypeDefinition, cols: ColumnDefinition[]): ValidationIssue[] {
  if (!def.maskSensitive) return issues;
  const sensitive = new Set(cols.filter(isSensitiveColumn).map((c) => c.letter));
  return issues.map((i) => {
    if (!i.column || !sensitive.has(i.column) || !i.value || !i.value.trim()) return i;
    const parts = i.value.split(' / ');
    let message = i.message;
    for (const p of parts) if (p.trim().length >= 2) message = message.split(p).join(maskValue(p));
    return { ...i, value: parts.map((p) => (p.trim() ? maskValue(p) : p)).join(' / '), message };
  });
}

function checkCell(
  col: ColumnDefinition,
  raw: string,
  line: number,
  ctx: ValidationContext,
  cellLabel: (row: number, col: ColumnDefinition) => string,
): ValidationIssue | undefined {
  const v = raw.trim();
  const sev = (check: ColumnCheck): Severity => col.severity?.[check] ?? 'error';
  const hint = col.hint ? ` ${col.hint}` : '';
  const make = (check: ColumnCheck, category: IssueCategory, problem: string): ValidationIssue => ({
    severity: sev(check),
    ruleId: `column.${check}`,
    category,
    row: line,
    column: col.letter,
    field: col.header,
    value: raw,
    message: `${cellLabel(line, col)}: ${problem} Current value: ${displayValue(raw)}.${hint}`,
  });

  // Fixed and organization-specific values are compared exactly, including whitespace.
  if (col.orgValue && !ctx.organization) {
    // No organization to compare with: only the required check applies.
    return v === '' && col.required ? make('required', 'Required', `${col.header} is required and cannot be blank.`) : undefined;
  }
  const orgExpected = col.orgValue && ctx.organization ? ctx.organization.attributes[col.orgValue] : undefined;
  const expected = col.fixedValue ?? orgExpected;
  if (expected !== undefined) {
    const whose = col.fixedValue !== undefined ? 'the fixed value' : `your organization's assigned value`;
    if (v === '' && col.required) return make('required', 'Required', `${col.header} is required and must be ${whose} "${expected}".`);
    if (v === '' && !col.required) return undefined;
    if (raw !== expected) {
      const why = raw.trim() === expected ? ' Remove leading or trailing spaces.' : raw.trim().toLowerCase() === expected.toLowerCase() ? ' Check capitalization.' : '';
      return make('fixedValue', 'Fixed Value', `${col.header} must exactly match ${whose} "${expected}".${why}`);
    }
    return undefined;
  }

  if (v === '') return col.required ? make('required', 'Required', `${col.header} is required and cannot be blank.`) : undefined;
  if (col.alwaysAllow?.includes(v)) return undefined;

  switch (col.dataType) {
    case 'numeric':
      if (!/^\d+$/.test(v)) {
        const extra = /^[\d\s-]+$/.test(v) ? ' Remove dashes and spaces.' : /e\+?\d+$/i.test(v) ? ' The value looks like scientific notation — Excel may have reformatted it.' : '';
        return make('dataType', 'Data Type', `${col.header} must contain digits only.${extra}`);
      }
      break;
    case 'int':
      if (!/^-?\d+$/.test(v)) return make('dataType', 'Data Type', `${col.header} must be a whole number.`);
      break;
    case 'money': {
      const re = col.allowNegative ? /^-?\d+(\.\d{1,2})?$/ : /^\d+(\.\d{1,2})?$/;
      if (!re.test(v)) {
        const extra = /[$,]/.test(v) ? ' Remove dollar signs and commas.' : !col.allowNegative && v.startsWith('-') ? ' Negative amounts are not allowed.' : '';
        return make('dataType', 'Data Type', `${col.header} must be an amount such as 123.45 (no more than 2 decimal places${col.allowNegative ? ', "-" for negative' : ''}).${extra}`);
      }
      break;
    }
    case 'date':
      if (!isIsoDate(v)) {
        const extra = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(v)
          ? ' The date appears to be in MM/DD/YYYY format — Excel may have reformatted it.'
          : /^\d{5}$/.test(v)
            ? ' The value looks like an Excel date serial number.'
            : /^\d{4}-\d{2}-\d{2}$/.test(v)
              ? ' The date does not exist on the calendar.'
              : '';
        return make('dataType', 'Data Type', `${col.header} must be a valid date in CCYY-MM-DD format.${extra}`);
      }
      break;
    case 'varchar':
      break;
  }

  if (col.exactLength !== undefined && v.length !== col.exactLength) {
    const extra = col.dataType === 'numeric' && v.length < col.exactLength ? ' Leading zeros may have been removed (this often happens when a CSV is opened in Excel).' : '';
    return make('length', 'Length', `${col.header} must be exactly ${col.exactLength} characters (found ${v.length}).${extra}`);
  }
  if (col.maxLength !== undefined && v.length > col.maxLength) return make('length', 'Length', `${col.header} must be no more than ${col.maxLength} characters (found ${v.length}).`);
  if (col.minLength !== undefined && v.length < col.minLength) return make('length', 'Length', `${col.header} must be at least ${col.minLength} characters (found ${v.length}).`);

  if (col.pattern && !safeRegex(col.pattern).test(v)) return make('pattern', 'Format', `${col.header} ${col.patternMessage ?? 'is not in the expected format.'}`);

  const allowed = col.allowedValues ?? (col.lookupListId ? ctx.lookups[col.lookupListId]?.values : undefined);
  if (allowed && allowed.length > 0 && !allowed.includes(v)) {
    const close = allowed.find((a) => normalizeHeader(a) === normalizeHeader(v));
    const list = allowed.length <= 10 ? ` Allowed values: ${allowed.map((a) => `"${a}"`).join(', ')}.` : '';
    const suggestion = close ? ` Did you mean "${close}"? Values must match exactly, including capitalization, spaces and dashes.` : '';
    return make('allowedValues', 'Allowed Values', `${col.header} is not an accepted value.${suggestion}${list}`);
  }
  return undefined;
}

function conditionMet(cond: Condition, values: string[], colIndex: Map<string, number>): boolean {
  const idx = colIndex.get(cond.column);
  if (idx === undefined) return false;
  const v = values[idx].trim();
  const list = Array.isArray(cond.value) ? cond.value : cond.value !== undefined ? [cond.value] : [];
  switch (cond.operator) {
    case 'equals':
      return v === list[0];
    case 'notEquals':
      return v !== list[0];
    case 'in':
      return list.includes(v);
    case 'notIn':
      return !list.includes(v);
    case 'isEmpty':
      return v === '';
    case 'isNotEmpty':
      return v !== '';
  }
}

export function describeCondition(cond: Condition, columns: ColumnDefinition[]): string {
  const col = columns.find((c) => c.key === cond.column);
  const name = col ? col.header : cond.column;
  const list = Array.isArray(cond.value) ? cond.value : cond.value !== undefined ? [cond.value] : [];
  const quoted = list.map((v) => `"${v}"`).join(' or ');
  switch (cond.operator) {
    case 'equals':
    case 'in':
      return `${name} is ${quoted}`;
    case 'notEquals':
    case 'notIn':
      return `${name} is not ${quoted}`;
    case 'isEmpty':
      return `${name} is blank`;
    case 'isNotEmpty':
      return `${name} is provided`;
  }
}

function evaluateRowRule(
  rule: RowRule,
  values: string[],
  line: number,
  columns: ColumnDefinition[],
  colIndex: Map<string, number>,
  engine: ConditionEngine,
  cellLabel: (row: number, col: ColumnDefinition) => string,
): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const get = (key: string) => {
    const i = colIndex.get(key);
    return i === undefined ? undefined : { col: columns[i], raw: values[i], v: values[i].trim() };
  };
  const issue = (col: ColumnDefinition, raw: string, category: IssueCategory, problem: string): ValidationIssue => ({
    severity: rule.severity,
    ruleId: rule.id,
    category,
    row: line,
    column: col.letter,
    field: col.header,
    value: raw,
    message: `${cellLabel(line, col)}: ${problem} Current value: ${displayValue(raw)}.`,
  });

  switch (rule.type) {
    case 'conditional': {
      const matched = engine.test(rule.when, values);
      const actions = matched ? rule.then : (rule.else ?? []);
      const always = rule.when.items.length === 0;
      const because = always ? '' : matched ? ` when ${engine.describe(rule.when)}` : ` unless ${engine.describe(rule.when)}`;
      for (const a of actions) {
        if (engine.satisfied(a, values)) continue;
        const cell = get(a.column);
        if (!cell) continue;
        const problem = a.message
          ? a.message
              .replace(/\{column\}/g, cell.col.letter)
              .replace(/\{header\}/g, cell.col.header)
              .replace(/\{value\}/g, cell.raw)
              .replace(/\{row\}/g, String(line))
          : `${engine.describeAction(a).replace(`${cell.col.header} (${cell.col.letter})`, cell.col.header)}${because}.`;
        out.push(issue(cell.col, cell.raw, a.check === 'required' ? 'Required' : 'Conditional', problem));
      }
      break;
    }
    case 'requiredWhen': {
      if (!conditionMet(rule.when, values, colIndex)) break;
      for (const key of rule.columns) {
        const cell = get(key);
        if (cell && cell.v === '') out.push(issue(cell.col, cell.raw, 'Required', `${cell.col.header} is required when ${describeCondition(rule.when, columns)}.`));
      }
      break;
    }
    case 'patternWhen': {
      if (!conditionMet(rule.when, values, colIndex)) break;
      const cell = get(rule.column);
      if (cell && cell.v !== '' && !safeRegex(rule.pattern).test(cell.v)) {
        out.push(issue(cell.col, cell.raw, 'Format', `${cell.col.header} ${rule.patternMessage} (because ${describeCondition(rule.when, columns)}).`));
      }
      break;
    }
    case 'allOrNone': {
      const cells = rule.columns.map(get).filter((c): c is NonNullable<typeof c> => !!c);
      const filled = cells.filter((c) => c.v !== '');
      if (filled.length > 0 && filled.length < cells.length) {
        const names = cells.map((c) => `${c.col.letter} (${c.col.header})`).join(', ');
        for (const c of cells.filter((x) => x.v === '')) out.push(issue(c.col, c.raw, 'Cross-Field', `Columns ${names} must either all be provided or all be left blank.`));
      }
      break;
    }
    case 'atLeastOne': {
      const cells = rule.columns.map(get).filter((c): c is NonNullable<typeof c> => !!c);
      if (cells.length > 0 && cells.every((c) => c.v === '')) {
        out.push(issue(cells[0].col, cells[0].raw, 'Required', `At least one of ${cells.map((c) => c.col.header).join(' or ')} must be provided.`));
      }
      break;
    }
    case 'equalColumns': {
      const a = get(rule.columns[0]);
      const b = get(rule.columns[1]);
      if (a && b && a.v !== b.v) out.push(issue(b.col, b.raw, 'Cross-Field', `${b.col.header} must equal Column ${a.col.letter} (${a.col.header}) "${a.v}".`));
      break;
    }
    case 'dateOrder': {
      const a = get(rule.before);
      const b = get(rule.after);
      if (a && b && isIsoDate(a.v) && isIsoDate(b.v) && a.v > b.v) out.push(issue(b.col, b.raw, 'Cross-Field', `${b.col.header} must be on or after ${a.col.header} (${a.v}).`));
      break;
    }
  }
  return out;
}

function evaluateFileRule(
  rule: FileRule,
  rows: { line: number; values: string[] }[],
  columns: ColumnDefinition[],
  colIndex: Map<string, number>,
  ctx: ValidationContext,
): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  switch (rule.type) {
    case 'duplicateKey': {
      const idxs = rule.columns.map((k) => colIndex.get(k)).filter((i): i is number => i !== undefined);
      if (idxs.length === 0) break;
      const first = new Map<string, number>();
      const label = idxs.map((i) => columns[i].header).join(' + ');
      const col = columns[idxs[0]];
      for (const { line, values } of rows) {
        const parts = idxs.map((i) => values[i].trim());
        if (parts.every((p) => p === '')) continue;
        const key = parts.join('\u0000');
        const seen = first.get(key);
        if (seen === undefined) first.set(key, line);
        else
          out.push({
            severity: rule.severity,
            ruleId: rule.id,
            category: 'Duplicate',
            row: line,
            column: col.letter,
            field: label,
            value: parts.join(' / '),
            message: `Row ${line}, Column ${col.letter} (${label}): duplicate value "${parts.join(' / ')}" — first seen on row ${seen}.`,
          });
      }
      break;
    }
    case 'duplicateRow': {
      const first = new Map<string, number>();
      for (const { line, values } of rows) {
        const key = values.map((v) => v.trim()).join('\u0000');
        const seen = first.get(key);
        if (seen === undefined) first.set(key, line);
        else out.push({ severity: rule.severity, ruleId: rule.id, category: 'Duplicate', row: line, message: `Row ${line}: this record is an exact duplicate of row ${seen}. Remove the duplicate record.` });
      }
      break;
    }
    case 'existsInPrior': {
      const prior = ctx.priorValues?.[rule.id];
      const i = colIndex.get(rule.column);
      if (!prior || i === undefined) break;
      const col = columns[i];
      for (const { line, values } of rows) {
        const v = values[i].trim();
        if (v !== '' && !prior.has(v)) {
          out.push({
            severity: rule.severity,
            ruleId: rule.id,
            category: 'Cross-File',
            row: line,
            column: col.letter,
            field: col.header,
            value: values[i],
            message: `Row ${line}, Column ${col.letter} (${col.header}): "${v}" was not found in any previously validated ${rule.sourceFileTypeId} file${ctx.organization ? ' for your organization' : ''}.`,
          });
        }
      }
      break;
    }
    case 'fileName':
    case 'notEmpty':
      break; // handled earlier
  }
  return out;
}

function buildResult(
  issues: ValidationIssue[],
  totalRecords: number,
  rowsWithErrors: Set<number>,
  rowsWithWarnings: Set<number>,
  structuralFailure: boolean,
  started: number,
  columns: ColumnDefinition[],
): ValidationResult {
  const order = new Map(columns.map((c, i) => [c.letter, i]));
  issues.sort((a, b) => {
    const ra = a.row ?? 0;
    const rb = b.row ?? 0;
    if (ra !== rb) return ra - rb;
    const ca = a.column ? (order.get(a.column) ?? 999) : -1;
    const cb = b.column ? (order.get(b.column) ?? 999) : -1;
    if (ca !== cb) return ca - cb;
    return a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1;
  });

  const byCategory: Record<string, { errors: number; warnings: number }> = {};
  const byColumn: Record<string, { errors: number; warnings: number }> = {};
  let errorCount = 0;
  let warningCount = 0;
  for (const i of issues) {
    const isErr = i.severity === 'error';
    if (isErr) errorCount++;
    else warningCount++;
    const cat = (byCategory[i.category] ??= { errors: 0, warnings: 0 });
    if (isErr) cat.errors++;
    else cat.warnings++;
    if (i.column) {
      const col = (byColumn[`${i.column} - ${i.field ?? ''}`] ??= { errors: 0, warnings: 0 });
      if (isErr) col.errors++;
      else col.warnings++;
    }
  }

  const status: ValidationStatus = errorCount > 0 ? 'failed' : warningCount > 0 ? 'passed_with_warnings' : 'passed';
  const errRows = rowsWithErrors.size;

  return {
    summary: {
      status,
      totalRecords,
      recordsPassed: structuralFailure && totalRecords > 0 && errRows === 0 ? 0 : Math.max(0, totalRecords - errRows),
      recordsWithErrors: errRows,
      recordsWithWarnings: [...rowsWithWarnings].filter((r) => !rowsWithErrors.has(r)).length,
      errorCount,
      warningCount,
      issuesTruncated: false,
      byCategory,
      byColumn,
      structuralFailure,
      durationMs: Date.now() - started,
    },
    issues,
  };
}

export { columnLetter };

/**
 * Values of the given columns from a file (used to remember e.g. placed debt IDs
 * for later cross-file checks). Honours header row, data start row and column order.
 */
export function extractColumnValues(bytes: Uint8Array, def: FileTypeDefinition, keys: string[]): Record<string, string[]> {
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  const table = isZip ? tableFromXlsx(bytes, def) : tableFromCsv(decodeCsv(bytes, def).text, def);
  const hr = def.headerRow ?? 1;
  const start = def.dataStartRow ?? hr + 1;
  const header = table.rows[table.lineNumbers.indexOf(hr)] ?? [];
  const eq = (a: string, b: string) => normalizeHeader(a) === normalizeHeader(b);
  const out: Record<string, string[]> = {};
  for (const key of keys) {
    const defIdx = def.columns.findIndex((c) => c.key === key);
    if (defIdx < 0) continue;
    const idx = def.enforceColumnOrder === false ? header.findIndex((h) => eq(h, def.columns[defIdx].header)) : defIdx;
    if (idx < 0) continue;
    out[key] = table.rows.filter((_, i) => table.lineNumbers[i] >= start).map((r) => (r[idx] ?? '').trim()).filter(Boolean);
  }
  return out;
}
