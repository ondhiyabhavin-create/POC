import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  ADJUSTMENT,
  DIRECT_PAYMENT,
  LOOKUPS,
  ORGANIZATIONS,
  PLACEMENT,
  RECALL,
  adjustmentRecords,
  analyzeCsvText,
  analyzeWorkbook,
  checkFileTypeDefinition,
  compileFormula,
  directPaymentRecords,
  evaluate,
  parseCsv,
  placementRecords,
  readXlsx,
  recallRecords,
  recordsToCsv,
  validateBytes,
  validateFile,
  type FileTypeDefinition,
  type RowRule,
  type SyntheticRecord,
  type ValidationContext,
} from '../src';

const org = ORGANIZATIONS[0];
const lookups = Object.fromEntries(LOOKUPS.map((l) => [l.id, l]));
const reasons = lookups.RECALL_REASON_CODES.values;
const ctx = (fileType: FileTypeDefinition, extra: Partial<ValidationContext> = {}): ValidationContext => ({
  fileType,
  organization: org,
  lookups,
  fileName: `${org.code}_${fileType.id}_20261024.csv`,
  ...extra,
});
const plc = (mutate?: (rows: SyntheticRecord[]) => void, n = 5) => {
  const rows = placementRecords(org, n, 7);
  mutate?.(rows);
  return recordsToCsv(PLACEMENT, rows);
};

describe('csv parser', () => {
  it('handles quotes, embedded commas, CRLF and BOM', () => {
    const p = parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n');
    expect(p.hadBom).toBe(true);
    expect(p.rows).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
  });
  it('keeps leading zeros and whitespace untouched', () => {
    expect(parseCsv('001234567, x \n').rows[0]).toEqual(['001234567', ' x ']);
  });
});

describe('formulas', () => {
  const cols = PLACEMENT.columns;
  const row = (patch: Record<string, string>) => cols.map((c) => patch[c.key] ?? '');
  const run = (f: string, patch: Record<string, string> = {}) => {
    const c = compileFormula(f, cols);
    if (!c.ok) throw new Error(c.error);
    return evaluate(c, row(patch));
  };
  it('references columns by letter, key or header and does arithmetic', () => {
    expect(run('[BJ] + [BK] > 100', { agencyLastPaymentAmt: '60', agencyFeesPriorToPlc: '50.5' })).toBe(true);
    expect(run('[agencyLastPaymentAmt] + [Agency Fees prior to plc]', { agencyLastPaymentAmt: '1.1', agencyFeesPriorToPlc: '2.2' })).toBe(3.3);
    expect(run('[BJ] + [BK] > 100', {})).toBe(false); // blanks count as 0
  });
  it('supports AND/OR/NOT, IF and text/date functions', () => {
    expect(run('[Debtor Type] = "I" AND LEN([SSN]) <> 9', { debtorType: 'I', ssn: '1234' })).toBe(true);
    expect(run('NOT ISBLANK([FEIN]) OR [K] = "C"', { debtorType: 'C' })).toBe(true);
    expect(run('IF([K] = "I", [S], [T])', { debtorType: 'C', fein: '001234567' })).toBe('001234567');
    expect(run('DAYS([M], [L])', { delinquencyDate: '2025-01-01', finalizedDate: '2025-03-02' })).toBe(60);
    expect(run('MATCHES([AJ], "\\d{5}")', { zipCode: '70360' })).toBe(true);
    expect(run('IN([I], "Fine", "Fee")', { odrDebtType: 'Fee' })).toBe(true);
  });
  it('reports helpful compile errors', () => {
    expect(compileFormula('[Nope] > 1', cols)).toMatchObject({ ok: false, error: expect.stringContaining('Unknown column [Nope]') });
    expect(compileFormula('FOO([A])', cols)).toMatchObject({ ok: false, error: expect.stringContaining('Unknown function FOO()') });
    expect(compileFormula('[A] = "x', cols)).toMatchObject({ ok: false, error: expect.stringContaining('closing quote') });
    expect(compileFormula('LEN([A], 2)', cols)).toMatchObject({ ok: false, error: expect.stringContaining('takes 1 argument') });
    expect(compileFormula('Debtor = 1', cols)).toMatchObject({ ok: false, error: expect.stringContaining('Wrap column names in [ ]') });
  });
});

describe('placement', () => {
  it('passes a clean synthetic file', () => {
    const res = validateFile(plc(undefined, 50), ctx(PLACEMENT));
    expect(res.issues).toEqual([]);
    expect(res.summary).toMatchObject({ status: 'passed', totalRecords: 50, recordsPassed: 50, recordsWithErrors: 0 });
  });

  it('reports exact row/column/value for a short SSN (lost leading zeros)', () => {
    const res = validateFile(plc((r) => Object.assign(r[0], { debtorType: 'I', ssn: '12345678', lastName: 'X', firstName: 'Y' })), ctx(PLACEMENT));
    const issue = res.issues.find((i) => i.column === 'S');
    expect(issue).toMatchObject({ row: 2, field: 'SSN', value: '12345678', category: 'Length', severity: 'error' });
    expect(issue!.message).toContain('Row 2, Column S (SSN)');
    expect(issue!.message).toContain('Leading zeros');
  });

  it('enforces organization values exactly, including trailing spaces', () => {
    const res = validateFile(plc((r) => { r[0].agencyName = `${org.attributes.agencyName} `; r[1].louisianaTaxpayerNumberLtn = '999'; }), ctx(PLACEMENT));
    const a = res.issues.find((i) => i.column === 'A');
    expect(a?.category).toBe('Fixed Value');
    expect(a?.message).toContain('trailing spaces');
    expect(res.issues.find((i) => i.column === 'E')?.row).toBe(3);
  });

  it('skips organization checks when the submitter has no organization', () => {
    const res = validateFile(plc(), ctx(PLACEMENT, { organization: undefined, fileName: 'ANYONE_PLC_20261024.csv' }));
    expect(res.issues).toEqual([]);
  });

  it('validates dates, money, lookups and fixed values', () => {
    const res = validateFile(
      plc((r) => {
        r[0].delinquencyDate = '01/15/2025';
        r[1].finalizedDate = '2025-02-30';
        r[2].lineItemAmount = '$1,200.00';
        r[3].odrDebtType = 'fine';
        r[4].lineItemCode = 'Interest';
      }),
      ctx(PLACEMENT),
    );
    const byCol = (c: string) => res.issues.find((i) => i.column === c)!;
    expect(byCol('L').message).toContain('MM/DD/YYYY');
    expect(byCol('M').message).toContain('does not exist');
    expect(byCol('BO').message).toContain('Remove dollar signs');
    expect(byCol('I').message).toContain('Did you mean "Fine"');
    expect(byCol('BM').category).toBe('Fixed Value');
  });

  it('applies IF/THEN/ELSE identity rule, US zip rule and ECA all-or-none', () => {
    const res = validateFile(
      plc((r) => {
        Object.assign(r[0], { debtorType: 'I', ssn: '', lastName: 'DOE', firstName: 'JANE', fein: '', businessName: '' });
        Object.assign(r[1], { debtorType: 'C', fein: '', businessName: '', ssn: '', lastName: '', firstName: '' });
        r[2].zipCode = '7036';
        Object.assign(r[3], { lineItemCode2: 'ECA', lineItemIncurredDate2: '', lineItemAmount2: '' });
      }),
      ctx(PLACEMENT),
    );
    const s = res.issues.find((i) => i.row === 2 && i.column === 'S')!;
    expect(s.message).toContain('SSN is required when Debtor Type (K) equals "I"');
    expect(res.issues.filter((i) => i.row === 3 && i.ruleId === 'plc.identity').map((i) => i.column)).toEqual(['T', 'W']);
    expect(res.issues.find((i) => i.row === 3 && i.column === 'T')!.message).toContain('unless Debtor Type (K) equals "I"');
    expect(res.issues.find((i) => i.row === 4 && i.column === 'AJ')!.message).toContain('5-digit');
    expect(res.issues.filter((i) => i.row === 5 && i.category === 'Cross-Field').map((i) => i.column)).toEqual(['BQ', 'BR']);
  });

  it('runs formula rules (60-day letter wait) as warnings', () => {
    const res = validateFile(plc((r) => { r[0].c60DayLetterMailDate = r[0].finalizedDate; }), ctx(PLACEMENT));
    expect(res.issues.find((i) => i.ruleId === 'plc.letterWait')).toMatchObject({ severity: 'warning', column: 'M' });
  });

  it('warns on duplicate debt IDs and errors on duplicate rows', () => {
    const res = validateFile(plc((r) => { r[1].agencyDebtId = r[0].agencyDebtId; r[4] = { ...r[3] }; }), ctx(PLACEMENT));
    expect(res.issues.find((i) => i.ruleId === 'plc.duplicateDebtId')).toMatchObject({ severity: 'warning', row: 3 });
    expect(res.issues.find((i) => i.ruleId === 'plc.duplicateRow')).toMatchObject({ severity: 'error', row: 6 });
  });

  it('detects missing columns and stops row validation', () => {
    const lines = plc().split('\r\n').map((l) => l.split(',').slice(0, -1).join(','));
    const res = validateFile(lines.join('\r\n'), ctx(PLACEMENT));
    expect(res.summary.structuralFailure).toBe(true);
    expect(res.issues).toHaveLength(2);
    expect(res.issues[1]).toMatchObject({ ruleId: 'structure.missingColumn', column: 'BR' });
  });

  it('checks the configurable file naming convention', () => {
    const bad = (fileName: string, def = PLACEMENT) => validateFile(plc(), ctx(def, { fileName })).issues.find((i) => i.category === 'File Name')?.message;
    expect(bad('CCSV_PLC_20261024.csv')).toBeUndefined();
    expect(bad('CCSV_PLC_20261024.xlsx')).toBeUndefined();
    expect(bad('placement.csv')).toContain('naming convention');
    expect(bad('BPU_PLC_20261024.csv')).toContain('organization code "CCSV"');
    expect(bad('CCSV_PLC_20261399.csv')).toContain('not a valid date');
    expect(bad('placement-2026.csv', { ...PLACEMENT, fileNamePattern: 'placement-{ANY}.csv' })).toBeUndefined();
  });
});

describe('recall / adjustment / direct payment', () => {
  const placed = placementRecords(org, 6, 3);
  const prior = { 'rec.placed': new Set(placed.map((p) => p.agencyDebtId)), 'adj.placed': new Set(placed.map((p) => p.agencyDebtId)), 'dpf.placed': new Set(placed.map((p) => p.agencyDebtId)) };

  it('clean files pass', () => {
    expect(validateFile(recordsToCsv(RECALL, recallRecords(org, placed, reasons)), ctx(RECALL, { priorValues: prior })).issues).toEqual([]);
    expect(validateFile(recordsToCsv(ADJUSTMENT, adjustmentRecords(org, placed)), ctx(ADJUSTMENT, { priorValues: prior })).issues).toEqual([]);
    expect(validateFile(recordsToCsv(DIRECT_PAYMENT, directPaymentRecords(org, placed)), ctx(DIRECT_PAYMENT, { priorValues: prior })).issues).toEqual([]);
  });

  it('requires exact recall reason codes and warns about unknown debts', () => {
    const rows = recallRecords(org, placed, reasons);
    rows[0].recallReasonCode = 'Closed-Recall-Bankrupt';
    const res = validateFile(recordsToCsv(RECALL, rows), ctx(RECALL, { priorValues: { 'rec.placed': new Set([placed[1].agencyDebtId]) } }));
    expect(res.issues.find((i) => i.column === 'J')!.message).toContain('Did you mean "Closed - Recall - Bankrupt"');
    expect(res.issues.filter((i) => i.category === 'Cross-File')).toHaveLength(5);
  });

  it('adjustment: sign must match activity code (IF/ELSE)', () => {
    const rows = adjustmentRecords(org, placed);
    Object.assign(rows[0], { adjustmentActivityCode: 'Agency Decrease', adjustmentAmount: '10.00' });
    Object.assign(rows[1], { adjustmentActivityCode: 'Agency Increase', adjustmentAmount: '-10.00' });
    const res = validateFile(recordsToCsv(ADJUSTMENT, rows), ctx(ADJUSTMENT));
    expect(res.issues.filter((i) => i.ruleId === 'adj.sign').map((i) => [i.row, i.message.includes('negative') ? 'neg' : 'pos'])).toEqual([[2, 'neg'], [3, 'pos']]);
  });

  it('direct payment: fixed values and equal amounts', () => {
    const rows = directPaymentRecords(org, placed);
    rows[0].principalCodeName = 'Principal';
    rows[1].principalPostAmt = '1.00';
    const res = validateFile(recordsToCsv(DIRECT_PAYMENT, rows), ctx(DIRECT_PAYMENT));
    expect(res.issues.find((i) => i.column === 'K')!.message).toContain('Check capitalization');
    expect(res.issues.find((i) => i.ruleId === 'dpf.sameAmount')).toMatchObject({ row: 3, column: 'L' });
  });
});

describe('conditional rules', () => {
  const def: FileTypeDefinition = {
    id: 'TST', name: 'Test', active: true, headerMatch: 'relaxed', version: 1, updatedAt: '',
    columns: ['A', 'B', 'C', 'D', 'E'].map((l) => ({ key: l.toLowerCase(), letter: l, header: `Col ${l}`, dataType: 'varchar' as const, required: false })),
    rowRules: [], fileRules: [],
  };
  const run = (rule: RowRule, rows: string[][]) =>
    validateFile(['Col A,Col B,Col C,Col D,Col E', ...rows.map((r) => r.join(','))].join('\n'), { fileType: { ...def, rowRules: [rule] }, lookups: {}, fileName: 'x.csv' }).issues;

  it('IF C is "Yes" THEN E required ELSE E must be blank', () => {
    const rule: RowRule = {
      id: 'r1', type: 'conditional', severity: 'error',
      when: { kind: 'group', op: 'and', items: [{ kind: 'condition', left: { kind: 'column', column: 'c' }, operator: 'equals', right: { kind: 'value', value: 'Yes' } }] },
      then: [{ column: 'e', check: 'required' }],
      else: [{ column: 'e', check: 'blank' }],
    };
    const issues = run(rule, [['', '', 'Yes', '', ''], ['', '', 'Yes', '', 'x'], ['', '', 'No', '', 'x'], ['', '', 'No', '', '']]);
    expect(issues.map((i) => [i.row, i.column, i.message])).toEqual([
      [2, 'E', 'Row 2, Column E (Col E): Col E is required when Col C (C) equals "Yes". Current value: (blank).'],
      [4, 'E', 'Row 4, Column E (Col E): Col E must be blank unless Col C (C) equals "Yes". Current value: "x".'],
    ]);
  });

  it('IF C + D > 100 (formula) with nested OR group', () => {
    const rule: RowRule = {
      id: 'r2', type: 'conditional', severity: 'warning',
      when: {
        kind: 'group', op: 'or', items: [
          { kind: 'condition', left: { kind: 'formula', formula: '[C] + [D]' }, operator: 'gt', right: { kind: 'value', value: '100' } },
          { kind: 'group', op: 'and', items: [
            { kind: 'condition', left: { kind: 'column', column: 'a' }, operator: 'in', right: { kind: 'value', value: 'X, Y' } },
            { kind: 'condition', left: { kind: 'column', column: 'b' }, operator: 'isNotBlank' },
          ] },
        ],
      },
      then: [{ column: 'e', check: 'equals', value: { kind: 'value', value: 'REVIEW' } }],
    };
    const issues = run(rule, [['', '', '60', '50', ''], ['', '', '10', '20', ''], ['Y', 'b', '', '', 'REVIEW'], ['X', 'b', '', '', 'no']]);
    expect(issues.map((i) => i.row)).toEqual([2, 5]);
    expect(issues[0].message).toContain('[C] + [D] is greater than "100" or (Col A (A) is one of "X", "Y" and Col B (B) is not blank)');
  });

  it('misconfigured rules are skipped with one warning instead of crashing', () => {
    const rule: RowRule = { id: 'bad', type: 'conditional', severity: 'error', when: { kind: 'group', op: 'and', items: [] }, then: [{ column: 'e', check: 'formula', value: { kind: 'formula', formula: '[Z] > 1' } }] };
    const issues = run(rule, [['a', '', '', '', ''], ['b', '', '', '', '']]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('misconfigured');
    expect(checkFileTypeDefinition({ ...def, rowRules: [rule] }, [])[0]).toContain('Unknown column [Z]');
  });
});

/** Build a tiny .xlsx in memory (shared strings, a date-formatted cell, a number). */
function makeXlsx(sheets: { name: string; rows: (string | number | { date: number })[][] }[]): Uint8Array {
  const strings: string[] = [];
  const si = (v: string) => (strings.includes(v) ? strings.indexOf(v) : strings.push(v) - 1);
  const files: Record<string, Uint8Array> = {};
  sheets.forEach((s, n) => {
    const rows = s.rows
      .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
        const ref = `${String.fromCharCode(65 + ci)}${ri + 1}`;
        if (typeof v === 'object') return `<c r="${ref}" s="1"><v>${v.date}</v></c>`;
        if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
        return v === '' ? '' : `<c r="${ref}" t="s"><v>${si(v)}</v></c>`;
      }).join('')}</row>`)
      .join('');
    files[`xl/worksheets/sheet${n + 1}.xml`] = strToU8(`<worksheet><sheetData>${rows}</sheetData></worksheet>`);
  });
  files['xl/workbook.xml'] = strToU8(`<workbook xmlns:r="r"><sheets>${sheets.map((s, n) => `<sheet name="${s.name}" sheetId="${n + 1}" r:id="rId${n + 1}"/>`).join('')}</sheets></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = strToU8(`<Relationships>${sheets.map((_, n) => `<Relationship Id="rId${n + 1}" Target="worksheets/sheet${n + 1}.xml"/>`).join('')}</Relationships>`);
  files['xl/sharedStrings.xml'] = strToU8(`<sst>${strings.map((x) => `<si><t>${x.replace(/&/g, '&amp;')}</t></si>`).join('')}</sst>`);
  files['xl/styles.xml'] = strToU8('<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>');
  return zipSync(files);
}

describe('excel', () => {
  it('reads text, numbers and date cells', () => {
    const sheets = readXlsx(makeXlsx([{ name: 'Data', rows: [['Name', 'Amount', 'When'], ['001', 0.1 + 0.2, { date: 46319 }]] }]));
    expect(sheets[0].rows).toEqual([['Name', 'Amount', 'When'], ['001', '0.3', '2026-10-24']]);
  });

  it('validates an uploaded .xlsx like a CSV (short rows padded)', () => {
    const recs = recallRecords(org, placementRecords(org, 2, 1), reasons);
    const rows = [RECALL.columns.map((c) => c.header), ...recs.map((r) => RECALL.columns.map((c) => r[c.key] ?? ''))];
    rows[2][8] = '10/20/2026';
    const res = validateBytes(makeXlsx([{ name: 'Layout', rows }]), ctx(RECALL, { fileName: 'CCSV_REC_20261024.xlsx' }));
    expect(res.issues.map((i) => [i.row, i.column])).toEqual([[3, 'I']]);
  });
});

describe('import', () => {
  it('builds columns from a layout specification sheet', () => {
    const spec = [
      ['Payment File - Agency to ODR'],
      ['Field', 'Description', 'Datatype', 'Format', 'Required / Optional'],
      ['Agency Name', 'Account Type', 'VarChar', 'Hard coded Name will be provided', 'R'],
      ['SSN', "Debtor's SSN", 'Numeric', '######### - Leading Zeros -- No Dashes', 'R (for Individual)'],
      ['Debtor Type', 'Individual or Business', 'VarChar', '"I" or "B"', 'R'],
      ['Payment Date', 'Date paid', 'Date', 'CCYY-MM-DD', 'R'],
      ['Amount', 'Same as column F', 'Money', 'Format ###.## include the sign "-" for negative', 'R'],
      ['Code', 'Payment type', 'VarChar', 'Hard coded Payment Type = ADP', 'R'],
      ['Amount Copy', '', 'Money', '999.99', 'O'],
      [],
      [],
      ['FILE TYPE:  Payment File (PAY), comma separated value (.csv) file / PURPOSE:  Tell us about payments / NAMING CONVENTION: (example LDR_PAY_20160101.csv)'],
    ];
    const res = analyzeWorkbook([{ name: 'Spec', rows: spec.filter((r) => r.length), rowNumbers: spec.map((_, i) => i + 1).filter((i) => spec[i - 1].length) }], LOOKUPS);
    expect(res.kind).toBe('spec');
    expect(res.meta).toMatchObject({ id: 'PAY', name: 'Payment', fileNamePattern: '{ORG}_{TYPE}_{YYYYMMDD}.csv' });
    const by = Object.fromEntries(res.columns.map((c) => [c.key, c]));
    expect(by.agencyName).toMatchObject({ orgValue: 'agencyName', required: true });
    expect(by.ssn).toMatchObject({ dataType: 'numeric', exactLength: 9, required: false });
    expect(by.debtorType.allowedValues).toEqual(['I', 'B']);
    expect(by.paymentDate.dataType).toBe('date');
    expect(by.amount).toMatchObject({ dataType: 'money', allowNegative: true });
    expect(by.code.fixedValue).toBe('ADP');
    expect(res.rowRules).toHaveLength(1);
    expect(res.notes.join(' ')).toContain('Required only for Individual: SSN');
  });

  it('infers columns from a sample data file', () => {
    const csv = recordsToCsv(PLACEMENT, placementRecords(org, 30, 9));
    const res = analyzeCsvText(csv);
    expect(res.kind).toBe('data');
    expect(res.columns).toHaveLength(70);
    const by = Object.fromEntries(res.columns.map((c) => [c.letter, c]));
    expect(by.A).toMatchObject({ header: 'Agency Name', required: true });
    expect(by.L.dataType).toBe('date');
    expect(by.BO.dataType).toBe('money');
    expect(by.K.suggestedAllowed).toEqual(['C', 'I']);
  });
});

describe('definitions', () => {
  it('seed definitions are internally consistent', () => {
    for (const def of [PLACEMENT, RECALL, ADJUSTMENT, DIRECT_PAYMENT]) expect(checkFileTypeDefinition(def, LOOKUPS, ['PLC', 'REC', 'ADJ', 'DPF'])).toEqual([]);
    expect(PLACEMENT.columns).toHaveLength(70);
    expect(PLACEMENT.columns.at(-1)!.letter).toBe('BR');
    expect(RECALL.columns).toHaveLength(10);
    expect(ADJUSTMENT.columns).toHaveLength(11);
    expect(DIRECT_PAYMENT.columns).toHaveLength(12);
  });
});
