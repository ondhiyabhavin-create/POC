import { toCsv } from './csv';
import type { ValidationIssue, ValidationSummary } from './types';

const STATUS_LABEL: Record<ValidationSummary['status'], string> = {
  passed: 'Passed',
  passed_with_warnings: 'Passed with warnings',
  failed: 'Failed',
};

export function statusLabel(status: ValidationSummary['status']): string {
  return STATUS_LABEL[status];
}

/** Downloadable error report: a short summary block followed by one line per issue. */
export function buildErrorReportCsv(meta: {
  fileName: string;
  fileType: string;
  organization: string;
  submittedAt: string;
  submittedBy: string;
  submissionId: string;
  summary: ValidationSummary;
  issues: ValidationIssue[];
}): string {
  const s = meta.summary;
  const rows: (string | number | undefined)[][] = [
    ['File Intake - Validation Report'],
    ['Submission ID', meta.submissionId],
    ['File Name', meta.fileName],
    ['File Type', meta.fileType],
    ['Organization', meta.organization],
    ['Validated At', meta.submittedAt],
    ['Validated By', meta.submittedBy],
    ['Result', statusLabel(s.status)],
    ['Total Records', s.totalRecords],
    ['Records Passed', s.recordsPassed],
    ['Records With Errors', s.recordsWithErrors],
    ['Records With Warnings Only', s.recordsWithWarnings],
    ['Errors', s.errorCount],
    ['Warnings', s.warningCount],
    [],
    ['Severity', 'Row', 'Column', 'Field', 'Category', 'Current Value', 'Message', 'Rule'],
    ...meta.issues.map((i) => [
      i.severity === 'error' ? 'ERROR' : 'WARNING',
      i.row ?? '',
      i.column ?? '',
      i.field ?? '',
      i.category,
      i.value ?? '',
      i.message,
      i.ruleId,
    ]),
  ];
  return toCsv(rows);
}
