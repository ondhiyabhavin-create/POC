import { useState } from 'react';
import type { FileTypeDefinition } from '@odr/shared';
import { api } from '../api';
import { ErrorAlert, Modal, Spinner } from './ui';

/** Confirms deleting a file type; offers to remove rules in other types that reference it. */
export function DeleteFileTypeDialog({ def, allTypes, onClose, onDeleted }: { def: FileTypeDefinition; allTypes: FileTypeDefinition[]; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const refs = allTypes.filter((t) => t.id !== def.id && t.fileRules.some((r) => r.type === 'existsInPrior' && r.sourceFileTypeId === def.id));

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteFileType(def.id, refs.length > 0);
      onDeleted();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Delete ${def.name || def.id}?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger-solid" onClick={run} disabled={busy}>
            {busy && <Spinner />} {refs.length ? `Delete and remove ${refs.length} linked rule${refs.length === 1 ? '' : 's'}` : 'Delete file type'}
          </button>
        </>
      }
    >
      <ErrorAlert error={error} />
      <p>
        <strong>{def.name}</strong> <code>{def.id}</code> and its {def.columns.length} columns and {def.rowRules.length + def.fileRules.length} rules will be deleted. Past submissions and their
        reports are kept.
      </p>
      {refs.length > 0 && (
        <div className="alert warn">
          <strong>Other file types check values against {def.name}:</strong>
          <ul>
            {refs.map((r) => (
              <li key={r.id}>
                {r.name} ({r.id}) — “must exist in a previous {def.id} file” rule
              </li>
            ))}
          </ul>
          Those rules will be removed too (each of those file types gets a new version).
        </div>
      )}
    </Modal>
  );
}
