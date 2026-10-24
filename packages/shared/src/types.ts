/**
 * Core domain model for the generic file-intake validation engine.
 *
 * Every file type is described purely as data — a `FileTypeDefinition`.
 * The engine contains no file-type-specific code, so new types can be added
 * (by hand, or imported from a layout spreadsheet / sample file) without
 * changing the architecture.
 */

export type Severity = 'error' | 'warning';

export type DataType =
  | 'varchar' // any text
  | 'numeric' // digits only (leading zeros preserved)
  | 'int' // whole number
  | 'money' // 123 or 123.45 — no commas, no currency sign
  | 'date'; // CCYY-MM-DD and a real calendar date

export interface ColumnDefinition {
  /** Stable machine key, e.g. "ssn". */
  key: string;
  /** Spreadsheet column letter, e.g. "S". Derived from position. */
  letter: string;
  /** Expected header text in the first row of the file. */
  header: string;
  description?: string;
  dataType: DataType;
  required: boolean;
  minLength?: number;
  maxLength?: number;
  /** Exact length (e.g. SSN = 9). */
  exactLength?: number;
  /** Money columns: allow a leading "-" for negative amounts. */
  allowNegative?: boolean;
  /** Optional regex the trimmed value must fully match. */
  pattern?: string;
  /** Human-friendly description of `pattern` used in error messages. */
  patternMessage?: string;
  /** Allowed values supplied inline. Compared exactly (case & spacing). */
  allowedValues?: string[];
  /** Allowed values supplied by an administrator-managed lookup list. */
  lookupListId?: string;
  /** Value must equal this constant exactly (e.g. "ADP"). */
  fixedValue?: string;
  /** Value must equal the submitting organization's attribute with this key (exact, incl. spaces). */
  orgValue?: string;
  /** Values that are always accepted regardless of other checks (e.g. "9999-12-31"). */
  alwaysAllow?: string[];
  /** Extra guidance appended to messages for this column. */
  hint?: string;
  /** Override severities for individual checks on this column. */
  severity?: Partial<Record<ColumnCheck, Severity>>;
}

export type ColumnCheck = 'required' | 'dataType' | 'length' | 'pattern' | 'allowedValues' | 'fixedValue';

// ---------------------------------------------------------------------------
// Conditions (IF … AND/OR … THEN … ELSE …)
// ---------------------------------------------------------------------------

/** A value used in a condition or action: a column, a literal, or a formula. */
export type Operand =
  | { kind: 'column'; column: string }
  | { kind: 'value'; value: string }
  | { kind: 'formula'; formula: string };

export type CompareOperator =
  | 'equals'
  | 'notEquals'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'isBlank'
  | 'isNotBlank'
  | 'in'
  | 'notIn'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'matches'
  | 'isTrue'
  | 'isFalse';

export interface ConditionLeaf {
  kind: 'condition';
  left: Operand;
  operator: CompareOperator;
  /** Not used by isBlank / isNotBlank / isTrue / isFalse. For in/notIn: comma separated values. */
  right?: Operand;
}

export interface ConditionGroup {
  kind: 'group';
  /** "and" = all must be true, "or" = any must be true. */
  op: 'and' | 'or';
  /** Negate the whole group ("NOT (…)"). */
  not?: boolean;
  items: ConditionNode[];
}

export type ConditionNode = ConditionLeaf | ConditionGroup;

export type ActionCheck =
  | 'required'
  | 'blank'
  | 'equals'
  | 'notEquals'
  | 'oneOf'
  | 'notOneOf'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'matches'
  | 'minLength'
  | 'maxLength'
  | 'formula';

/** "Column X must …" — applied when a conditional rule's branch is taken. */
export interface RuleAction {
  column: string;
  check: ActionCheck;
  /** Comparison value / list (comma separated) / regex / formula, depending on `check`. */
  value?: Operand;
  /** Optional custom message. Placeholders: {column}, {header}, {value}, {row}. */
  message?: string;
}

/** Legacy single-condition shape used by the preset rules. */
export type ConditionOperator = 'equals' | 'notEquals' | 'in' | 'notIn' | 'isEmpty' | 'isNotEmpty';
export interface Condition {
  column: string;
  operator: ConditionOperator;
  value?: string | string[];
}

/** Row-level rules that look at more than one column. */
export type RowRule =
  | {
      id: string;
      type: 'conditional';
      name?: string;
      description?: string;
      /** Empty group (no items) = always applies. */
      when: ConditionGroup;
      then: RuleAction[];
      else?: RuleAction[];
      severity: Severity;
    }
  | {
      id: string;
      type: 'requiredWhen';
      description?: string;
      when: Condition;
      columns: string[];
      severity: Severity;
    }
  | {
      id: string;
      type: 'patternWhen';
      description?: string;
      when: Condition;
      column: string;
      pattern: string;
      patternMessage: string;
      severity: Severity;
    }
  | {
      id: string;
      type: 'allOrNone';
      description?: string;
      columns: string[];
      severity: Severity;
    }
  | {
      id: string;
      type: 'atLeastOne';
      description?: string;
      columns: string[];
      severity: Severity;
    }
  | {
      id: string;
      type: 'equalColumns';
      description?: string;
      columns: [string, string];
      severity: Severity;
    }
  | {
      id: string;
      type: 'dateOrder';
      description?: string;
      /** `before` must be on or before `after`. */
      before: string;
      after: string;
      severity: Severity;
    };

/** File-level rules evaluated across all rows (or against history). */
export type FileRule =
  | { id: string; type: 'duplicateKey'; description?: string; columns: string[]; severity: Severity }
  | { id: string; type: 'duplicateRow'; description?: string; severity: Severity }
  | { id: string; type: 'fileName'; description?: string; severity: Severity }
  | { id: string; type: 'notEmpty'; description?: string; severity: Severity }
  | {
      id: string;
      type: 'existsInPrior';
      description?: string;
      /** Column in this file whose values must exist… */
      column: string;
      /** …in this column of previously *passed* files of this type (same organization). */
      sourceFileTypeId: string;
      sourceColumn: string;
      severity: Severity;
    };

export interface FileTypeDefinition {
  /** Short code, e.g. "PLC". Usable in file names via {TYPE}. */
  id: string;
  name: string;
  description?: string;
  /** Inactive types are hidden from submitters. */
  active: boolean;
  columns: ColumnDefinition[];
  rowRules: RowRule[];
  fileRules: FileRule[];
  /** Header comparison: "strict" requires exact text, "relaxed" ignores case/punctuation/spacing. */
  headerMatch: 'strict' | 'relaxed';
  /**
   * File naming convention checked by the `fileName` rule.
   * Tokens: {ORG} {TYPE} {YYYYMMDD} {ANY}. Example: "{ORG}_{TYPE}_{YYYYMMDD}.csv".
   * A ".csv" pattern also accepts the same name ending in ".xlsx".
   */
  fileNamePattern?: string;
  version: number;
  updatedAt: string;
  updatedBy?: string;
}

export interface LookupList {
  id: string;
  name: string;
  description?: string;
  values: string[];
  updatedAt: string;
}

/**
 * Any organization that submits files (agency, vendor, department…).
 * Organizations are optional: users without one can still validate files;
 * organization-specific checks are then skipped.
 */
export interface Organization {
  id: string;
  name: string;
  /** Short code used for {ORG} in file names. */
  code: string;
  active: boolean;
  /** Free-form values that columns can be checked against (column.orgValue). */
  attributes: Record<string, string>;
}

export interface ValidationIssue {
  severity: Severity;
  /** Rule identifier, e.g. "column.dataType" or a row/file rule id. */
  ruleId: string;
  /** Short category used for trend reporting. */
  category: IssueCategory;
  /** 1-based line in the file (header = row 1). Absent for file-level issues. */
  row?: number;
  /** Column letter, e.g. "S". */
  column?: string;
  field?: string;
  value?: string;
  message: string;
}

export type IssueCategory =
  | 'Structure'
  | 'File Name'
  | 'Required'
  | 'Data Type'
  | 'Length'
  | 'Format'
  | 'Allowed Values'
  | 'Fixed Value'
  | 'Duplicate'
  | 'Conditional'
  | 'Cross-Field'
  | 'Cross-File';

export type ValidationStatus = 'passed' | 'passed_with_warnings' | 'failed';

export interface ValidationSummary {
  status: ValidationStatus;
  totalRecords: number;
  recordsPassed: number;
  recordsWithErrors: number;
  recordsWithWarnings: number;
  errorCount: number;
  warningCount: number;
  /** True when the stored issue preview is shorter than the full list (full list is in the report). */
  issuesTruncated: boolean;
  byCategory: Record<string, { errors: number; warnings: number }>;
  byColumn: Record<string, { errors: number; warnings: number }>;
  structuralFailure: boolean;
  durationMs: number;
}

export interface ValidationResult {
  summary: ValidationSummary;
  issues: ValidationIssue[];
}

export interface ValidationContext {
  fileType: FileTypeDefinition;
  /** Omitted when the submitter has no organization; org-specific checks are skipped. */
  organization?: Organization;
  lookups: Record<string, LookupList>;
  fileName: string;
  /** For `existsInPrior` rules: rule id → values seen in previously passed files. Rule skipped if absent. */
  priorValues?: Record<string, Set<string>>;
}

export type Role = 'user' | 'admin';

export interface UserIdentity {
  sub: string;
  email: string;
  name: string;
  role: Role;
  /** Organization the user submits for (optional). */
  orgId?: string;
}

export type SubmissionReviewStatus = 'validated' | 'pending_review' | 'processed' | 'rejected';

export interface Submission {
  id: string;
  orgId?: string;
  orgName?: string;
  fileTypeId: string;
  fileTypeName: string;
  fileName: string;
  fileKey: string;
  reportKey: string;
  submittedAt: string;
  submittedBy: string;
  submittedByName: string;
  fileTypeVersion: number;
  summary: ValidationSummary;
  /** First N issues (for display); full list in the downloadable report. */
  issues: ValidationIssue[];
  reviewStatus: SubmissionReviewStatus;
  reviewHistory: { status: SubmissionReviewStatus; at: string; by: string; note?: string }[];
}
