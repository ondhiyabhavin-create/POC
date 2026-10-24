import { useRef, useState, type DragEvent } from 'react';
import {
  analyzeCsvText,
  analyzeWorkbook,
  importToDefinition,
  isXlsx,
  readXlsx,
  type FileTypeDefinition,
  type ImportResult,
  type LookupList,
} from '@odr/shared';
import { columnRules } from '../pages/LayoutsPage';
import { Modal, Spinner } from './ui';

const TYPE_LABEL: Record<string, string> = { varchar: 'Text', numeric: 'Digits', int: 'Integer', money: 'Money', date: 'Date' };

/**
 * Upload a layout spreadsheet (e.g. ODR Attachment D) or a sample data file and
 * turn it into columns + rules. Runs entirely in the browser.
 */
export function ImportModal({ base, lookups, onApply, onClose }: { base: FileTypeDefinition; lookups: LookupList[]; onApply: (def: FileTypeDefinition) => void; onClose: () => void }) {
  const [result, setResult] = useState<ImportResult>();
  const [fileName, setFileName] = useState('');
  const [include, setInclude] = useState<boolean[]>([]);
  const [useSuggested, setUseSuggested] = useState<Record<number, boolean>>({});
  const [includeRules, setIncludeRules] = useState(true);
  const [mode, setMode] = useState<'replace' | 'append'>(base.columns.length ? 'append' : 'replace');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const analyze = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setBusy(true);
    setResult(undefined);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = isXlsx(bytes) ? analyzeWorkbook(readXlsx(bytes), lookups) : analyzeCsvText(new TextDecoder().decode(bytes), file.name);
      setResult(res);
      setFileName(file.name);
      setInclude(res.columns.map(() => true));
      setUseSuggested({});
      if (res.kind === 'spec' || base.columns.length === 0) setMode('replace');
    } catch (e) {
      setError((e as Error).message || 'Could not read this file.');
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    void analyze(e.dataTransfer.files[0]);
  };

  const apply = () => {
    if (!result) return;
    const columns = result.columns.map((c, i) => (useSuggested[i] && c.suggestedAllowed ? { ...c, allowedValues: c.suggestedAllowed } : c));
    onApply(importToDefinition(base, { ...result, columns, rowRules: includeRules ? result.rowRules : [] }, mode, include));
  };

  const picked = include.filter(Boolean).length;

  return (
    <Modal
      title="Import columns from a file"
      onClose={onClose}
      wide
      footer={
        result ? (
          <>
            <div className="seg" style={{ marginRight: 'auto' }}>
              <button type="button" className={mode === 'replace' ? 'on' : ''} onClick={() => setMode('replace')}>
                Replace all columns
              </button>
              <button type="button" className={mode === 'append' ? 'on' : ''} onClick={() => setMode('append')} disabled={base.columns.length === 0}>
                Add after existing ({base.columns.length})
              </button>
            </div>
            <button className="btn" onClick={() => setResult(undefined)}>
              Choose another file
            </button>
            <button className="btn primary" disabled={picked === 0} onClick={apply}>
              Use {picked} column{picked === 1 ? '' : 's'}
            </button>
          </>
        ) : undefined
      }
    >
      {!result && (
        <>
          <div className="grid cols-2" style={{ marginBottom: 16 }}>
            <div className="import-kind">
              <div className="import-kind-icon">📐</div>
              <div>
                <strong>Layout specification</strong>
                <p className="muted small">
                  A spreadsheet that describes the file: one row per field with columns like <em>Field, Datatype, Required/Optional, Format</em> (e.g. ODR Attachment D). Types, required flags, lengths, fixed values and allowed
                  lists are read from the text.
                </p>
              </div>
            </div>
            <div className="import-kind">
              <div className="import-kind-icon">📄</div>
              <div>
                <strong>Sample data file</strong>
                <p className="muted small">A real (or synthetic) file in the target layout. Row 1 becomes the column headers; data types and required flags are inferred from the values.</p>
              </div>
            </div>
          </div>
          <div
            className={`dropzone ${drag ? 'drag' : ''}`}
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
          >
            <div style={{ fontSize: '2rem' }}>{busy ? <Spinner /> : '⇪'}</div>
            <div>
              <strong>Click to choose</strong> or drag an .xlsx or .csv file here
            </div>
            <div className="muted small">The file is read in your browser — it is not uploaded or stored.</div>
            <input ref={input} type="file" accept=".csv,.xlsx" hidden onChange={(e) => analyze(e.target.files?.[0])} />
          </div>
          {error && (
            <div className="alert err" style={{ marginTop: 12 }}>
              {error}
            </div>
          )}
        </>
      )}

      {result && (
        <>
          <div className="import-summary">
            <span className={`badge ${result.kind === 'spec' ? 'info' : 'ok'}`}>{result.kind === 'spec' ? '📐 Layout specification' : '📄 Sample data'}</span>
            <span>
              <strong>{fileName}</strong> · sheet “{result.sourceSheet}” · {result.columns.length} columns
              {result.rowsAnalyzed !== undefined && ` · ${result.rowsAnalyzed} rows analysed`}
            </span>
          </div>
          {(result.meta.name || result.meta.id || result.meta.fileNamePattern) && (
            <div className="alert info small">
              Detected: {result.meta.name && <strong>{result.meta.name}</strong>} {result.meta.id && <code>{result.meta.id}</code>} {result.meta.fileNamePattern && <>· file names <code>{result.meta.fileNamePattern}</code></>}
              {base.id ? <span className="muted"> — existing name/code are kept.</span> : <span className="muted"> — used for the new file type.</span>}
            </div>
          )}
          {result.notes.length > 0 && (
            <div className="alert warn small">
              <ul style={{ margin: 0 }}>
                {result.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="table-wrap import-table">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input type="checkbox" checked={picked === include.length} onChange={(e) => setInclude(include.map(() => e.target.checked))} aria-label="Select all" />
                  </th>
                  <th>Col</th>
                  <th>Header</th>
                  <th>Type</th>
                  <th>Req.</th>
                  <th>Checks &amp; notes</th>
                </tr>
              </thead>
              <tbody>
                {result.columns.map((c, i) => (
                  <tr key={i} className={include[i] ? '' : 'excluded'}>
                    <td>
                      <input type="checkbox" checked={include[i]} onChange={(e) => setInclude(include.map((v, j) => (j === i ? e.target.checked : v)))} aria-label={`Include ${c.header}`} />
                    </td>
                    <td className="mono">
                      <strong>{c.letter}</strong>
                    </td>
                    <td>
                      {c.header}
                      <div className="muted small mono">{c.key}</div>
                    </td>
                    <td className="small">{TYPE_LABEL[c.dataType]}</td>
                    <td>{c.required ? <span className="badge err">R</span> : <span className="badge neutral">O</span>}</td>
                    <td className="small">
                      <div>{columnRules(c, []).join(' · ')}</div>
                      {c.notes
                        .filter((n) => !/^(Exactly|At most|Date in|Allowed values|Fixed value|Organization-specific|Checked against lookup|Negative amounts|When provided)/.test(n))
                        .map((n) => (
                          <div key={n} className="muted">
                            {n}
                          </div>
                        ))}
                      {c.suggestedAllowed && (
                        <label className="row small" style={{ gap: 6, marginTop: 4 }}>
                          <input type="checkbox" checked={!!useSuggested[i]} onChange={(e) => setUseSuggested({ ...useSuggested, [i]: e.target.checked })} />
                          Only allow seen values: {c.suggestedAllowed.map((v) => `"${v}"`).join(', ')}
                        </label>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.rowRules.length > 0 && (
            <label className="row small" style={{ gap: 8, marginTop: 12 }}>
              <input type="checkbox" checked={includeRules} onChange={(e) => setIncludeRules(e.target.checked)} />
              Also add {result.rowRules.length} detected rule(s): {result.rowRules.map((r) => r.description).join('; ')}
            </label>
          )}
        </>
      )}
    </Modal>
  );
}
