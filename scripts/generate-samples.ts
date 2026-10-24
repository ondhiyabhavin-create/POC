/**
 * Writes synthetic sample files to ./samples for demos and manual testing.
 *   npm run samples
 * All data is fake (SSNs start with 9, FEINs with 00 — never issued).
 */
import fs from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import {
  ADJUSTMENT,
  DIRECT_PAYMENT,
  LOOKUPS,
  ORGANIZATIONS,
  PLACEMENT,
  RECALL,
  adjustmentRecords,
  directPaymentRecords,
  placementRecords,
  recallRecords,
  recordsToCsv,
  todayStamp,
  type FileTypeDefinition,
  type SyntheticRecord,
} from '@odr/shared';

const out = path.resolve(import.meta.dirname, '..', 'samples');
const date = todayStamp();
const [ccsv, bpu] = ORGANIZATIONS;
const reasons = LOOKUPS.find((l) => l.id === 'RECALL_REASON_CODES')!.values;

fs.rmSync(out, { recursive: true, force: true });
const write = (dir: string, name: string, body: string | Uint8Array, note: string) => {
  fs.mkdirSync(path.join(out, dir), { recursive: true });
  fs.writeFileSync(path.join(out, dir, name), body);
  console.log(`${dir}/${name}`.padEnd(50), note);
};

/** Minimal .xlsx writer: every cell as text (like a sheet formatted as Text), so leading zeros survive. */
function toXlsx(def: FileTypeDefinition, records: SyntheticRecord[]): Uint8Array {
  const rows = [def.columns.map((c) => c.header), ...records.map((r) => def.columns.map((c) => r[c.key] ?? ''))];
  const strings: string[] = [];
  const index = new Map<string, number>();
  const si = (v: string) => index.get(v) ?? (index.set(v, strings.push(v) - 1), strings.length - 1);
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const col = (i: number) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26));
  const sheet = rows
    .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (v === '' ? '' : `<c r="${col(ci)}${ri + 1}" t="s"><v>${si(v)}</v></c>`)).join('')}</row>`)
    .join('');
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
    ),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${def.name}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet ${ns}><sheetData>${sheet}</sheetData></worksheet>`),
    'xl/sharedStrings.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><sst ${ns} count="${strings.length}" uniqueCount="${strings.length}">${strings.map((x) => `<si><t xml:space="preserve">${esc(x)}</t></si>`).join('')}</sst>`),
  });
}

// ---- 1. Valid files ----
const placed = placementRecords(ccsv, 40, 11);
write('1-valid', `CCSV_PLC_${date}.csv`, recordsToCsv(PLACEMENT, placed), '40 clean placement records (City Court of Somewhereville)');
write('1-valid', `BPU_PLC_${date}.xlsx`, toXlsx(PLACEMENT, placementRecords(bpu, 15, 5)), '15 clean placement records as Excel (Bayou Parish Utilities)');
write('1-valid', `CCSV_REC_${date}.csv`, recordsToCsv(RECALL, recallRecords(ccsv, placed.slice(0, 8), reasons)), '8 recalls of debts placed above');
write('1-valid', `CCSV_ADJ_${date}.csv`, recordsToCsv(ADJUSTMENT, adjustmentRecords(ccsv, placed.slice(8, 16))), '8 adjustments to debts placed above');
write('1-valid', `CCSV_DPF_${date}.xlsx`, toXlsx(DIRECT_PAYMENT, directPaymentRecords(ccsv, placed.slice(16, 22))), '6 direct payments as Excel');

// ---- 2. Placement with typical errors ----
const bad = placementRecords(ccsv, 25, 21);
const set = (i: number, patch: Record<string, string>) => Object.assign(bad[i], patch);
set(0, { debtorType: 'I', ssn: '12345678', lastName: 'DOE', firstName: 'JANE', fein: '', businessName: '' }); // lost leading zero
set(1, { debtorType: 'I', ssn: '271-12-1212', lastName: 'ROE', firstName: 'JOHN', fein: '', businessName: '' }); // dashes
set(2, { agencyName: `${ccsv.attributes.agencyName} ` }); // trailing space on organization value
set(3, { louisianaTaxpayerNumberLtn: '2425125' }); // wrong organization value
set(4, { odrDebtType: 'Parking' }); // not an accepted debt type
set(5, { odrDebtType: 'fine' }); // wrong capitalization
set(6, { delinquencyDate: '03/15/2025' }); // Excel date format
set(7, { finalizedDate: '2025-02-30' }); // impossible date
set(8, { lineItemAmount: '$1,250.00' }); // currency formatting
set(9, { lineItemCode: 'Interest' }); // fixed value must be Principal
set(10, { address: '' }); // required field missing
set(11, { state: 'Louisiana' }); // not a 2-char code
set(12, { zipCode: '7036' }); // short zip (IF state is US THEN 5 digits)
set(13, { debtorType: 'C', ssn: '', lastName: '', firstName: '', fein: '', businessName: '' }); // ELSE branch: business needs FEIN + name
set(14, { lineItemCode2: 'ECA', lineItemIncurredDate2: '', lineItemAmount2: '' }); // ECA all-or-none
set(15, { phone1Type: 'Home', homeAreaCode: '22', homePhoneNumber: '5551234' }); // short area code
set(16, { emailAddress: 'not-an-email' }); // warning only
set(17, { agencyDebtId: bad[16].agencyDebtId }); // duplicate debt ID (warning)
set(18, { delinquencyDate: '2025-09-01', finalizedDate: '2025-06-01' }); // date order (warning)
bad[19] = { ...bad[20] }; // exact duplicate record
set(21, { agencyDebtId: 'A-VERY-LONG-DEBT-IDENTIFIER-123' }); // > 22 chars
set(22, { c60DayLetterMailDate: bad[22].finalizedDate }); // formula rule: 60-day wait (warning)
write('2-with-errors', `CCSV_PLC_${date}.csv`, recordsToCsv(PLACEMENT, bad), '25 placement records with ~22 typical errors & warnings');

// ---- Recall with errors ----
const recBad = recallRecords(ccsv, placed.slice(0, 10), reasons);
recBad[0].recallReasonCode = 'Closed-Recall-Bankrupt';
recBad[1].recallReasonCode = 'Closed - Recall - Bankruptcy';
recBad[2].recallDate = '10/20/2026';
recBad[3].agencyDebtId = 'CCSV99999999'; // never placed (warning)
recBad[4].debtorType = 'C';
Object.assign(recBad[5], { debtorType: 'I', ssn: '', lastName: '' });
write('2-with-errors', `CCSV_REC_${date}.csv`, recordsToCsv(RECALL, recBad), '10 recall records with reason-code, date and identity errors');

// ---- Adjustment / Direct payment with errors ----
const adjBad = adjustmentRecords(ccsv, placed.slice(0, 6));
Object.assign(adjBad[0], { adjustmentActivityCode: 'Agency Decrease', adjustmentAmount: '25.00' }); // sign mismatch (warning)
Object.assign(adjBad[1], { adjustmentAmount: '1,200.00' }); // commas
Object.assign(adjBad[2], { adjustmentLineItem: 'Fees' }); // not an allowed line item
adjBad[3] = { ...adjBad[4] }; // same debt + line item twice
write('2-with-errors', `CCSV_ADJ_${date}.csv`, recordsToCsv(ADJUSTMENT, adjBad), '6 adjustments: sign, commas, line item, duplicates');
const dpfBad = directPaymentRecords(ccsv, placed.slice(0, 5));
dpfBad[0].principalCodeName = 'Principal'; // must be PRINCIPAL
dpfBad[1].principalPostAmt = '1.00'; // I and L must match
dpfBad[2].paymentActivityCode = 'APD';
dpfBad[3].paymentDate = '2099-01-01'; // future date (formula rule)
write('2-with-errors', `CCSV_DPF_${date}.xlsx`, toXlsx(DIRECT_PAYMENT, dpfBad), '5 direct payments (Excel): fixed values, amounts, future date');

// ---- 3. Structural problems ----
const structural = recordsToCsv(PLACEMENT, placementRecords(ccsv, 5, 31))
  .split('\r\n')
  .map((l) => l.split(',').filter((_, i) => i !== 18).join(',')) // delete column S (SSN)
  .join('\r\n');
write('3-structural', `CCSV_PLC_${date}.csv`, structural, 'Column S deleted -> layout rejected');
write('3-structural', `CCSV_Placement_${date}.csv`, recordsToCsv(PLACEMENT, placementRecords(ccsv, 3, 41)), 'Bad file name (naming convention)');

// ---- 4. Files to try the column importer with ----
write('4-import', 'sample-data-for-import.csv', recordsToCsv(ADJUSTMENT, adjustmentRecords(ccsv, placementRecords(ccsv, 30, 51))), 'Sample data: Admin › Validation rules › New file type from spreadsheet');
