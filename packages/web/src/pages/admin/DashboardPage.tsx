import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { BarList, ErrorAlert, fmtDateTime, Loading, REVIEW_LABELS, StatusBadge, Stat, useAsync } from '../../components/ui';
import type { SubmissionReviewStatus } from '@odr/shared';

export function DashboardPage() {
  const [days, setDays] = useState(30);
  const { data, error, loading } = useAsync(() => Promise.all([api.stats(days), api.submissions()]), [days]);
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorAlert error={error} />;
  const [stats, subs] = data;
  const t = stats.totals;
  const passRate = t.submissions ? Math.round(((t.passed + t.passedWithWarnings) / t.submissions) * 100) : 0;
  const pending = subs.filter((s) => s.reviewStatus === 'validated' || s.reviewStatus === 'pending_review').slice(0, 8);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>Submissions, results and error trends across everyone who validates files.</p>
        </div>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last 12 months</option>
        </select>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 20 }}>
        <Stat label="Files validated" value={t.submissions} />
        <Stat label="First-pass success rate" value={`${passRate}%`} tone={passRate >= 80 ? 'ok' : passRate >= 50 ? 'warn' : 'err'} />
        <Stat label="Failed files" value={t.failed} tone={t.failed ? 'err' : undefined} />
        <Stat label="Records checked" value={t.records.toLocaleString()} />
        <Stat label="Errors found" value={t.errors.toLocaleString()} tone={t.errors ? 'err' : undefined} />
        <Stat label="Warnings found" value={t.warnings.toLocaleString()} tone={t.warnings ? 'warn' : undefined} />
      </div>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Error trends by organization</h2>
            <span className="spacer" />
            <Legend />
          </div>
          <BarList
            items={stats.byOrg.map((a) => ({
              label: (
                <span>
                  {a.orgName} <span className="muted small">· {a.submissions} file(s), {a.failed} failed</span>
                </span>
              ),
              errors: a.errors,
              warnings: a.warnings,
            }))}
          />
        </div>
        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Error trends by type</h2>
            <span className="spacer" />
            <Legend />
          </div>
          <BarList items={stats.byCategory.map((c) => ({ label: c.category, errors: c.errors, warnings: c.warnings }))} />
        </div>
        <div className="card">
          <h2>Most common problem fields</h2>
          <BarList items={stats.topFields.map((f) => ({ label: `${f.fileTypeId} · ${f.field}`, errors: f.errors, warnings: f.warnings }))} />
        </div>
        <div className="card">
          <h2>Results by file type</h2>
          <BarList
            items={stats.byFileType.map((f) => ({
              label: `${f.fileTypeName} (${f.submissions} files)`,
              ok: f.passed,
              warnings: f.passedWithWarnings,
              errors: f.failed,
            }))}
          />
          <div className="legend" style={{ marginTop: 12 }}>
            <span>
              <i style={{ background: 'var(--ok)' }} />
              Passed
            </span>
            <span>
              <i style={{ background: '#e6a23c' }} />
              With warnings
            </span>
            <span>
              <i style={{ background: 'var(--err)' }} />
              Failed
            </span>
          </div>
          <h3 style={{ marginTop: 20 }}>Review status</h3>
          <div className="chips">
            {(Object.keys(REVIEW_LABELS) as SubmissionReviewStatus[]).map((k) => (
              <span className="chip" key={k}>
                {REVIEW_LABELS[k]}: <strong>{stats.byReviewStatus[k] ?? 0}</strong>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="card tight">
        <div className="card-head">
          <h2>Awaiting review</h2>
          <Link to="/submissions">View all submissions →</Link>
        </div>
        {pending.length === 0 ? (
          <div className="empty">Nothing waiting.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Submitted</th>
                  <th>Organization</th>
                  <th>File</th>
                  <th className="num">Records</th>
                  <th>Result</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((s) => (
                  <tr key={s.id}>
                    <td>{fmtDateTime(s.submittedAt)}</td>
                    <td>{s.orgName ?? '—'}</td>
                    <td>
                      <Link to={`/submissions/${s.id}`}>{s.fileName}</Link>
                    </td>
                    <td className="num">{s.summary.totalRecords}</td>
                    <td>
                      <StatusBadge status={s.summary.status} />
                    </td>
                    <td>{REVIEW_LABELS[s.reviewStatus]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function Legend() {
  return (
    <div className="legend">
      <span>
        <i style={{ background: 'var(--err)' }} />
        Errors
      </span>
      <span>
        <i style={{ background: '#e6a23c' }} />
        Warnings
      </span>
    </div>
  );
}
