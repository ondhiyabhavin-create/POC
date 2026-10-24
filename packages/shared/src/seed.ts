/**
 * Starter data: example rule sets, lookup lists and synthetic organizations.
 *
 * The four ODR file types below were produced with the spreadsheet importer
 * (Admin › Validation rules › Import columns) from ODR Attachments D, E, H and I,
 * then reviewed and given IF/THEN rules. Nothing in the engine depends on them —
 * administrators can edit or delete them and create entirely different file types.
 * Assumptions that need SME confirmation are marked "ASSUMPTION".
 */
import { columnLetter } from './csv';
import type { ColumnDefinition, ConditionGroup, FileTypeDefinition, LookupList, Organization, RowRule } from './types';

type ColumnSeed = Omit<ColumnDefinition, 'letter'>;
const withLetters = (cols: ColumnSeed[]): ColumnDefinition[] => cols.map((c, i) => ({ ...c, letter: columnLetter(i) }));

const SEED_TIME = '2026-10-24T00:00:00.000Z';
const PATTERN = '{ORG}_{TYPE}_{YYYYMMDD}.csv';
const LEADING_ZERO_HINT = 'Tip: format this column as Text in Excel so leading zeros are kept.';

const always = (): ConditionGroup => ({ kind: 'group', op: 'and', items: [] });
const eq = (column: string, value: string): ConditionGroup => ({
  kind: 'group',
  op: 'and',
  items: [{ kind: 'condition', left: { kind: 'column', column }, operator: 'equals', right: { kind: 'value', value } }],
});
const req = (...cols: string[]) => cols.map((column) => ({ column, check: 'required' as const }));

/** Organization-specific columns A–H shared by ODR files (values come from each organization's profile). */
const orgCol = (key: string, header: string, description: string, dataType: ColumnSeed['dataType'] = 'numeric'): ColumnSeed => ({
  key,
  header,
  dataType,
  required: true,
  orgValue: key,
  description,
});

const identityColumns = (debtorTypes?: string[]): ColumnSeed[] => [
  ...(debtorTypes ? [{ key: 'debtorType', header: 'Debtor Type', dataType: 'varchar' as const, required: true, allowedValues: debtorTypes, description: 'Individual or Business' }] : []),
  { key: 'ssn', header: 'SSN', dataType: 'numeric', required: false, exactLength: 9, description: '9 digits, leading zeros, no dashes', hint: `Example: 001234567. ${LEADING_ZERO_HINT}` },
  { key: 'fein', header: 'FEIN', dataType: 'numeric', required: false, exactLength: 9, description: '9 digits, leading zeros, no dashes', hint: LEADING_ZERO_HINT },
  { key: 'businessName', header: 'Business Name', dataType: 'varchar', required: false },
  { key: 'lastName', header: 'Last Name', dataType: 'varchar', required: false },
  { key: 'firstName', header: 'First Name', dataType: 'varchar', required: false },
];

/** IF Debtor Type = "I" THEN SSN, Last, First required ELSE FEIN, Business Name required. */
const identityRule = (id: string, individualCode = 'I'): RowRule => ({
  id,
  type: 'conditional',
  name: 'Identity fields by debtor type',
  description: 'ASSUMPTION: the spec marks SSN and FEIN both required; in practice individuals need SSN and names, businesses need FEIN and business name.',
  when: eq('debtorType', individualCode),
  then: req('ssn', 'lastName', 'firstName'),
  else: req('fein', 'businessName'),
  severity: 'error',
});

/** Files without a Debtor Type column: no business identifiers → it's an individual. */
const identityByBlankBusiness = (id: string): RowRule => ({
  id,
  type: 'conditional',
  name: 'Individual vs business identity',
  description: 'Spec: "R (for Individual)" / "R (for Business)". If no business identifiers are given, the record is an individual.',
  when: {
    kind: 'group',
    op: 'and',
    items: [
      { kind: 'condition', left: { kind: 'column', column: 'fein' }, operator: 'isBlank' },
      { kind: 'condition', left: { kind: 'column', column: 'businessName' }, operator: 'isBlank' },
    ],
  },
  then: req('lastName', 'firstName'),
  else: req('fein', 'businessName'),
  severity: 'error',
});

const placedBefore = (id: string): FileTypeDefinition['fileRules'][number] => ({
  id,
  type: 'existsInPrior',
  description: 'Debt should have been sent on a previously validated Placement file',
  column: 'agencyDebtId',
  sourceFileTypeId: 'PLC',
  sourceColumn: 'agencyDebtId',
  severity: 'warning',
});

const standardFileRules = (prefix: string): FileTypeDefinition['fileRules'] => [
  { id: `${prefix}.fileName`, type: 'fileName', description: 'File naming convention', severity: 'error' },
  { id: `${prefix}.notEmpty`, type: 'notEmpty', description: 'File must contain at least one record', severity: 'error' },
  { id: `${prefix}.duplicateRow`, type: 'duplicateRow', description: 'Exact duplicate records', severity: 'error' },
];

const phone = (n: string, typeHeader: string, typeValue: string, areaHeader: string, numHeader: string): ColumnSeed[] => {
  const k = typeValue.toLowerCase();
  return [
    { key: `phone${n}Type`, header: typeHeader, dataType: 'varchar', required: false, allowedValues: [typeValue] },
    { key: `${k}AreaCode`, header: areaHeader, dataType: 'int', required: false, exactLength: 3 },
    { key: k === 'fax' ? 'faxNumber' : `${k}PhoneNumber`, header: numHeader, dataType: 'numeric', required: false, exactLength: 7 },
  ];
};

export const PLACEMENT: FileTypeDefinition = {
  id: 'PLC',
  name: 'Placement',
  description: 'Places an accounts-receivable debt 60+ days past due with ODR for collection. One row per debt. (Attachment D)',
  active: true,
  headerMatch: 'relaxed',
  fileNamePattern: PATTERN,
  version: 1,
  updatedAt: SEED_TIME,
  updatedBy: 'seed',
  columns: withLetters([
    orgCol('agencyName', 'Agency Name', 'Hard coded with information provided from ODR', 'varchar'),
    orgCol('stateProgramCode', 'State Program Code', 'Contract code'),
    orgCol('stateFundingCode', 'State Funding Code', 'Department number'),
    orgCol('agencyId', 'Agency ID', 'Department finance group'),
    orgCol('louisianaTaxpayerNumberLtn', 'Louisiana Taxpayer Number (LTN)', 'Assigned through LaTAP'),
    orgCol('latogaAgencyCode', 'LATOGA Agency Code', 'Agency code assigned by LATOGA'),
    orgCol('latogaProgramCode', 'LATOGA Program Code', 'Program code assigned by LATOGA'),
    orgCol('latogaRegionCode', 'LATOGA Region Code', 'Region code assigned by LATOGA'),
    { key: 'odrDebtType', header: 'ODR Debt Type', dataType: 'varchar', required: true, lookupListId: 'DEBT_TYPES' },
    { key: 'agencyDebtId', header: 'Agency Debt ID', dataType: 'varchar', required: true, maxLength: 22, description: 'Unique ID assigned by agency to debt' },
    { key: 'debtorType', header: 'Debtor Type', dataType: 'varchar', required: true, allowedValues: ['I', 'C'], description: '"I" (Individual) or "C" (Corporate/Business)' },
    { key: 'delinquencyDate', header: 'Delinquency Date', dataType: 'date', required: true },
    { key: 'finalizedDate', header: 'Finalized Date', dataType: 'date', required: true },
    { key: 'interestRate', header: 'Interest Rate', dataType: 'numeric', required: false, description: 'Assumed decimal point (6 from the right)' },
    { key: 'interestType', header: 'Interest Type', dataType: 'varchar', required: false },
    { key: 'interestToDate', header: 'Interest To Date', dataType: 'date', required: false, description: 'Default 9999-12-31' },
    { key: 'prescriptionExpirationDate', header: 'Prescription/Expiration Date', dataType: 'date', required: false, description: 'Default 9999-12-31' },
    { key: 'prescriptionAmount', header: 'Prescription Amount', dataType: 'money', required: false },
    identityColumns()[0],
    identityColumns()[1],
    { key: 'driversLicenseNumber', header: 'Drivers License Number', dataType: 'numeric', required: false },
    { key: 'driversLicenseState', header: 'Drivers License State', dataType: 'varchar', required: false, lookupListId: 'US_STATES' },
    { key: 'businessName', header: 'Business Name', dataType: 'varchar', required: false },
    { key: 'fullName', header: 'Full Name', dataType: 'varchar', required: false },
    { key: 'lastName', header: 'Last Name', dataType: 'varchar', required: false },
    { key: 'firstName', header: 'First Name', dataType: 'varchar', required: false },
    { key: 'middleName', header: 'Middle Name', dataType: 'varchar', required: false },
    { key: 'suffix', header: 'Suffix', dataType: 'varchar', required: false },
    { key: 'dba', header: 'DBA', dataType: 'varchar', required: false },
    { key: 'address', header: 'Address', dataType: 'varchar', required: true },
    { key: 'address2', header: 'Address 2', dataType: 'varchar', required: false },
    { key: 'unitType', header: 'Unit Type', dataType: 'varchar', required: false },
    { key: 'unit', header: 'Unit', dataType: 'varchar', required: false },
    { key: 'city', header: 'City', dataType: 'varchar', required: true },
    { key: 'state', header: 'State', dataType: 'varchar', required: true, lookupListId: 'STATES_OR_FOREIGN', description: '2-character US state code or "Foreign Entity"' },
    { key: 'zipCode', header: 'Zip Code', dataType: 'varchar', required: true, description: 'USPS 5-digit zip code or foreign zip', hint: LEADING_ZERO_HINT },
    { key: 'country', header: 'Country', dataType: 'varchar', required: false, pattern: '[A-Z]{3}', patternMessage: 'must be a 3-letter country code (e.g. USA).' },
    { key: 'addressType', header: 'Address Type', dataType: 'varchar', required: false },
    { key: 'dateOfBirth', header: 'Date of Birth', dataType: 'date', required: false },
    ...phone('1', 'Phone1 Type', 'Home', 'Home Area Code', 'Home Phone Number'),
    ...phone('2', 'Phone2 Type', 'Business', 'Business Area Code', 'Business Phone Number'),
    ...phone('3', 'Phone3 Type', 'Cell', 'Cell Area Code', 'Cell Phone Number'),
    ...phone('4', 'Phone4 Type', 'Fax', 'Fax Area Code', 'Fax Number'),
    { key: 'emailAddress', header: 'Email Address', dataType: 'varchar', required: false, pattern: '[^@\\s]+@[^@\\s]+\\.[^@\\s]+', patternMessage: 'does not look like a valid email address.', severity: { pattern: 'warning' } },
    { key: 'debtShortDescription', header: 'Debt Short Description', dataType: 'varchar', required: true },
    { key: 'debtLongDescription', header: 'Debt Long Description', dataType: 'varchar', required: true },
    { key: 'c60DayLetterMailDate', header: '60 Day Letter Mail Date', dataType: 'date', required: true },
    { key: 'judgementDate', header: 'Judgement Date', dataType: 'date', required: false },
    { key: 'passbackInformation1', header: 'Passback Information 1', dataType: 'varchar', required: false },
    { key: 'passbackInformation2', header: 'Passback Information 2', dataType: 'varchar', required: false },
    { key: 'passbackInformation3', header: 'Passback Information 3', dataType: 'varchar', required: false },
    { key: 'passbackInformation4', header: 'Passback Information 4', dataType: 'varchar', required: false },
    { key: 'agencyLastPaymentDate', header: 'Agency Last Payment Date', dataType: 'date', required: false },
    { key: 'agencyLastPaymentAmt', header: 'Agency Last Payment Amt', dataType: 'money', required: false },
    { key: 'agencyFeesPriorToPlc', header: 'Agency Fees prior to plc', dataType: 'money', required: false },
    { key: 'feesByOcaEca', header: 'Fees by OCA + ECA', dataType: 'money', required: false },
    { key: 'lineItemCode', header: 'Line Item Code', dataType: 'varchar', required: true, fixedValue: 'Principal', description: 'Always "Principal"' },
    { key: 'lineItemIncurredDate', header: 'Line Item Incurred Date', dataType: 'date', required: true },
    { key: 'lineItemAmount', header: 'Line Item Amount', dataType: 'money', required: true },
    { key: 'lineItemCode2', header: 'Line Item Code', dataType: 'varchar', required: false, fixedValue: 'ECA', description: 'Only when a vendor (ECA) prepared the debt' },
    { key: 'lineItemIncurredDate2', header: 'Line Item Incurred Date', dataType: 'date', required: false },
    { key: 'lineItemAmount2', header: 'Line Item Amount', dataType: 'money', required: false },
  ]),
  rowRules: [
    identityRule('plc.identity'),
    {
      id: 'plc.usZip',
      type: 'conditional',
      name: 'US addresses need a 5-digit zip',
      when: { kind: 'group', op: 'and', items: [{ kind: 'condition', left: { kind: 'column', column: 'state' }, operator: 'notEquals', right: { kind: 'value', value: 'Foreign Entity' } }] },
      then: [{ column: 'zipCode', check: 'matches', value: { kind: 'value', value: '\\d{5}' }, message: 'Zip Code must be a 5-digit USPS zip code for US addresses.' }],
      severity: 'error',
    },
    { id: 'plc.ecaAllOrNone', type: 'allOrNone', description: 'BP, BQ, BR are only used together when a vendor (ECA) prepared the debt', columns: ['lineItemCode2', 'lineItemIncurredDate2', 'lineItemAmount2'], severity: 'error' },
    {
      id: 'plc.dateOrder',
      type: 'conditional',
      name: 'Finalized on or after delinquency',
      when: always(),
      then: [{ column: 'finalizedDate', check: 'gte', value: { kind: 'column', column: 'delinquencyDate' } }],
      severity: 'warning',
    },
    {
      id: 'plc.letterWait',
      type: 'conditional',
      name: '60-day letter waiting period',
      description: 'Formula example: debts are final about 61 days after the 60-day letter.',
      when: { kind: 'group', op: 'and', items: [{ kind: 'condition', left: { kind: 'formula', formula: 'ISDATE([BC]) AND ISDATE([M])' }, operator: 'isTrue' }] },
      then: [{ column: 'finalizedDate', check: 'formula', value: { kind: 'formula', formula: 'DAYS([M], [BC]) >= 60' }, message: 'Finalized Date should be at least 60 days after the 60 Day Letter Mail Date (column BC).' }],
      severity: 'warning',
    },
  ],
  fileRules: [...standardFileRules('plc'), { id: 'plc.duplicateDebtId', type: 'duplicateKey', description: 'Duplicate Agency Debt IDs within the file', columns: ['agencyDebtId'], severity: 'warning' }],
};

export const RECALL: FileTypeDefinition = {
  id: 'REC',
  name: 'Recall',
  description: 'Recalls previously placed accounts that are no longer collectible. (Attachment E)',
  active: true,
  headerMatch: 'relaxed',
  fileNamePattern: PATTERN,
  version: 1,
  updatedAt: SEED_TIME,
  updatedBy: 'seed',
  columns: withLetters([
    orgCol('agencyName', 'Agency Name', 'Hard coded name provided by ODR (no trailing spaces)', 'varchar'),
    { key: 'agencyDebtId', header: 'Agency Debt ID', dataType: 'varchar', required: true, maxLength: 22 },
    // ASSUMPTION: Attachment E lists "I" or "B" (Placement uses "I" or "C").
    ...identityColumns(['I', 'B']),
    { key: 'recallDate', header: 'Recall Date', dataType: 'date', required: true },
    { key: 'recallReasonCode', header: 'Recall Reason Code', dataType: 'varchar', required: true, lookupListId: 'RECALL_REASON_CODES' },
  ]),
  rowRules: [identityRule('rec.identity')],
  fileRules: [...standardFileRules('rec'), { id: 'rec.duplicateDebtId', type: 'duplicateKey', description: 'Same debt recalled twice in one file', columns: ['agencyDebtId'], severity: 'warning' }, placedBefore('rec.placed')],
};

export const ADJUSTMENT: FileTypeDefinition = {
  id: 'ADJ',
  name: 'Adjustment',
  description: 'Informs ODR of balance adjustments to placed accounts. One record per line item. (Attachment H)',
  active: true,
  headerMatch: 'relaxed',
  fileNamePattern: PATTERN,
  version: 1,
  updatedAt: SEED_TIME,
  updatedBy: 'seed',
  columns: withLetters([
    orgCol('agencyName', 'Agency Name', 'Hard coded with information provided from ODR', 'varchar'),
    { key: 'agencyDebtId', header: 'Agency Debt ID', dataType: 'varchar', required: true },
    ...identityColumns(),
    { key: 'adjustmentDate', header: 'Adjustment Date', dataType: 'date', required: true },
    { key: 'adjustmentAmount', header: 'Adjustment Amount', dataType: 'money', required: true, allowNegative: true, description: '###.## with "-" for negative adjustments, no commas' },
    { key: 'adjustmentActivityCode', header: 'Adjustment Activity Code', dataType: 'varchar', required: true, allowedValues: ['Agency Increase', 'Agency Decrease'] },
    { key: 'adjustmentLineItem', header: 'Adjustment Line Item', dataType: 'varchar', required: true, allowedValues: ['Principal', 'Interest', 'Penalty', 'ODR Fee', 'Fine'] },
  ]),
  rowRules: [
    identityByBlankBusiness('adj.identity'),
    {
      id: 'adj.sign',
      type: 'conditional',
      name: 'Amount sign matches activity code',
      description: 'ASSUMPTION: decreases are sent as negative amounts, increases as positive.',
      when: eq('adjustmentActivityCode', 'Agency Decrease'),
      then: [{ column: 'adjustmentAmount', check: 'lt', value: { kind: 'value', value: '0' }, message: 'Adjustment Amount must be negative (start with "-") for an Agency Decrease.' }],
      else: [{ column: 'adjustmentAmount', check: 'gt', value: { kind: 'value', value: '0' }, message: 'Adjustment Amount must be positive (no sign) for an Agency Increase.' }],
      severity: 'warning',
    },
  ],
  fileRules: [
    ...standardFileRules('adj'),
    { id: 'adj.oneLinePerItem', type: 'duplicateKey', description: 'Each line item for a debt must be its own record', columns: ['agencyDebtId', 'adjustmentLineItem'], severity: 'warning' },
    placedBefore('adj.placed'),
  ],
};

export const DIRECT_PAYMENT: FileTypeDefinition = {
  id: 'DPF',
  name: 'Direct Payment',
  description: 'Informs ODR of payments made directly to the agency. One row per payment. (Attachment I)',
  active: true,
  headerMatch: 'relaxed',
  fileNamePattern: PATTERN,
  version: 1,
  updatedAt: SEED_TIME,
  updatedBy: 'seed',
  columns: withLetters([
    orgCol('agencyName', 'Agency Name', 'Hard coded name provided by ODR', 'varchar'),
    { key: 'agencyDebtId', header: 'Agency Debt ID', dataType: 'varchar', required: true },
    ...identityColumns(),
    { key: 'paymentDate', header: 'Payment Date', dataType: 'date', required: true },
    { key: 'paymentAmount', header: 'Payment Amount', dataType: 'money', required: true, description: '999.99 — no assumed decimal, no sign' },
    { key: 'paymentActivityCode', header: 'Payment Activity Code', dataType: 'varchar', required: true, fixedValue: 'ADP' },
    // ASSUMPTION: spec text says "Principal"; the example row and BRD say "PRINCIPAL".
    { key: 'principalCodeName', header: 'Principal Code Name', dataType: 'varchar', required: true, fixedValue: 'PRINCIPAL' },
    { key: 'principalPostAmt', header: 'Principal Post Amt', dataType: 'money', required: true },
  ]),
  rowRules: [
    identityByBlankBusiness('dpf.identity'),
    { id: 'dpf.sameAmount', type: 'equalColumns', description: 'Columns I and L must contain the same value', columns: ['paymentAmount', 'principalPostAmt'], severity: 'error' },
    {
      id: 'dpf.positive',
      type: 'conditional',
      name: 'Payment must be greater than zero',
      when: always(),
      then: [{ column: 'paymentAmount', check: 'gt', value: { kind: 'value', value: '0' } }],
      severity: 'error',
    },
    {
      id: 'dpf.notFuture',
      type: 'conditional',
      name: 'Payment date not in the future',
      when: always(),
      then: [{ column: 'paymentDate', check: 'formula', value: { kind: 'formula', formula: '[H] <= TODAY()' }, message: 'Payment Date cannot be in the future.' }],
      severity: 'error',
    },
  ],
  fileRules: [...standardFileRules('dpf'), placedBefore('dpf.placed')],
};

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'AS', 'GU', 'MP', 'PR', 'VI', 'AA', 'AE', 'AP',
];

export const LOOKUPS: LookupList[] = [
  {
    id: 'DEBT_TYPES',
    name: 'ODR Debt Types',
    // ASSUMPTION: Attachment D list. The BRD lists Fine, Fee, Open Account, Installment, Contractual, Tax.
    description: 'Accepted values for Placement column I (Attachment D).',
    values: ['Fine', 'Fee', 'Penalty', 'Payroll', 'Tuition', 'Contract', 'Tax'],
    updatedAt: SEED_TIME,
  },
  {
    id: 'RECALL_REASON_CODES',
    name: 'Recall Reason Codes',
    description: 'The 7 approved recall reason codes (Attachment E). Must match exactly, including spaces and dashes.',
    values: ['Closed - Recall - Bankrupt', 'Closed - Recall - Deceased', 'Closed - Recall - Error', 'Closed - Recall - Incarcerated', 'Closed - Recall - Write Off', 'Closed - Recall - SIF', 'Closed - Recall - Military'],
    updatedAt: SEED_TIME,
  },
  { id: 'US_STATES', name: 'US State Codes', description: '2-character USPS state, territory and military codes.', values: US_STATES, updatedAt: SEED_TIME },
  { id: 'STATES_OR_FOREIGN', name: 'US State Codes or Foreign Entity', description: 'A USPS code or "Foreign Entity".', values: [...US_STATES, 'Foreign Entity'], updatedAt: SEED_TIME },
];

/** Attribute keys used by the ODR file types' organization-specific columns. */
export const ODR_ATTRIBUTE_KEYS = [
  'agencyName',
  'stateProgramCode',
  'stateFundingCode',
  'agencyId',
  'louisianaTaxpayerNumberLtn',
  'latogaAgencyCode',
  'latogaProgramCode',
  'latogaRegionCode',
] as const;

const odrAttrs = (values: string[]) => Object.fromEntries(ODR_ATTRIBUTE_KEYS.map((k, i) => [k, values[i]]));

/** Synthetic organizations — not real ODR-assigned values. */
export const ORGANIZATIONS: Organization[] = [
  { id: 'CCSV', code: 'CCSV', name: 'City Court of Somewhereville', active: true, attributes: odrAttrs(['City Court of Somewhereville', '40', '888', 'NBV3', '2425124', '4', '154', '110']) },
  { id: 'BPU', code: 'BPU', name: 'Bayou Parish Utilities', active: true, attributes: odrAttrs(['Bayou Parish Utilities', '52', '412', '7710', '3390018', '12', '208', '300']) },
  { id: 'DOE', code: 'DOE', name: 'Department of Examples', active: true, attributes: odrAttrs(['Department of Examples', '17', '105', '0042', '1100457', '9', '031', '120']) },
];

export const FILE_TYPES: FileTypeDefinition[] = [PLACEMENT, RECALL, ADJUSTMENT, DIRECT_PAYMENT];
