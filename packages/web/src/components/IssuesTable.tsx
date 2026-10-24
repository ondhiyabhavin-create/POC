import { useEffect, useState } from 'react';
import type { ValidationIssue, ValidationSummary } from '@odr/shared';
import { api } from '../api';
import { ErrorAlert, Spinner } from './ui';

const PAGE = 50;

/** Row/column-specific issues for a submission, filtered and paged on the server. */
export function IssuesTable({ submissionId, summary }: { submissionId: string; summary: ValidationSummary }) {
  const [severity, setSeverity] = useState('');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ total: number; items: ValidationIssue[] }>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQ(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setOffset(0), [severity, category, q]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .issues(submissionId, { severity, category, q, offset, limit: PAGE })
      .then((d) => !cancelled && (setData(d), setError(undefined)))
      .catch((e) => !cancelled && setError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [submissionId, severity, category, q, offset]);

  const categories = Object.keys(summary.byCategory).sort();
  const total = data?.total ?? 0;

  return (
    <div className="card tight">
      <div className="card-head">
        <h2>Issues {data && <span className="muted small">({total.toLocaleString()})</span>}</h2>
        <div className="row">
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity">
            <option value="">Errors &amp; warnings</option>
            <option value="error">Errors only ({summary.errorCount})</option>
            <option value="warning">Warnings only ({summary.warningCount})</option>
          </select>
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c} ({summary.byCategory[c].errors + summary.byCategory[c].warnings})
              </option>
            ))}
          </select>
          <input placeholder="Search messages…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
          {loading && <Spinner />}
        </div>
      </div>
      <ErrorAlert error={error} />
      {data && data.items.length === 0 ? (
        <div className="empty">{summary.errorCount + summary.warningCount === 0 ? 'No issues found. 🎉' : 'No issues match these filters.'}</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 90 }}>Severity</th>
                <th className="num" style={{ width: 60 }}>Row</th>
                <th style={{ width: 200 }}>Column</th>
                <th style={{ width: 160 }}>Value</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((i, idx) => (
                <tr key={offset + idx}>
                  <td className={`sev-${i.severity}`}>{i.severity === 'error' ? 'Error' : 'Warning'}</td>
                  <td className="num">{i.row ?? '—'}</td>
                  <td>
                    {i.column ? (
                      <>
                        <strong>{i.column}</strong> <span className="muted">{i.field}</span>
                      </>
                    ) : (
                      <span className="muted">{i.field ?? 'File'}</span>
                    )}
                    <div className="muted small">{i.category}</div>
                  </td>
                  <td>{i.value !== undefined ? <span className="cell-value">{i.value === '' ? '(blank)' : i.value}</span> : '—'}</td>
                  <td>{i.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > PAGE && (
        <div className="card-head" style={{ borderTop: '1px solid var(--border)', borderBottom: 'none' }}>
          <span className="muted small">
            Showing {offset + 1}–{Math.min(offset + PAGE, total)} of {total.toLocaleString()}
          </span>
          <div className="row">
            <button className="btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              ← Previous
            </button>
            <button className="btn small" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
