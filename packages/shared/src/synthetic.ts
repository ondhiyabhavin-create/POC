/**
 * Synthetic (fake) test data generator. No real taxpayer information.
 * Deterministic for a given seed so samples and tests are reproducible.
 */
import { toCsv } from './csv';
import type { FileTypeDefinition, Organization } from './types';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['JAMES', 'MARY', 'ROBERT', 'PATRICIA', 'JOHN', 'JENNIFER', 'MICHAEL', 'LINDA', 'DAVID', 'ELIZABETH', 'BRIDNAY', 'TERRENCE', 'ODETTE', 'LUCIEN'];
const LAST = ['SMITH', 'JOHNSON', 'WILLIAMS', 'BROWN', 'BOUDREAUX', 'THIBODEAUX', 'LANDRY', 'HEBERT', 'GUIDRY', 'BROUSSARD', 'FONTENOT', 'LEBLANC'];
const BUSINESSES = ['Acme Crawfish LLC', 'Bayou Widgets Inc', 'Pelican Lawn Care', 'Magnolia Catering Co', 'Delta Test Supplies'];
const STREETS = ['LOST BAYOU CT', 'MAGNOLIA ST', 'CYPRESS AVE', 'PELICAN DR', 'LEVEE RD', 'OAK ALLEY LN'];
const CITIES: [string, string][] = [['HOUMA', '70360'], ['BATON ROUGE', '70801'], ['LAFAYETTE', '70501'], ['SHREVEPORT', '71101'], ['LAKE CHARLES', '70601'], ['MONROE', '71201']];
const DEBT_TYPES = ['Fine', 'Fee', 'Penalty', 'Tuition', 'Contract'];
const DESCRIPTIONS: [string, string][] = [
  ['Court Fines', 'Traffic citation fine and court costs'],
  ['Probation Fees', 'Unpaid supervised probation fees'],
  ['NSF Check', 'Returned check plus NSF fee'],
  ['Student Loan', 'Unpaid tuition balance'],
  ['Utility Balance', 'Final bill after service disconnect'],
];

const pad = (n: number, w: number) => String(n).padStart(w, '0');
const isoDate = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
};

export interface SyntheticRecord {
  [key: string]: string;
}

export function placementRecords(org: Organization, count: number, seed = 1): SyntheticRecord[] {
  const r = rng(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const out: SyntheticRecord[] = [];
  for (let i = 0; i < count; i++) {
    const business = r() < 0.2;
    const [city, zip] = pick(CITIES);
    const [shortDesc, longDesc] = pick(DESCRIPTIONS);
    const delinquency = addDays('2025-01-15', Math.floor(r() * 300));
    const letter = addDays(delinquency, 10);
    const finalized = addDays(letter, 61);
    const principal = (50 + Math.floor(r() * 250000) / 100).toFixed(2);
    const rec: SyntheticRecord = {
      ...org.attributes,
      odrDebtType: pick(DEBT_TYPES),
      agencyDebtId: `${org.code}${pad(100000 + i, 8)}`,
      debtorType: business ? 'C' : 'I',
      delinquencyDate: delinquency,
      finalizedDate: finalized,
      interestToDate: '9999-12-31',
      prescriptionExpirationDate: '9999-12-31',
      // 9xx-prefixed SSNs and 00- FEINs are never issued — clearly synthetic.
      ssn: business ? '' : `9${pad(Math.floor(r() * 1e8), 8)}`,
      fein: business ? `00${pad(Math.floor(r() * 1e7), 7)}` : '',
      businessName: business ? pick(BUSINESSES) : '',
      lastName: business ? '' : pick(LAST),
      firstName: business ? '' : pick(FIRST),
      address: `${100 + Math.floor(r() * 9000)} ${pick(STREETS)}`,
      city,
      state: 'LA',
      zipCode: zip,
      country: 'USA',
      addressType: 'M',
      debtShortDescription: shortDesc,
      debtLongDescription: `${longDesc} - Ref #${2020 + (i % 6)}-${pad(i + 1, 4)}`,
      c60DayLetterMailDate: letter,
      lineItemCode: 'Principal',
      lineItemIncurredDate: delinquency,
      lineItemAmount: principal,
    };
    if (!business && r() < 0.5) {
      rec.phone3Type = 'Cell';
      rec.cellAreaCode = '225';
      rec.cellPhoneNumber = pad(5550000 + Math.floor(r() * 9999), 7);
    }
    if (r() < 0.25) {
      rec.lineItemCode2 = 'ECA';
      rec.lineItemIncurredDate2 = addDays(finalized, 5);
      rec.lineItemAmount2 = '17.22';
    }
    out.push(rec);
  }
  return out;
}

export function recallRecords(org: Organization, placements: SyntheticRecord[], reasons: string[], seed = 2): SyntheticRecord[] {
  const r = rng(seed);
  return placements.map((p) => ({
    agencyName: org.attributes.agencyName ?? org.name,
    agencyDebtId: p.agencyDebtId,
    debtorType: p.debtorType === 'C' ? 'B' : 'I',
    ssn: p.ssn,
    fein: p.fein,
    businessName: p.businessName,
    lastName: p.lastName,
    firstName: p.firstName,
    recallDate: '2026-10-20',
    recallReasonCode: reasons[Math.floor(r() * reasons.length)],
  }));
}

const identity = (p: SyntheticRecord) => ({ ssn: p.ssn, fein: p.fein, businessName: p.businessName, lastName: p.lastName, firstName: p.firstName });

export function adjustmentRecords(org: Organization, placements: SyntheticRecord[], seed = 3): SyntheticRecord[] {
  const r = rng(seed);
  return placements.map((p) => {
    const decrease = r() < 0.5;
    const amount = (5 + Math.floor(r() * 20000) / 100).toFixed(2);
    return {
      agencyName: org.attributes.agencyName ?? org.name,
      agencyDebtId: p.agencyDebtId,
      ...identity(p),
      adjustmentDate: '2026-10-21',
      adjustmentAmount: decrease ? `-${amount}` : amount,
      adjustmentActivityCode: decrease ? 'Agency Decrease' : 'Agency Increase',
      adjustmentLineItem: ['Principal', 'Interest', 'Penalty', 'ODR Fee', 'Fine'][Math.floor(r() * 5)],
    };
  });
}

export function directPaymentRecords(org: Organization, placements: SyntheticRecord[], seed = 4): SyntheticRecord[] {
  const r = rng(seed);
  return placements.map((p) => {
    const amount = (10 + Math.floor(r() * 50000) / 100).toFixed(2);
    return {
      agencyName: org.attributes.agencyName ?? org.name,
      agencyDebtId: p.agencyDebtId,
      ...identity(p),
      paymentDate: '2026-10-22',
      paymentAmount: amount,
      paymentActivityCode: 'ADP',
      principalCodeName: 'PRINCIPAL',
      principalPostAmt: amount,
    };
  });
}

export function recordsToCsv(def: FileTypeDefinition, records: SyntheticRecord[]): string {
  return toCsv([def.columns.map((c) => c.header), ...records.map((rec) => def.columns.map((c) => rec[c.key] ?? ''))]);
}

/** Header-only template for a file type. */
export function templateCsv(def: FileTypeDefinition): string {
  return toCsv([def.columns.map((c) => c.header)]);
}

export function todayStamp(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`;
}
