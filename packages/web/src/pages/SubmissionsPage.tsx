import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorAlert, fmtDateTime, Loading, ReviewBadge, StatusBadge, useAsync } from '../components/ui';

export function SubmissionsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [orgId, setOrgId] = useState('');
  const [fileTypeId, setFileTypeId] = useState('');
  const [status, setStatus] = useState('');
  const { data: subs, error, loading } = useAsync(() => api.submissions({ orgId, fileTypeId }), [orgId, fileTypeId]);
  const { data: meta } = useAsync(() => Promise.all([api.fileTypes(), isAdmin ? api.organizations() : Promise.resolve([])]), [isAdmin]);

  const rows = useMemo(() => (subs ?? []).filter((s) => !status || s.summary.status === status), [subs, status]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{isAdmin ? 'All submissions' : 'My submissions'}</h1>
          <p>{isAdmin ? 'Every file validated by anyone.' : user?.orgId ? 'Every file your organization has validated, newest first.' : 'Every file you have validated, newest first.'}</p>
        </div>
        <Link className="btn primary" to="/validate">
          + Validate a file
        </Link>
      </div>

      <div className="card tight">
        <div className="card-head">
          <div className="row">
            {isAdmin && (
              <select value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label="Organization">
                <option value="">All organizations</option>
                {meta?.[1].map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
            <select value={fileTypeId} onChange={(e) => setFileTypeId(e.target.value)} aria-label="File type">
              <option value="">All file types</option>
              {meta?.[0].map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Result">
              <option value="">All results</option>
              <option value="passed">Passed</option>
              <option value="passed_with_warnings">Passed with warnings</option>
              <option value="failed">Failed</option>
            </select>
          </div>
          <span className="muted small">{rows.length} submission(s)</span>
        </div>
        <ErrorAlert error={error} />
        {loading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <div className="empty">
            No submissions yet. <Link to="/validate">Validate your first file →</Link>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Submitted</th>
                  <th>File</th>
                  {isAdmin && <th>Organization</th>}
                  <th>Type</th>
                  <th className="num">Records</th>
                  <th className="num">Errors</th>
                  <th className="num">Warnings</th>
                  <th>Result</th>
                  <th>Review status</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(s.submittedAt)}</td>
                    <td>
                      <Link to={`/submissions/${s.id}`}>{s.fileName}</Link>
                      <div className="muted small mono">{s.id}</div>
                    </td>
                    {isAdmin && <td>{s.orgName ?? <span className="muted">—</span>}</td>}
                    <td>{s.fileTypeName}</td>
                    <td className="num">{s.summary.totalRecords.toLocaleString()}</td>
                    <td className="num">{s.summary.errorCount.toLocaleString()}</td>
                    <td className="num">{s.summary.warningCount.toLocaleString()}</td>
                    <td>
                      <StatusBadge status={s.summary.status} />
                    </td>
                    <td>
                      <ReviewBadge status={s.reviewStatus} />
                    </td>
                    <td className="small">{s.submittedByName}</td>
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
