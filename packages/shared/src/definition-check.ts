import { ConditionEngine } from './conditions';
import type { FileTypeDefinition, LookupList } from './types';

/**
 * Sanity-check an administrator-edited file type definition before it is saved,
 * so a bad edit cannot break validation for submitters.
 */
export function checkFileTypeDefinition(def: FileTypeDefinition, lookups: LookupList[], fileTypeIds?: string[]): string[] {
  const problems: string[] = [];
  const lookupIds = new Set(lookups.map((l) => l.id));

  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(def.id)) problems.push('File type code must be 2-10 uppercase letters/digits, starting with a letter.');
  if (!def.name.trim()) problems.push('File type name is required.');
  if (def.columns.length === 0) problems.push('At least one column is required.');
  if (def.fileNamePattern !== undefined && def.fileNamePattern.trim() === '') problems.push('File name pattern cannot be empty (remove the file name rule instead).');
  if (def.fileNamePattern && /\{(?!ORG\}|TYPE\}|YYYYMMDD\}|YYMMDD\}|MMDDYYYY\}|ANY\}|X+\}|#+\})[^}]*\}/i.test(def.fileNamePattern)) {
    problems.push('File name pattern can only use the tokens {ORG}, {TYPE}, {YYYYMMDD}, {YYMMDD}, {MMDDYYYY}, {XXXX}, {####} and {ANY}.');
  }

  // Template settings
  const formats = def.formats ?? { csv: true, xlsx: true };
  if (!formats.csv && !formats.xlsx) problems.push('Allow at least one file format (CSV or Excel).');
  if (formats.csv && def.csv) {
    const d = def.csv.delimiter === '\\t' ? '\t' : def.csv.delimiter;
    if (!d || d.length !== 1) problems.push('CSV delimiter must be a single character (use \\t for tab).');
    if (d === '"' || d === "'" || d === '\n' || d === '\r') problems.push('CSV delimiter cannot be a quote or line break.');
    if (def.csv.quote !== 'none' && d === def.csv.quote) problems.push('CSV delimiter and quote character must be different.');
  }
  const isInt = (v: unknown) => Number.isInteger(v);
  const min = def.minRecords ?? 1;
  if (!isInt(min) || min < 1) problems.push('Minimum number of records must be a whole number of at least 1.');
  if (def.maxRecords !== undefined && (!isInt(def.maxRecords) || def.maxRecords < min)) problems.push('Maximum number of records cannot be less than the minimum (leave blank for no limit).');
  const headerRow = def.headerRow ?? 1;
  if (!isInt(headerRow) || headerRow < 1) problems.push('Header row number must be a whole number of at least 1.');
  const start = def.dataStartRow ?? headerRow + 1;
  if (!isInt(start) || start <= headerRow) problems.push('Records must start on a row after the header row.');

  const keys = new Set<string>();
  def.columns.forEach((c, i) => {
    const where = `Column ${i + 1} (${c.header || c.key || 'unnamed'})`;
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(c.key)) problems.push(`${where}: key must start with a letter and contain only letters, digits or _.`);
    if (keys.has(c.key)) problems.push(`${where}: key "${c.key}" is used more than once.`);
    keys.add(c.key);
    if (!c.header.trim()) problems.push(`${where}: header is required.`);
    if (c.pattern) {
      try {
        new RegExp(c.pattern);
      } catch {
        problems.push(`${where}: pattern is not a valid regular expression.`);
      }
    }
    if (c.lookupListId && !lookupIds.has(c.lookupListId)) problems.push(`${where}: lookup list "${c.lookupListId}" does not exist.`);
    if (c.fixedValue !== undefined && c.orgValue) problems.push(`${where}: choose either a fixed value or an organization value, not both.`);
    for (const n of ['minLength', 'maxLength', 'exactLength'] as const) {
      const v = c[n];
      if (v !== undefined && (!Number.isInteger(v) || v < 0)) problems.push(`${where}: ${n} must be a whole number.`);
    }
  });

  const engine = new ConditionEngine(def.columns);
  const needKey = (k: string, where: string) => {
    if (!keys.has(k)) problems.push(`${where}: refers to unknown column "${k}".`);
  };
  const ids = new Set<string>();
  for (const r of def.rowRules) {
    const where = `Rule ${'name' in r && r.name ? `"${r.name}"` : r.id}`;
    if (ids.has(r.id)) problems.push(`${where}: rule id is used more than once.`);
    ids.add(r.id);
    switch (r.type) {
      case 'conditional':
        if (r.then.length === 0 && (r.else ?? []).length === 0) problems.push(`${where}: add at least one THEN or ELSE action.`);
        engine.check(r.when, [...r.then, ...(r.else ?? [])]).forEach((p) => problems.push(`${where}: ${p}`));
        break;
      case 'requiredWhen':
        needKey(r.when.column, where);
        r.columns.forEach((k) => needKey(k, where));
        break;
      case 'patternWhen':
        needKey(r.when.column, where);
        needKey(r.column, where);
        try {
          new RegExp(r.pattern);
        } catch {
          problems.push(`${where}: pattern is not a valid regular expression.`);
        }
        break;
      case 'allOrNone':
      case 'atLeastOne':
      case 'equalColumns':
        r.columns.forEach((k) => needKey(k, where));
        break;
      case 'dateOrder':
        needKey(r.before, where);
        needKey(r.after, where);
        break;
    }
  }
  for (const r of def.fileRules) {
    const where = `File rule ${r.id}`;
    if (ids.has(r.id)) problems.push(`${where}: rule id is used more than once.`);
    ids.add(r.id);
    if (r.type === 'duplicateKey') {
      if (r.columns.length === 0) problems.push(`${where}: choose at least one key column.`);
      r.columns.forEach((k) => needKey(k, where));
    }
    if (r.type === 'existsInPrior') {
      needKey(r.column, where);
      if (!r.sourceColumn) problems.push(`${where}: choose the column to look up in previous files.`);
      if (fileTypeIds && r.sourceFileTypeId !== def.id && !fileTypeIds.includes(r.sourceFileTypeId)) problems.push(`${where}: file type "${r.sourceFileTypeId}" does not exist.`);
    }
  }
  return problems;
}
