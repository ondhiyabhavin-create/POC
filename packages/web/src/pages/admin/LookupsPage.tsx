import { useState } from 'react';
import type { LookupList } from '@odr/shared';
import { api } from '../../api';
import { ErrorAlert, fmtDateTime, Loading, Modal, Spinner, useAsync } from '../../components/ui';

export function LookupsPage() {
  const { data, error, loading, reload } = useAsync(() => api.lookups(), []);
  const [editing, setEditing] = useState<{ list: LookupList; isNew: boolean } | null>(null);
  if (loading) return <Loading />;
  if (error || !data) return <ErrorAlert error={error} />;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Lookup lists</h1>
          <p>Reusable lists of accepted values (debt types, recall reason codes, state codes…). Any column can reference a list.</p>
        </div>
        <button className="btn primary" onClick={() => setEditing({ isNew: true, list: { id: '', name: '', values: [], updatedAt: '' } })}>
          + New list
        </button>
      </div>
      <div className="grid cols-2">
        {data.map((l) => (
          <div className="card" key={l.id} style={{ marginBottom: 0 }}>
            <div className="row">
              <div style={{ flex: 1 }}>
                <h2 style={{ marginBottom: 2 }}>{l.name}</h2>
                <div className="muted small mono">{l.id}</div>
              </div>
              <button className="btn small" onClick={() => setEditing({ isNew: false, list: structuredClone(l) })}>
                Edit
              </button>
            </div>
            {l.description && <p className="muted small" style={{ marginTop: 8 }}>{l.description}</p>}
            <div className="chips" style={{ marginTop: 8 }}>
              {l.values.slice(0, 24).map((v) => (
                <span className="chip" key={v}>
                  {v}
                </span>
              ))}
              {l.values.length > 24 && <span className="chip">+{l.values.length - 24} more</span>}
            </div>
            <div className="muted small" style={{ marginTop: 10 }}>
              {l.values.length} values · updated {fmtDateTime(l.updatedAt)}
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <LookupModal
          initial={editing.list}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

function LookupModal({ initial, isNew, onClose, onSaved }: { initial: LookupList; isNew: boolean; onClose: () => void; onSaved: () => void }) {
  const [l, setL] = useState(initial);
  const [text, setText] = useState(initial.values.join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const values = text.split('\n').map((v) => v.trim()).filter(Boolean);
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.saveLookup({ ...l, values });
      onSaved();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={isNew ? 'New lookup list' : `Edit ${initial.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !l.id || !l.name || values.length === 0}>
            {busy && <Spinner />} Save list
          </button>
        </>
      }
    >
      <ErrorAlert error={error} />
      <div className="form-grid">
        <label className="field">
          List ID
          <span className="hint">UPPER_SNAKE_CASE, referenced by columns</span>
          <input className="mono" value={l.id} disabled={!isNew} onChange={(e) => setL({ ...l, id: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} />
        </label>
        <label className="field">
          Name
          <input value={l.name} onChange={(e) => setL({ ...l, name: e.target.value })} />
        </label>
      </div>
      <label className="field" style={{ marginTop: 14 }}>
        Description
        <input value={l.description ?? ''} onChange={(e) => setL({ ...l, description: e.target.value })} />
      </label>
      <label className="field" style={{ marginTop: 14 }}>
        Values <span className="hint">One per line. Matching is exact, including capitalization, spaces and dashes. ({values.length} values)</span>
        <textarea className="mono" rows={12} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
    </Modal>
  );
}
