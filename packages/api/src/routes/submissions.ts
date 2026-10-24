import crypto from 'node:crypto';
import {
  buildErrorReportCsv,
  tableFromCsv,
  tableFromXlsx,
  validateBytes,
  type FileTypeDefinition,
  type Organization,
  type Submission,
  type SubmissionReviewStatus,
  type UserIdentity,
  type ValidationIssue,
} from '@odr/shared';
import { config } from '../config';
import { badRequest, forbidden, HttpError, notFound, requireAdmin, requireUser, type RequestContext, type Route } from '../http';
import { services } from '../services';
import { indexScope } from '../store/types';

const REVIEW_STATUSES: SubmissionReviewStatus[] = ['validated', 'pending_review', 'processed', 'rejected'];
const ALLOWED_EXT = /\.(csv|xlsx)$/i;

function newSubmissionId(): string {
  const d = new Date();
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `SUB-${stamp}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

const safeFileName = (name: string) => name.replace(/[^\w.\- ]/g, '_').slice(0, 200);
const contentTypeFor = (name: string) => (/\.xlsx$/i.test(name) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv');

/** Users see their organization's submissions, or — without an organization — their own. */
function canSee(user: UserIdentity, sub: Submission) {
  if (user.role === 'admin') return true;
  if (user.orgId) return sub.orgId === user.orgId;
  return !sub.orgId && sub.submittedBy === user.email;
}

async function loadOwnSubmission(req: RequestContext): Promise<{ user: UserIdentity; sub: Submission }> {
  const user = requireUser(req);
  const sub = await services().store.getSubmission(req.params.id);
  if (!sub || !canSee(user, sub)) throw notFound('Submission not found.');
  return { user, sub };
}

/** Columns of `fileType` that other rules look up later (existsInPrior). */
function indexedColumns(fileType: FileTypeDefinition, all: FileTypeDefinition[]): string[] {
  const cols = new Set<string>();
  for (const t of all) for (const r of t.fileRules) if (r.type === 'existsInPrior' && r.sourceFileTypeId === fileType.id) cols.add(r.sourceColumn);
  return [...cols].filter((c) => fileType.columns.some((x) => x.key === c));
}

export const submissionRoutes: Route[] = [
  {
    // Step 1: get a short-lived URL to upload the raw file to (S3 presigned URL in AWS).
    method: 'POST',
    pattern: '/api/uploads',
    handler: async (req) => {
      const user = requireUser(req);
      const { fileName, size } = req.body<{ fileName?: string; size?: number }>();
      if (!fileName || !ALLOWED_EXT.test(fileName)) throw badRequest('Only .csv and .xlsx files can be validated. Older .xls workbooks must be saved as .xlsx or .csv.');
      if (typeof size === 'number' && size > config.maxUploadBytes) {
        throw badRequest(`File is too large. The maximum size is ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`);
      }
      const key = `uploads/${user.sub}/${crypto.randomUUID()}/${safeFileName(fileName)}`;
      const contentType = contentTypeFor(fileName);
      const uploadUrl = await services().blobs.signedUploadUrl(key, contentType);
      return { key, uploadUrl, contentType };
    },
  },
  {
    // Step 2: validate the uploaded file and record the submission.
    method: 'POST',
    pattern: '/api/submissions',
    handler: async (req) => {
      const user = requireUser(req);
      const { store, blobs } = services();
      const input = req.body<{ fileTypeId?: string; fileName?: string; key?: string; orgId?: string }>();
      if (!input.fileTypeId || !input.fileName || !input.key) throw badRequest('fileTypeId, fileName and key are required.');
      if (!input.key.startsWith(`uploads/${user.sub}/`)) throw forbidden('That upload does not belong to you.');

      const orgId = user.role === 'admin' ? input.orgId || undefined : user.orgId;
      const [fileType, allTypes, lookupList] = await Promise.all([store.getFileType(input.fileTypeId), store.listFileTypes(), store.listLookups()]);
      if (!fileType || !fileType.active) throw badRequest('Unknown or inactive file type.');
      let organization: Organization | undefined;
      if (orgId) {
        organization = await store.getOrganization(orgId);
        if (!organization || !organization.active) throw badRequest('Unknown or inactive organization.');
      }

      const blob = await blobs.get(input.key);
      if (!blob) throw badRequest('Uploaded file not found. Please upload it again.');
      if (blob.size > config.maxUploadBytes) throw badRequest('File is too large.');
      const bytes = new Uint8Array(blob.body);

      const priorValues: Record<string, Set<string>> = {};
      for (const r of fileType.fileRules) {
        if (r.type === 'existsInPrior') priorValues[r.id] = await store.getIndexValues(indexScope(organization?.id, r.sourceFileTypeId, r.sourceColumn));
      }
      const result = validateBytes(bytes, {
        fileType,
        organization,
        lookups: Object.fromEntries(lookupList.map((l) => [l.id, l])),
        fileName: input.fileName,
        priorValues,
      });

      const id = newSubmissionId();
      const submittedAt = new Date().toISOString();
      const reportKey = `reports/${id}/validation-report.csv`;
      await Promise.all([
        blobs.put(`reports/${id}/issues.json`, JSON.stringify(result.issues), 'application/json'),
        blobs.put(
          reportKey,
          buildErrorReportCsv({
            fileName: input.fileName,
            fileType: `${fileType.name} (${fileType.id})`,
            organization: organization?.name ?? 'None',
            submittedAt,
            submittedBy: user.email,
            submissionId: id,
            summary: result.summary,
            issues: result.issues,
          }),
          'text/csv',
        ),
      ]);

      const failed = result.summary.status === 'failed';
      const submission: Submission = {
        id,
        orgId: organization?.id,
        orgName: organization?.name,
        fileTypeId: fileType.id,
        fileTypeName: fileType.name,
        fileName: input.fileName,
        fileKey: input.key,
        reportKey,
        submittedAt,
        submittedBy: user.email,
        submittedByName: user.name,
        fileTypeVersion: fileType.version,
        summary: { ...result.summary, issuesTruncated: result.issues.length > config.previewIssueCount },
        issues: result.issues.slice(0, config.previewIssueCount),
        reviewStatus: failed ? 'rejected' : 'validated',
        reviewHistory: [{ status: failed ? 'rejected' : 'validated', at: submittedAt, by: 'system', note: 'Automated validation' }],
      };
      await store.putSubmission(submission);

      // Remember values other file types will check against (e.g. placed debt IDs for Recall files).
      if (!failed) {
        const cols = indexedColumns(fileType, allTypes);
        if (cols.length) {
          const table = /\.xlsx$/i.test(input.fileName) ? tableFromXlsx(bytes, fileType) : tableFromCsv(Buffer.from(bytes).toString('utf8'));
          for (const key of cols) {
            const idx = fileType.columns.findIndex((c) => c.key === key);
            const values = table.rows.slice(1).map((r) => (r[idx] ?? '').trim()).filter(Boolean);
            await store.addIndexValues(indexScope(organization?.id, fileType.id, key), values);
          }
        }
      }
      return submission;
    },
  },
  {
    method: 'GET',
    pattern: '/api/submissions',
    handler: async (req) => {
      const user = requireUser(req);
      const fileTypeId = req.query.fileTypeId || undefined;
      const filter =
        user.role === 'admin'
          ? { orgId: req.query.orgId || undefined, fileTypeId }
          : user.orgId
            ? { orgId: user.orgId, fileTypeId }
            : { submittedBy: user.email, fileTypeId };
      const subs = await services().store.listSubmissions({ ...filter, limit: 500 });
      return subs.map(({ issues: _issues, ...rest }) => rest);
    },
  },
  {
    method: 'GET',
    pattern: '/api/submissions/:id',
    handler: async (req) => (await loadOwnSubmission(req)).sub,
  },
  {
    method: 'GET',
    pattern: '/api/submissions/:id/issues',
    handler: async (req) => {
      const { sub } = await loadOwnSubmission(req);
      const blob = await services().blobs.get(`reports/${sub.id}/issues.json`);
      let issues = blob ? (JSON.parse(blob.body.toString('utf8')) as ValidationIssue[]) : sub.issues;
      const { severity, category, column, q } = req.query;
      if (severity === 'error' || severity === 'warning') issues = issues.filter((i) => i.severity === severity);
      if (category) issues = issues.filter((i) => i.category === category);
      if (column) issues = issues.filter((i) => i.column === column);
      if (q) {
        const needle = q.toLowerCase();
        issues = issues.filter((i) => i.message.toLowerCase().includes(needle));
      }
      const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100));
      return { total: issues.length, offset, limit, items: issues.slice(offset, offset + limit) };
    },
  },
  {
    method: 'GET',
    pattern: '/api/submissions/:id/report',
    handler: async (req) => {
      const { sub } = await loadOwnSubmission(req);
      const name = sub.fileName.replace(/\.(csv|xlsx)$/i, '') + '_validation_report.csv';
      return { url: await services().blobs.signedDownloadUrl(sub.reportKey, name) };
    },
  },
  {
    method: 'GET',
    pattern: '/api/submissions/:id/file',
    handler: async (req) => {
      const { sub } = await loadOwnSubmission(req);
      return { url: await services().blobs.signedDownloadUrl(sub.fileKey, sub.fileName) };
    },
  },
  {
    method: 'PATCH',
    pattern: '/api/submissions/:id/status',
    handler: async (req) => {
      const user = requireAdmin(req);
      const { store } = services();
      const sub = await store.getSubmission(req.params.id);
      if (!sub) throw notFound('Submission not found.');
      const { status, note } = req.body<{ status?: SubmissionReviewStatus; note?: string }>();
      if (!status || !REVIEW_STATUSES.includes(status)) throw badRequest(`Status must be one of ${REVIEW_STATUSES.join(', ')}.`);
      if (sub.summary.status === 'failed' && status !== 'rejected') {
        throw new HttpError(409, 'A file that failed validation cannot be moved forward. It must be corrected and resubmitted.');
      }
      sub.reviewStatus = status;
      sub.reviewHistory.push({ status, at: new Date().toISOString(), by: user.email, note: note?.slice(0, 500) });
      await store.putSubmission(sub);
      return sub;
    },
  },
];
