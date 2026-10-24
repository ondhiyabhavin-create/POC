/**
 * Browser-only backend used for static demo deployments (VITE_DEMO=1, e.g. Vercel).
 * Mirrors the API's behaviour with the same engine, keeping data in localStorage.
 * Each browser has its own copy of the data. Not for real use.
 */
import {
  FILE_TYPES,
  LOOKUPS,
  ORGANIZATIONS,
  buildErrorReportCsv,
  checkFileTypeDefinition,
  columnLetter,
  isXlsx,
  tableFromCsv,
  tableFromXlsx,
  validateBytes,
  type FileTypeDefinition,
  type LookupList,
  type Organization,
  type Submission,
  type SubmissionReviewStatus,
  type UserIdentity,
  type ValidationIssue,
} from '@odr/shared';
import type { AuthConfig, Counts, Stats, SubmissionListItem } from './api';

export class DemoError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const KEY = 'fi.demo.v1';
const PASSWORD = 'Password1!';
const USERS: UserIdentity[] = [
  { sub: 'local-admin', email: 'admin@demo.local', name: 'Rules Admin (Demo)', role: 'admin' },
  { sub: 'local-ccsv', email: 'user@ccsv.local', name: 'Somewhereville Court Clerk (Demo)', role: 'user', orgId: 'CCSV' },
  { sub: 'local-bpu', email: 'user@bpu.local', name: 'Bayou Parish Billing (Demo)', role: 'user', orgId: 'BPU' },
  { sub: 'local-guest', email: 'anyone@demo.local', name: 'Any User (Demo)', role: 'user' },
];

interface Db {
  fileTypes: Record<string, FileTypeDefinition>;
  lookups: Record<string, LookupList>;
  orgs: Record<string, Organization>;
  submissions: Record<string, Submission & { allIssues: ValidationIssue[] }>;
  index: Record<string, string[]>;
}

const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, structuredClone(x)]));
const fresh = (): Db => ({ fileTypes: byId(FILE_TYPES), lookups: byId(LOOKUPS), orgs: byId(ORGANIZATIONS), submissions: {}, index: {} });

let db: Db = (() => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Db;
  } catch {
    /* storage unavailable or corrupt */
  }
  return fresh();
})();

/** Original uploads are kept for this browser session only. */
const files = new Map<string, Blob>();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    // Quota exceeded: trim stored issue lists of the oldest submissions and retry once.
    const subs = Object.values(db.submissions).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
    for (const s of subs.slice(0, Math.ceil(subs.length / 2))) s.allIssues = s.allIssues.slice(0, 200);
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch {
      /* keep working in memory */
    }
  }
}

export function resetDemoData() {
  db = fresh();
  save();
}

let currentToken: () => string | null = () => null;
export const setDemoTokenSource = (fn: () => string | null) => (currentToken = fn);

const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 120));
const me = (): UserIdentity => {
  const u = USERS.find((x) => x.email === currentToken());
  if (!u) throw new DemoError(401, 'Sign in required.');
  return u;
};
const admin = () => {
  const u = me();
  if (u.role !== 'admin') throw new DemoError(403, 'Administrator access required.');
  return u;
};
const scope = (orgId: string | undefined, type: string, col: string) => `${orgId ?? '_none'}#${type}#${col}`;
const canSee = (u: UserIdentity, s: Submission) => (u.role === 'admin' ? true : u.orgId ? s.orgId === u.orgId : !s.orgId && s.submittedBy === u.email);
const ownSub = (id: string) => {
  const u = me();
  const s = db.submissions[id];
  if (!s || !canSee(u, s)) throw new DemoError(404, 'Submission not found.');
  return s;
};
const strip = (s: Db['submissions'][string]): Submission => {
  const { allIssues: _a, ...rest } = s;
  return structuredClone(rest);
};

export const demoApi = {
  authConfig: () => delay<AuthConfig>({ mode: 'local' }),
  async localLogin(email: string, password: string) {
    const user = USERS.find((u) => u.email === email.trim().toLowerCase());
    if (!user || password !== PASSWORD) throw new DemoError(401, 'Incorrect email or password.');
    return delay({ token: user.email, user });
  },
  me: async () => me(),

  fileTypes: async () => {
    const u = me();
    return delay(Object.values(db.fileTypes).filter((f) => u.role === 'admin' || f.active).sort((a, b) => a.name.localeCompare(b.name)));
  },
  fileType: async (id: string) => {
    const u = me();
    const f = db.fileTypes[id];
    if (!f || (!f.active && u.role !== 'admin')) throw new DemoError(404, 'File type not found.');
    return delay(structuredClone(f));
  },
  async saveFileType(input: FileTypeDefinition, create = false) {
    const u = admin();
    const existing = db.fileTypes[input.id];
    if (create && existing) throw new DemoError(400, `A file type with code "${input.id}" already exists. Choose another code.`);
    const def: FileTypeDefinition = {
      ...input,
      columns: input.columns.map((c, i) => ({ ...c, letter: columnLetter(i) })),
      fileNamePattern: input.fileNamePattern?.trim() || undefined,
      version: (existing?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: u.email,
    };
    const problems = checkFileTypeDefinition(def, Object.values(db.lookups), Object.keys(db.fileTypes));
    if (problems.length) throw new DemoError(400, 'The rule set has problems that must be fixed before saving.', problems);
    db.fileTypes[def.id] = def;
    save();
    return delay(structuredClone(def));
  },
  async deleteFileType(id: string) {
    admin();
    const users = Object.values(db.fileTypes).filter((f) => f.id !== id && f.fileRules.some((r) => r.type === 'existsInPrior' && r.sourceFileTypeId === id));
    if (users.length) throw new DemoError(400, `Cannot delete: ${users.map((x) => x.name).join(', ')} check values against this file type. Remove those rules first.`);
    delete db.fileTypes[id];
    save();
    return delay({ deleted: id });
  },

  lookups: async () => (me(), delay(Object.values(db.lookups).sort((a, b) => a.name.localeCompare(b.name)))),
  async saveLookup(l: LookupList) {
    admin();
    if (!/^[A-Z][A-Z0-9_]*$/.test(l.id)) throw new DemoError(400, 'Lookup list ID must be UPPER_SNAKE_CASE.');
    const values = [...new Set(l.values.map((v) => v.trim()).filter(Boolean))];
    if (!l.name.trim() || values.length === 0) throw new DemoError(400, 'A name and at least one value are required.');
    db.lookups[l.id] = { ...l, values, updatedAt: new Date().toISOString() };
    save();
    return delay(db.lookups[l.id]);
  },

  organizations: async () => {
    const u = me();
    return delay(Object.values(db.orgs).filter((o) => u.role === 'admin' || o.id === u.orgId).sort((a, b) => a.name.localeCompare(b.name)));
  },
  async saveOrganization(o: Organization) {
    admin();
    if (!/^[A-Za-z0-9]+$/.test(o.id) || !/^[A-Za-z0-9]+$/.test(o.code)) throw new DemoError(400, 'ID and code may contain only letters and digits.');
    if (!o.name.trim()) throw new DemoError(400, 'Name is required.');
    db.orgs[o.id] = structuredClone(o);
    save();
    return delay(db.orgs[o.id]);
  },

  async submissions(filter: { orgId?: string; fileTypeId?: string } = {}) {
    const u = me();
    const list = Object.values(db.submissions)
      .filter((s) => canSee(u, s))
      .filter((s) => (u.role !== 'admin' || !filter.orgId || s.orgId === filter.orgId) && (!filter.fileTypeId || s.fileTypeId === filter.fileTypeId))
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
      .map((s) => {
        const { issues: _i, ...rest } = strip(s);
        return rest as SubmissionListItem;
      });
    return delay(list);
  },
  submission: async (id: string) => delay(strip(ownSub(id))),
  async issues(id: string, f: { severity?: string; category?: string; q?: string; offset?: number; limit?: number }) {
    let items = ownSub(id).allIssues;
    if (f.severity === 'error' || f.severity === 'warning') items = items.filter((i) => i.severity === f.severity);
    if (f.category) items = items.filter((i) => i.category === f.category);
    if (f.q) items = items.filter((i) => i.message.toLowerCase().includes(f.q!.toLowerCase()));
    const offset = f.offset ?? 0;
    const limit = f.limit ?? 100;
    return delay({ total: items.length, offset, limit, items: items.slice(offset, offset + limit) });
  },
  async reportUrl(id: string) {
    const s = ownSub(id);
    const csv = buildErrorReportCsv({
      fileName: s.fileName,
      fileType: `${s.fileTypeName} (${s.fileTypeId})`,
      organization: s.orgName ?? 'None',
      submittedAt: s.submittedAt,
      submittedBy: s.submittedBy,
      submissionId: s.id,
      summary: s.summary,
      issues: s.allIssues,
    });
    return { url: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), name: s.fileName.replace(/\.(csv|xlsx)$/i, '') + '_validation_report.csv' };
  },
  async fileUrl(id: string) {
    const s = ownSub(id);
    const blob = files.get(s.id);
    if (!blob) throw new DemoError(404, 'In the browser demo, original files are only kept until the page is reloaded.');
    return { url: URL.createObjectURL(blob), name: s.fileName };
  },
  async setStatus(id: string, status: SubmissionReviewStatus, note?: string) {
    const u = admin();
    const s = db.submissions[id];
    if (!s) throw new DemoError(404, 'Submission not found.');
    if (s.summary.status === 'failed' && status !== 'rejected') throw new DemoError(409, 'A file that failed validation cannot be moved forward. It must be corrected and resubmitted.');
    s.reviewStatus = status;
    s.reviewHistory.push({ status, at: new Date().toISOString(), by: u.email, note });
    save();
    return delay(strip(s));
  },

  async stats(days: number): Promise<Stats> {
    admin();
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const subs = Object.values(db.submissions).filter((s) => s.submittedAt >= since);
    const empty = (): Counts => ({ submissions: 0, passed: 0, passedWithWarnings: 0, failed: 0, errors: 0, warnings: 0, records: 0 });
    const bump = (c: Counts, s: Submission) => {
      c.submissions++;
      c.records += s.summary.totalRecords;
      c.errors += s.summary.errorCount;
      c.warnings += s.summary.warningCount;
      if (s.summary.status === 'failed') c.failed++;
      else if (s.summary.status === 'passed_with_warnings') c.passedWithWarnings++;
      else c.passed++;
    };
    const totals = empty();
    const byOrg = new Map<string, Counts & { orgId: string; orgName: string }>();
    const byType = new Map<string, Counts & { fileTypeId: string; fileTypeName: string }>();
    const byDay = new Map<string, Counts & { date: string }>();
    const byCat = new Map<string, { category: string; errors: number; warnings: number }>();
    const byField = new Map<string, { fileTypeId: string; field: string; errors: number; warnings: number }>();
    const byReviewStatus: Record<string, number> = {};
    for (const s of subs) {
      bump(totals, s);
      const ok = s.orgId ?? '_none';
      bump(byOrg.get(ok) ?? byOrg.set(ok, { ...empty(), orgId: ok, orgName: s.orgName ?? 'No organization' }).get(ok)!, s);
      bump(byType.get(s.fileTypeId) ?? byType.set(s.fileTypeId, { ...empty(), fileTypeId: s.fileTypeId, fileTypeName: s.fileTypeName }).get(s.fileTypeId)!, s);
      const d = s.submittedAt.slice(0, 10);
      bump(byDay.get(d) ?? byDay.set(d, { ...empty(), date: d }).get(d)!, s);
      byReviewStatus[s.reviewStatus] = (byReviewStatus[s.reviewStatus] ?? 0) + 1;
      for (const [category, v] of Object.entries(s.summary.byCategory)) {
        const c = byCat.get(category) ?? byCat.set(category, { category, errors: 0, warnings: 0 }).get(category)!;
        c.errors += v.errors;
        c.warnings += v.warnings;
      }
      for (const [field, v] of Object.entries(s.summary.byColumn)) {
        const k = `${s.fileTypeId}|${field}`;
        const c = byField.get(k) ?? byField.set(k, { fileTypeId: s.fileTypeId, field, errors: 0, warnings: 0 }).get(k)!;
        c.errors += v.errors;
        c.warnings += v.warnings;
      }
    }
    return delay({
      days,
      totals,
      byReviewStatus,
      byOrg: [...byOrg.values()].sort((a, b) => b.errors - a.errors),
      byFileType: [...byType.values()],
      byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
      byCategory: [...byCat.values()].sort((a, b) => b.errors + b.warnings - (a.errors + a.warnings)),
      topFields: [...byField.values()].sort((a, b) => b.errors - a.errors || b.warnings - a.warnings).slice(0, 10),
    });
  },

  async validate(file: File, fileTypeId: string, orgId?: string): Promise<Submission> {
    const u = me();
    if (!/\.(csv|xlsx)$/i.test(file.name)) throw new DemoError(400, 'Only .csv and .xlsx files can be validated.');
    if (file.size > 25 * 1024 * 1024) throw new DemoError(400, 'File is too large. The maximum size is 25 MB.');
    const fileType = db.fileTypes[fileTypeId];
    if (!fileType || !fileType.active) throw new DemoError(400, 'Unknown or inactive file type.');
    const oid = u.role === 'admin' ? orgId || undefined : u.orgId;
    const organization = oid ? db.orgs[oid] : undefined;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const priorValues: Record<string, Set<string>> = {};
    for (const r of fileType.fileRules) if (r.type === 'existsInPrior') priorValues[r.id] = new Set(db.index[scope(organization?.id, r.sourceFileTypeId, r.sourceColumn)] ?? []);
    const result = validateBytes(bytes, { fileType, organization, lookups: db.lookups, fileName: file.name, priorValues });

    const d = new Date();
    const id = `SUB-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
    const failed = result.summary.status === 'failed';
    const at = d.toISOString();
    db.submissions[id] = {
      id,
      orgId: organization?.id,
      orgName: organization?.name,
      fileTypeId: fileType.id,
      fileTypeName: fileType.name,
      fileName: file.name,
      fileKey: id,
      reportKey: id,
      submittedAt: at,
      submittedBy: u.email,
      submittedByName: u.name,
      fileTypeVersion: fileType.version,
      summary: { ...result.summary, issuesTruncated: result.issues.length > 50 },
      issues: result.issues.slice(0, 50),
      allIssues: result.issues.slice(0, 5000),
      reviewStatus: failed ? 'rejected' : 'validated',
      reviewHistory: [{ status: failed ? 'rejected' : 'validated', at, by: 'system', note: 'Automated validation' }],
    };
    files.set(id, file);

    if (!failed) {
      const cols = new Set<string>();
      for (const t of Object.values(db.fileTypes)) for (const r of t.fileRules) if (r.type === 'existsInPrior' && r.sourceFileTypeId === fileType.id) cols.add(r.sourceColumn);
      if (cols.size) {
        const table = isXlsx(bytes) ? tableFromXlsx(bytes, fileType) : tableFromCsv(new TextDecoder().decode(bytes));
        for (const key of cols) {
          const idx = fileType.columns.findIndex((c) => c.key === key);
          if (idx < 0) continue;
          const sc = scope(organization?.id, fileType.id, key);
          db.index[sc] = [...new Set([...(db.index[sc] ?? []), ...table.rows.slice(1).map((r) => (r[idx] ?? '').trim()).filter(Boolean)])];
        }
      }
    }
    save();
    return delay(strip(db.submissions[id]));
  },
};
