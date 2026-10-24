import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { statusLabel, type SubmissionReviewStatus, type ValidationSummary } from '@odr/shared';

export function StatusBadge({ status }: { status: ValidationSummary['status'] }) {
  const cls = status === 'passed' ? 'ok' : status === 'passed_with_warnings' ? 'warn' : 'err';
  const icon = status === 'passed' ? '✓' : status === 'passed_with_warnings' ? '!' : '✕';
  return (
    <span className={`badge ${cls}`}>
      {icon} {statusLabel(status)}
    </span>
  );
}

export const REVIEW_LABELS: Record<SubmissionReviewStatus, string> = {
  validated: 'Validated',
  pending_review: 'Pending review',
  processed: 'Processed',
  rejected: 'Rejected',
};

export function ReviewBadge({ status }: { status: SubmissionReviewStatus }) {
  const cls = status === 'processed' ? 'ok' : status === 'rejected' ? 'err' : status === 'pending_review' ? 'info' : 'neutral';
  return <span className={`badge ${cls}`}>{REVIEW_LABELS[status]}</span>;
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'ok' | 'err' | 'warn' }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

export function SummaryStats({ s }: { s: ValidationSummary }) {
  return (
    <div className="grid cols-4" style={{ marginBottom: 20 }}>
      <Stat label="Total records" value={s.totalRecords.toLocaleString()} />
      <Stat label="Records passed" value={s.recordsPassed.toLocaleString()} tone="ok" />
      <Stat label="Records with errors" value={s.recordsWithErrors.toLocaleString()} tone={s.recordsWithErrors ? 'err' : undefined} />
      <Stat label="Records with warnings only" value={s.recordsWithWarnings.toLocaleString()} tone={s.recordsWithWarnings ? 'warn' : undefined} />
      <Stat label="Errors" value={s.errorCount.toLocaleString()} tone={s.errorCount ? 'err' : undefined} />
      <Stat label="Warnings" value={s.warningCount.toLocaleString()} tone={s.warningCount ? 'warn' : undefined} />
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function Loading({ text = 'Loading…' }: { text?: string }) {
  return (
    <div className="empty">
      <Spinner /> <span style={{ marginLeft: 8 }}>{text}</span>
    </div>
  );
}

export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as { message?: string; details?: unknown };
  const details = Array.isArray(e.details) ? (e.details as string[]) : [];
  return (
    <div className="alert err" role="alert">
      <strong>{e.message ?? String(error)}</strong>
      {details.length > 0 && (
        <ul>
          {details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Minimal data-loading hook. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setData(await run());
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function BarList({ items, emptyText = 'No data yet.' }: { items: { label: ReactNode; errors: number; warnings: number; ok?: number }[]; emptyText?: string }) {
  const max = Math.max(1, ...items.map((i) => i.errors + i.warnings + (i.ok ?? 0)));
  if (items.length === 0) return <div className="muted small">{emptyText}</div>;
  return (
    <div className="bar-list">
      {items.map((i, idx) => (
        <div className="bar-item" key={idx}>
          <div className="bar-label">
            <span>{i.label}</span>
            <span className="muted mono">
              {i.ok !== undefined && <>{i.ok} ok · </>}
              {i.errors} err · {i.warnings} warn
            </span>
          </div>
          <div className="bar-track">
            <div className="seg-err" style={{ width: `${(i.errors / max) * 100}%` }} />
            <div className="seg-warn" style={{ width: `${(i.warnings / max) * 100}%` }} />
            {i.ok !== undefined && <div className="seg-ok" style={{ width: `${(i.ok / max) * 100}%` }} />}
          </div>
        </div>
      ))}
    </div>
  );
}
