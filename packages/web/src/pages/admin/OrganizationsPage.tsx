import { useState } from 'react';
import type { FileTypeDefinition, Organization } from '@odr/shared';
import { api } from '../../api';
import { ErrorAlert, Loading, Modal, Spinner, useAsync } from '../../components/ui';

const blank = (): Organization => ({ id: '', code: '', name: '', active: true, attributes: {} });

/** Attribute keys referenced by "organization value" columns in any rule set. */
function usedKeys(types: FileTypeDefinition[]): { key: string; usedBy: string[] }[] {
  const m = new Map<string, Set<string>>();
  for (const t of types) for (const c of t.columns) if (c.orgValue) m.set(c.orgValue, (m.get(c.orgValue) ?? new Set()).add(`${t.id} ${c.letter}`));
  return [...m.entries()].map(([key, s]) => ({ key, usedBy: [...s] })).sort((a, b) => a.key.localeCompare(b.key));
}

export function OrganizationsPage() {
  const { data, error, loading, reload } = useAsync(() => Promise.all([api.organizations(), api.fileTypes()]), []);
  const [editing, setEditing] = useState<{ org: Organization; isNew: boolean } | null>(null);
  if (loading) return <Loading />;
  if (error || !data) return <ErrorAlert error={error} />;
  const [orgs, types] = data;
  const keys = usedKeys(types);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Organizations</h1>
          <p>Optional groups of submitters (agencies, vendors, departments…). Each organization has a code for file names and its own values that columns can be checked against.</p>
        </div>
        <button className="btn primary" onClick={() => setEditing({ org: blank(), isNew: true })}>
          + New organization
        </button>
      </div>
      <div className="alert info small">
        Users without an organization can still validate files — organization-specific checks are simply skipped. In AWS, a user is linked to an organization with the Cognito attribute{' '}
        <code>custom:orgId</code>. All values shown are <strong>synthetic</strong>.
      </div>
      <div className="card tight">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Code</th>
                <th>Values</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => {
                const missing = keys.filter((k) => !(o.attributes[k.key] ?? '').length);
                return (
                  <tr key={o.id}>
                    <td className="mono">{o.id}</td>
                    <td>{o.name}</td>
                    <td className="mono">{o.code}</td>
                    <td className="small">
                      <div className="chips">
                        {Object.entries(o.attributes).slice(0, 6).map(([k, v]) => (
                          <span className="chip" key={k}>
                            <span className="muted">{k}</span> <span className="mono">{v}</span>
                          </span>
                        ))}
                        {Object.keys(o.attributes).length > 6 && <span className="chip">+{Object.keys(o.attributes).length - 6} more</span>}
                      </div>
                      {missing.length > 0 && <div className="sev-warning small" style={{ marginTop: 4 }}>Missing: {missing.map((m) => m.key).join(', ')}</div>}
                    </td>
                    <td>{o.active ? <span className="badge ok">Active</span> : <span className="badge neutral">Inactive</span>}</td>
                    <td>
                      <button className="btn small" onClick={() => setEditing({ org: structuredClone(o), isNew: false })}>
                        Edit
                      </button>
                    </td>
                  </tr>
                );
              })}
              {orgs.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No organizations yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {editing && (
        <OrgModal
          initial={editing.org}
          isNew={editing.isNew}
          keys={keys}
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

function OrgModal({ initial, isNew, keys, onClose, onSaved }: { initial: Organization; isNew: boolean; keys: { key: string; usedBy: string[] }[]; onClose: () => void; onSaved: () => void }) {
  const [o, setO] = useState(initial);
  const [rows, setRows] = useState<[string, string][]>(() => {
    const r = Object.entries(initial.attributes);
    for (const k of keys) if (!(k.key in initial.attributes)) r.push([k.key, '']);
    return r;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const usedBy = new Map(keys.map((k) => [k.key, k.usedBy]));

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const attributes = Object.fromEntries(rows.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));
      await api.saveOrganization({ ...o, attributes });
      onSaved();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={isNew ? 'New organization' : `Edit ${initial.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !o.id || !o.code || !o.name}>
            {busy && <Spinner />} Save organization
          </button>
        </>
      }
    >
      <ErrorAlert error={error} />
      <div className="form-grid">
        <label className="field">
          ID
          <input className="mono" value={o.id} disabled={!isNew} onChange={(e) => setO({ ...o, id: e.target.value.replace(/[^A-Za-z0-9]/g, '') })} />
        </label>
        <label className="field">
          Code <span className="hint">Used for {'{ORG}'} in file names</span>
          <input className="mono" value={o.code} onChange={(e) => setO({ ...o, code: e.target.value.replace(/[^A-Za-z0-9]/g, '') })} />
        </label>
        <label className="field">
          Name
          <input value={o.name} onChange={(e) => setO({ ...o, name: e.target.value })} />
        </label>
        <label className="field">
          Status
          <select value={o.active ? 'y' : 'n'} onChange={(e) => setO({ ...o, active: e.target.value === 'y' })}>
            <option value="y">Active</option>
            <option value="n">Inactive</option>
          </select>
        </label>
      </div>
      <h3 style={{ marginTop: 18 }}>Organization values</h3>
      <p className="muted small">Columns set to “must match the organization's value” compare against these exactly — spaces and capitalization count.</p>
      <div className="grid" style={{ gap: 8 }}>
        {rows.map(([k, v], i) => (
          <div className="row" key={i} style={{ flexWrap: 'nowrap' }}>
            <input className="mono" style={{ width: '40%' }} placeholder="key" value={k} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [e.target.value.replace(/[^A-Za-z0-9_]/g, ''), r[1]] : r)))} />
            <input className="mono" style={{ flex: 1 }} placeholder="value" value={v} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
            <button className="btn small ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove">
              ✕
            </button>
            {usedBy.has(k) && <span className="muted small" style={{ whiteSpace: 'nowrap' }}>{usedBy.get(k)!.slice(0, 3).join(', ')}</span>}
          </div>
        ))}
        <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setRows([...rows, ['', '']])}>
          + Add value
        </button>
      </div>
    </Modal>
  );
}
