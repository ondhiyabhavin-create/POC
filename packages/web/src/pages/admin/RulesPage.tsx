import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { FileTypeDefinition } from '@odr/shared';
import { DeleteFileTypeDialog } from '../../components/DeleteFileTypeDialog';
import { api } from '../../api';
import { ErrorAlert, fmtDateTime, Loading, useAsync } from '../../components/ui';

export function RulesPage() {
  const { data, error, loading, reload } = useAsync(() => api.fileTypes(), []);
  const [deleting, setDeleting] = useState<FileTypeDefinition | null>(null);
  const navigate = useNavigate();
  if (loading) return <Loading />;
  if (error || !data) return <ErrorAlert error={error} />;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Validation rules</h1>
          <p>Each file type is a rule set: its column layout, per-column checks, IF/THEN rules and file-level rules. Start from a layout spreadsheet or sample file, or build one by hand. Changes apply to the next file validated.</p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => navigate('/admin/rules/new')}>
            + Blank file type
          </button>
          <button className="btn primary" onClick={() => navigate('/admin/rules/new?import=1')}>
            ⇪ New file type from spreadsheet
          </button>
        </div>
      </div>
      <div className="card tight">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>File type</th>
              <th className="num">Columns</th>
              <th className="num">IF/THEN &amp; cross-field</th>
              <th className="num">File rules</th>
              <th>Version</th>
              <th>Last changed</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((f) => (
              <tr key={f.id}>
                <td className="mono">
                  <strong>{f.id}</strong>
                </td>
                <td>
                  <Link to={`/admin/rules/${f.id}`}>{f.name}</Link>
                  <div className="muted small">{f.description}</div>
                </td>
                <td className="num">{f.columns.length}</td>
                <td className="num">{f.rowRules.length}</td>
                <td className="num">{f.fileRules.length}</td>
                <td>v{f.version}</td>
                <td className="small">
                  {fmtDateTime(f.updatedAt)}
                  <div className="muted">{f.updatedBy}</div>
                </td>
                <td>{f.active ? <span className="badge ok">Active</span> : <span className="badge neutral">Inactive</span>}</td>
                <td>
                  <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                    <Link className="btn small" to={`/admin/rules/${f.id}`}>
                      Edit
                    </Link>
                    <button className="btn small danger" onClick={() => setDeleting(f)} aria-label={`Delete ${f.name}`}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {deleting && (
        <DeleteFileTypeDialog
          def={deleting}
          allTypes={data}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            void reload();
          }}
        />
      )}
    </>
  );
}
