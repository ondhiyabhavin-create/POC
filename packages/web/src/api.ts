import type {
  FileTypeDefinition,
  Organization,
  LookupList,
  Submission,
  SubmissionReviewStatus,
  UserIdentity,
  ValidationIssue,
} from '@odr/shared';

import { demoApi, setDemoTokenSource } from './demo-backend';

const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const TOKEN_KEY = 'odr.token';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => undefined;
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export const tokenStore = {
  get: () => sessionStorage.getItem(TOKEN_KEY),
  set: (t: string) => sessionStorage.setItem(TOKEN_KEY, t),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = tokenStore.get();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(res.status, data?.message ?? `Request failed (${res.status})`, data?.details);
  }
  return data as T;
}

export type SubmissionListItem = Omit<Submission, 'issues'>;
export type AuthConfig = { mode: 'local' } | { mode: 'cognito'; userPoolId: string; clientId: string; region: string };

export interface Stats {
  days: number;
  totals: Counts;
  byReviewStatus: Record<string, number>;
  byOrg: (Counts & { orgId: string; orgName: string })[];
  byFileType: (Counts & { fileTypeId: string; fileTypeName: string })[];
  byDay: (Counts & { date: string })[];
  byCategory: { category: string; errors: number; warnings: number }[];
  topFields: { fileTypeId: string; field: string; errors: number; warnings: number }[];
}
export interface Counts {
  submissions: number;
  passed: number;
  passedWithWarnings: number;
  failed: number;
  errors: number;
  warnings: number;
  records: number;
}

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '') as [string, string][]).toString();
  return s ? `?${s}` : '';
};

const httpApi = {
  authConfig: () => request<AuthConfig>('GET', '/api/auth/config'),
  localLogin: (email: string, password: string) => request<{ token: string; user: UserIdentity }>('POST', '/api/auth/login', { email, password }),
  me: () => request<UserIdentity>('GET', '/api/me'),

  fileTypes: () => request<FileTypeDefinition[]>('GET', '/api/file-types'),
  fileType: (id: string) => request<FileTypeDefinition>('GET', `/api/file-types/${encodeURIComponent(id)}`),
  saveFileType: (def: FileTypeDefinition, create = false) =>
    request<FileTypeDefinition>('PUT', `/api/file-types/${encodeURIComponent(def.id)}${create ? '?create=1' : ''}`, def),
  deleteFileType: (id: string) => request<{ deleted: string }>('DELETE', `/api/file-types/${encodeURIComponent(id)}`),

  lookups: () => request<LookupList[]>('GET', '/api/lookups'),
  saveLookup: (l: LookupList) => request<LookupList>('PUT', `/api/lookups/${encodeURIComponent(l.id)}`, l),

  organizations: () => request<Organization[]>('GET', '/api/organizations'),
  saveOrganization: (o: Organization) => request<Organization>('PUT', `/api/organizations/${encodeURIComponent(o.id)}`, o),

  submissions: (filter: { orgId?: string; fileTypeId?: string } = {}) => request<SubmissionListItem[]>('GET', `/api/submissions${q(filter)}`),
  submission: (id: string) => request<Submission>('GET', `/api/submissions/${encodeURIComponent(id)}`),
  issues: (id: string, filter: { severity?: string; category?: string; q?: string; offset?: number; limit?: number }) =>
    request<{ total: number; offset: number; limit: number; items: ValidationIssue[] }>('GET', `/api/submissions/${encodeURIComponent(id)}/issues${q(filter)}`),
  reportUrl: (id: string) => request<{ url: string }>('GET', `/api/submissions/${encodeURIComponent(id)}/report`),
  fileUrl: (id: string) => request<{ url: string }>('GET', `/api/submissions/${encodeURIComponent(id)}/file`),
  setStatus: (id: string, status: SubmissionReviewStatus, note?: string) =>
    request<Submission>('PATCH', `/api/submissions/${encodeURIComponent(id)}/status`, { status, note }),
  stats: (days: number) => request<Stats>('GET', `/api/admin/stats${q({ days })}`),

  /** Upload the raw file to object storage, then ask the API to validate it. */
  async validate(file: File, fileTypeId: string, orgId?: string): Promise<Submission> {
    const up = await request<{ key: string; uploadUrl: string; contentType: string }>('POST', '/api/uploads', { fileName: file.name, size: file.size });
    const put = await fetch(up.uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': up.contentType } });
    if (!put.ok) throw new ApiError(put.status, 'The file could not be uploaded. Please try again.');
    return request<Submission>('POST', '/api/submissions', { fileTypeId, fileName: file.name, key: up.key, orgId });
  },
};

/** Static demo deployments (e.g. Vercel) run the engine in the browser instead of calling an API. */
export const IS_DEMO = import.meta.env.VITE_DEMO === '1';
setDemoTokenSource(() => tokenStore.get());
export const api: typeof httpApi = IS_DEMO ? (demoApi as unknown as typeof httpApi) : httpApi;

/** Trigger a browser download from a signed URL (or a blob URL with a file name). */
export function downloadFromUrl(url: string, name?: string) {
  const a = document.createElement('a');
  a.href = url;
  if (name) a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Download generated text (templates/samples) as a file. */
export function downloadText(fileName: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
