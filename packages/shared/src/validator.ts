import { ConditionEngine } from './conditions';
import { columnLetter, isBlankRow, parseCsv } from './csv';
import { isIsoDate, safeRegex } from './expression';
import type {
  ColumnCheck,
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

/** Rows to validate, with their physical line numbers (header = first row). */
export interface DataTable {
  rows: string[][];
  lineNumbers: number[];
  parseErrors?: { line: number; message: string }[];
  /** Excel files drop empty trailing cells; pad short rows to the header width. */
  padRows?: boolean;
  sheetName?: string;
}

export function tableFromCsv(text: string): DataTable {
  const p = parseCsv(text);
  return { rows: p.rows, lineNumbers: p.lineNumbers, parseErrors: p.errors };
}

/** Pick the sheet whose first row best matches the expected headers. */
export function tableFromXlsx(bytes: Uint8Array, def: Pick<FileTypeDefinition, 'columns'>): DataTable {
  const sheets = readXlsx(bytes).filter((s) => s.rows.length > 0);
  if (sheets.length === 0) return { rows: [], lineNumbers: [], padRows: true };
  const expected = new Set(def.columns.map((c) => normalizeHeader(c.header)));
  const score = (s: XlsxSheet) => s.rows[0].filter((h) => expected.has(normalizeHeader(h))).length;
  const best = [...sheets].sort((a, b) => score(b) - score(a))[0];
  return { rows: best.rows, lineNumbers: best.rowNumbers, padRows: true, sheetName: best.name };
}

export function fileNameRegex(pattern: string, typeId: string, orgCode?: string): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let src = '';
  for (const part of pattern.split(/(\{[A-Z]+\})/)) {
    if (part === '{ORG}') src += orgCode ? `(?<org>${esc(orgCode)})` : '(?<org>[A-Za-z0-9]+)';
    else if (part === '{TYPE}') src += `(?<type>${esc(typeId)})`;
    else if (part === '{YYYYMMDD}') src += '(?<date>\\d{8})';
    else if (part === '{ANY}') src += '.+?';
    else src += esc(part);
  }
  src = src.replace(/\\\.csv$/i, '\\.(?:csv|xlsx)');
  return new RegExp(`^${src}$`, 'i');
}

function isValidYyyymmdd(v: string): boolean {
  return /^\d{8}$/.test(v) && isIsoDate(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`);
}

/** Validate CSV text. */
export function validateFile(csvText: string, ctx: ValidationContext): ValidationResult {
  return validateTable(tableFromCsv(csvText), ctx);
}

/** Validate an uploaded file (CSV or XLSX, detected from the bytes). */
export function validateBytes(bytes: Uint8Array, ctx: ValidationContext): ValidationResult {
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) {
    try {
      return validateTable(tableFromXlsx(bytes, ctx.fileType), ctx);
    } catch (e) {
      return validateTable({ rows: [], lineNumbers: [], parseErrors: [{ line: 1, message: (e as Error).message }] }, ctx);
    }
  }
  return validateFile(new TextDecoder('utf-8').decode(bytes), ctx);
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

  // ---------- File name ----------
  for (const rule of fileType.fileRules) {
    if (rule.type !== 'fileName') continue;
    const pattern = fileType.fileNamePattern || DEFAULT_FILE_NAME_PATTERN;
    const expected = pattern.replace('{ORG}', organization?.code ?? 'ORG').replace('{TYPE}', fileType.id).replace('{YYYYMMDD}', 'YYYYMMDD').replace('{ANY}', '…');
    const m = fileNameRegex(pattern, fileType.id, organization?.code).exec(ctx.fileName);
    let problem: string | undefined;
    if (!m) {
      const loose = fileNameRegex(pattern, fileType.id).exec(ctx.fileName);
      problem =
        loose && organization && pattern.includes('{ORG}')
          ? `File name must start with your organization code "${organization.code}" (found "${loose.groups?.org}"). Expected ${expected}.`
          : `File name "${ctx.fileName}" does not follow the naming convention ${expected}.`;
    } else if (m.groups?.date && !isValidYyyymmdd(m.groups.date)) {
      problem = `File name date "${m.groups.date}" is not a valid date in YYYYMMDD format.`;
    }
    if (problem) add({ severity: rule.severity, ruleId: rule.id, category: 'File Name', message: problem, value: ctx.fileName });
  }

  for (const e of table.parseErrors ?? []) {
    add({ severity: 'error', ruleId: 'structure.parse', category: 'Structure', row: e.line, message: `Row ${e.line}: ${e.message}` });
  }

  let structuralFailure = (table.parseErrors ?? []).length > 0;
  const finish = (dataRowCount: number, rowsWithErrors: Set<number>, rowsWithWarnings: Set<number>) =>
    buildResult(issues, dataRowCount, rowsWithErrors, rowsWithWarnings, structuralFailure, started, columns);

  if (table.rows.length === 0) {
    if (!structuralFailure) add({ severity: 'error', ruleId: 'structure.empty', category: 'Structure', message: 'The file is empty. Row 1 must contain the column headers.' });
    structuralFailure = true;
    return finish(0, new Set(), new Set());
  }

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

  // ---------- Header ----------
  const header = [...table.rows[0]];
  if (table.padRows) while (header.length > columns.length && header[header.length - 1].trim() === '') header.pop();
  const headerEq = (found: string, expected: string) =>
    fileType.headerMatch === 'strict' ? found.trim() === expected : normalizeHeader(found) === normalizeHeader(expected);
  const sheetNote = table.sheetName ? ` (sheet "${table.sheetName}")` : '';

  if (header.length !== columns.length) {
    structuralFailure = true;
    const missing = columns.length - header.length;
    add({
      severity: 'error',
      ruleId: 'structure.columnCount',
      category: 'Structure',
      row: table.lineNumbers[0],
      message:
        `Header row${sheetNote} has ${header.length} columns but the ${fileType.name} layout requires exactly ${columns.length} ` +
        `(columns A through ${columns[columns.length - 1]?.letter ?? 'A'}). ` +
        (missing > 0 ? `${missing} column(s) appear to be missing or deleted.` : `${-missing} extra column(s) were found.`) +
        ' Row-level validation was skipped until the layout is corrected.',
    });
    // Positions are shifted, so name the missing / unexpected headers.
    const remaining = [...header];
    for (const col of columns) {
      const at = remaining.findIndex((h) => headerEq(h, col.header));
      if (at >= 0) remaining.splice(at, 1);
      else
        add({
          severity: 'error',
          ruleId: 'structure.missingColumn',
          category: 'Structure',
          row: table.lineNumbers[0],
          column: col.letter,
          field: col.header,
          message: `Row ${table.lineNumbers[0]}: required column ${col.letter} "${col.header}" is missing. All columns must be present even when the value is blank.`,
        });
    }
    for (const extra of remaining.filter((h) => h.trim() !== '')) {
      add({ severity: 'error', ruleId: 'structure.unexpectedColumn', category: 'Structure', row: table.lineNumbers[0], value: extra, message: `Row ${table.lineNumbers[0]}: unexpected column ${displayValue(extra)} is not part of the ${fileType.name} layout.` });
    }
  } else {
    columns.forEach((col, i) => {
      if (!headerEq(header[i], col.header)) {
        structuralFailure = true;
        add({
          severity: 'error',
          ruleId: 'structure.header',
          category: 'Structure',
          row: table.lineNumbers[0],
          column: col.letter,
          field: col.header,
          value: header[i],
          message: `Row ${table.lineNumbers[0]}, Column ${col.letter}: header should be "${col.header}". Current value: ${displayValue(header[i])}. Columns must not be renamed, rearranged, hidden or deleted.`,
        });
      }
    });
  }

  const dataRows = table.rows.slice(1);
  const dataLines = table.lineNumbers.slice(1);
  const rowsWithErrors = new Set<number>();
  const rowsWithWarnings = new Set<number>();
  let dataRowCount = 0;

  const notEmptyRule = fileType.fileRules.find((r) => r.type === 'notEmpty');
  if (notEmptyRule && dataRows.filter((r) => !isBlankRow(r)).length === 0) {
    add({ severity: notEmptyRule.severity, ruleId: notEmptyRule.id, category: 'Structure', message: 'The file contains a header row but no data records.' });
  }

  if (header.length !== columns.length) {
    dataRowCount = dataRows.filter((r) => !isBlankRow(r)).length;
    return finish(dataRowCount, rowsWithErrors, rowsWithWarnings);
  }

  const track = (issue: ValidationIssue) => {
    add(issue);
    if (issue.row !== undefined) (issue.severity === 'error' ? rowsWithErrors : rowsWithWarnings).add(issue.row);
  };

  const validRows: { line: number; values: string[] }[] = [];

  for (let r = 0; r < dataRows.length; r++) {
    let values = dataRows[r];
    const line = dataLines[r];
    if (isBlankRow(values)) {
      track({ severity: 'warning', ruleId: 'structure.blankRow', category: 'Structure', row: line, message: `Row ${line}: blank row will be ignored. Remove empty rows from the file.` });
      continue;
    }
    dataRowCount++;
    if (table.padRows && values.length < columns.length) values = [...values, ...Array(columns.length - values.length).fill('')];
    if (table.padRows && values.length > columns.length && values.slice(columns.length).every((v) => v.trim() === '')) values = values.slice(0, columns.length);
    if (values.length !== columns.length) {
      track({
        severity: 'error',
        ruleId: 'structure.rowColumnCount',
        category: 'Structure',
        row: line,
        message: `Row ${line}: has ${values.length} values but ${columns.length} are required. Check for extra or missing commas.`,
      });
      continue;
    }
    validRows.push({ line, values });

    for (let c = 0; c < columns.length; c++) {
      const issue = checkCell(columns[c], values[c], line, ctx, cellLabel);
      if (issue) track(issue);
    }
    for (const rule of fileType.rowRules) {
      if (brokenRules.has(rule.id)) continue;
      for (const issue of evaluateRowRule(rule, values, line, columns, colIndex, engine, cellLabel)) track(issue);
    }
  }

  for (const rule of fileType.fileRules) {
    for (const issue of evaluateFileRule(rule, validRows, columns, colIndex, ctx)) track(issue);
  }

  return finish(dataRowCount, rowsWithErrors, rowsWithWarnings);
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
