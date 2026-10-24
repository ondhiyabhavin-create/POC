import { requireAdmin, type Route } from '../http';
import { services } from '../services';

type Counts = { submissions: number; passed: number; passedWithWarnings: number; failed: number; errors: number; warnings: number; records: number };
const empty = (): Counts => ({ submissions: 0, passed: 0, passedWithWarnings: 0, failed: 0, errors: 0, warnings: 0, records: 0 });

export const adminRoutes: Route[] = [
  {
    method: 'GET',
    pattern: '/api/admin/stats',
    handler: async (req) => {
      requireAdmin(req);
      const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30) || 30));
      const since = new Date(Date.now() - days * 86400_000).toISOString();
      const subs = (await services().store.listSubmissions({ limit: 5000 })).filter((s) => s.submittedAt >= since);

      const totals = empty();
      const byOrg = new Map<string, Counts & { orgId: string; orgName: string }>();
      const byFileType = new Map<string, Counts & { fileTypeId: string; fileTypeName: string }>();
      const byDay = new Map<string, Counts & { date: string }>();
      const byCategory = new Map<string, { category: string; errors: number; warnings: number }>();
      const byField = new Map<string, { fileTypeId: string; field: string; errors: number; warnings: number }>();
      const byReviewStatus: Record<string, number> = {};

      const bump = (c: Counts, s: (typeof subs)[number]) => {
        c.submissions++;
        c.records += s.summary.totalRecords;
        c.errors += s.summary.errorCount;
        c.warnings += s.summary.warningCount;
        if (s.summary.status === 'failed') c.failed++;
        else if (s.summary.status === 'passed_with_warnings') c.passedWithWarnings++;
        else c.passed++;
      };

      for (const s of subs) {
        bump(totals, s);
        const orgKey = s.orgId ?? '_none';
        const a = byOrg.get(orgKey) ?? { ...empty(), orgId: orgKey, orgName: s.orgName ?? 'No organization' };
        bump(a, s);
        byOrg.set(orgKey, a);
        const f = byFileType.get(s.fileTypeId) ?? { ...empty(), fileTypeId: s.fileTypeId, fileTypeName: s.fileTypeName };
        bump(f, s);
        byFileType.set(s.fileTypeId, f);
        const date = s.submittedAt.slice(0, 10);
        const d = byDay.get(date) ?? { ...empty(), date };
        bump(d, s);
        byDay.set(date, d);
        byReviewStatus[s.reviewStatus] = (byReviewStatus[s.reviewStatus] ?? 0) + 1;
        for (const [category, v] of Object.entries(s.summary.byCategory)) {
          const c = byCategory.get(category) ?? { category, errors: 0, warnings: 0 };
          c.errors += v.errors;
          c.warnings += v.warnings;
          byCategory.set(category, c);
        }
        for (const [field, v] of Object.entries(s.summary.byColumn)) {
          const k = `${s.fileTypeId}|${field}`;
          const c = byField.get(k) ?? { fileTypeId: s.fileTypeId, field, errors: 0, warnings: 0 };
          c.errors += v.errors;
          c.warnings += v.warnings;
          byField.set(k, c);
        }
      }

      return {
        days,
        totals,
        byReviewStatus,
        byOrg: [...byOrg.values()].sort((a, b) => b.errors - a.errors || b.submissions - a.submissions),
        byFileType: [...byFileType.values()],
        byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
        byCategory: [...byCategory.values()].sort((a, b) => b.errors + b.warnings - (a.errors + a.warnings)),
        topFields: [...byField.values()].sort((a, b) => b.errors - a.errors || b.warnings - a.warnings).slice(0, 10),
      };
    },
  },
];
