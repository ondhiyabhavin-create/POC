import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import type { SubmissionReviewStatus } from '@odr/shared';
import { api, downloadFromUrl } from '../api';
import { useAuth } from '../auth';
import { IssuesTable } from '../components/IssuesTable';
import { BarList, ErrorAlert, fmtDateTime, Loading, REVIEW_LABELS, ReviewBadge, Spinner, StatusBadge, SummaryStats, useAsync } from '../components/ui';

export function SubmissionPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const fresh = (location.state as { fresh?: boolean } | null)?.fresh;
  const { data: sub, error, loading, setData } = useAsync(() => api.submission(id), [id]);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState<unknown>();

  if (loading) return <Loading />;
  if (error || !sub) return <ErrorAlert error={error ?? new Error('Submission not found.')} />;

  const s = sub.summary;
  const tone = s.status === 'passed' ? 'ok' : s.status === 'passed_with_warnings' ? 'warn' : 'err';
  const isAdmin = user?.role === 'admin';

  const download = async (kind: 'report' | 'file') => {
    setBusy(kind);
    setActionError(undefined);
    try {
      const res: { url: string; name?: string } = kind === 'report' ? await api.reportUrl(sub.id) : await api.fileUrl(sub.id);
      downloadFromUrl(res.url, res.name);
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy('');
    }
  };

  const columns = Object.entries(s.byColumn)
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.errors + b.warnings - (a.errors + a.warnings))
    .slice(0, 8);
  const categories = Object.entries(s.byCategory)
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.errors + b.warnings - (a.errors + a.warnings));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="muted small">
            <Link to="/submissions">Submissions</Link> / {sub.id}
          </div>
          <h1 style={{ wordBreak: 'break-all' }}>{sub.fileName}</h1>
          <p>
            {sub.fileTypeName} ({sub.fileTypeId}) · {sub.orgName ?? 'No organization'} · {fmtDateTime(sub.submittedAt)} by {sub.submittedByName}
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => download('file')} disabled={!!busy}>
            {busy === 'file' && <Spinner />} ⬇ Original file
          </button>
          <button className="btn primary" onClick={() => download('report')} disabled={!!busy}>
            {busy === 'report' && <Spinner />} ⬇ Download error report (CSV)
          </button>
        </div>
      </div>
      <ErrorAlert error={actionError} />

      <div className={`result-hero ${tone}`}>
        <div className="icon">{tone === 'ok' ? '✓' : tone === 'warn' ? '!' : '✕'}</div>
        <div style={{ flex: 1 }}>
          {s.status === 'passed' && (
            <>
              <h2>Validation successful — your file is ready to submit</h2>
              <p>
                All {s.totalRecords.toLocaleString()} records passed all validation rules. You can now submit this exact file. Confirmation number:{' '}
                <strong className="mono">{sub.id}</strong>
              </p>
            </>
          )}
          {s.status === 'passed_with_warnings' && (
            <>
              <h2>Passed with warnings</h2>
              <p>
                No errors were found, so the file can be submitted. Please review the {s.warningCount} warning(s) below — they may cause issues downstream. Confirmation
                number: <strong className="mono">{sub.id}</strong>
              </p>
            </>
          )}
          {s.status === 'failed' && (
            <>
              <h2>Validation failed — please correct and re-validate</h2>
              <p>
                {s.structuralFailure
                  ? 'The file layout does not match the required layout, so individual records could not be fully checked. Fix the layout issues first.'
                  : `${s.recordsWithErrors.toLocaleString()} of ${s.totalRecords.toLocaleString()} records have errors.`}{' '}
                Do not submit this file until it validates successfully.
              </p>
            </>
          )}
        </div>
        {fresh && (
          <Link className="btn" to={`/validate?type=${sub.fileTypeId}`}>
            Validate another file
          </Link>
        )}
      </div>

      <SummaryStats s={s} />

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <h2>Issues by category</h2>
          <BarList items={categories} emptyText="No issues." />
        </div>
        <div className="card">
          <h2>Columns with the most issues</h2>
          <BarList items={columns} emptyText="No column-level issues." />
        </div>
      </div>

      <IssuesTable submissionId={sub.id} summary={s} />

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <h2>Submission details</h2>
          <dl className="kv">
            <dt>Confirmation #</dt>
            <dd className="mono">{sub.id}</dd>
            <dt>Result</dt>
            <dd>
              <StatusBadge status={s.status} />
            </dd>
            <dt>Review status</dt>
            <dd>
              <ReviewBadge status={sub.reviewStatus} />
            </dd>
            <dt>Rule set</dt>
            <dd>
              {sub.fileTypeName} v{sub.fileTypeVersion}
            </dd>
            <dt>Submitted by</dt>
            <dd>
              {sub.submittedByName} ({sub.submittedBy})
            </dd>
            <dt>Validated in</dt>
            <dd>{s.durationMs} ms</dd>
          </dl>
        </div>
        <div className="card">
          <h2>Audit trail</h2>
          <ul className="timeline">
            {sub.reviewHistory.map((h, i) => (
              <li key={i}>
                <strong>{REVIEW_LABELS[h.status]}</strong> · {fmtDateTime(h.at)} · {h.by}
                {h.note && <div className="muted">{h.note}</div>}
              </li>
            ))}
          </ul>
          {isAdmin && (
            <ReviewActions
              current={sub.reviewStatus}
              failed={s.status === 'failed'}
              onChange={async (status, note) => {
                setActionError(undefined);
                try {
                  setData(await api.setStatus(sub.id, status, note));
                } catch (e) {
                  setActionError(e);
                }
              }}
            />
          )}
        </div>
      </div>
    </>
  );
}

function ReviewActions({ current, failed, onChange }: { current: SubmissionReviewStatus; failed: boolean; onChange: (s: SubmissionReviewStatus, note: string) => Promise<void> }) {
  const [status, setStatus] = useState<SubmissionReviewStatus>(current);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const options: SubmissionReviewStatus[] = failed ? ['rejected'] : ['validated', 'pending_review', 'processed', 'rejected'];
  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
      <h3>Update Review status</h3>
      {failed ? (
        <p className="muted small">Files that failed validation stay rejected until a corrected file is resubmitted.</p>
      ) : (
        <div className="grid">
          <select value={status} onChange={(e) => setStatus(e.target.value as SubmissionReviewStatus)}>
            {options.map((o) => (
              <option key={o} value={o}>
                {REVIEW_LABELS[o]}
              </option>
            ))}
          </select>
          <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button
            className="btn primary"
            disabled={busy || status === current}
            onClick={async () => {
              setBusy(true);
              await onChange(status, note);
              setNote('');
              setBusy(false);
            }}
          >
            {busy && <Spinner />} Save status
          </button>
        </div>
      )}
    </div>
  );
}
