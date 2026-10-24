import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  DEFAULT_FILE_NAME_PATTERN,
  LOOKUPS,
  adjustmentRecords,
  directPaymentRecords,
  placementRecords,
  recallRecords,
  recordsToCsv,
  templateCsv,
  todayStamp,
  type FileTypeDefinition,
  type Organization,
  type SyntheticRecord,
} from '@odr/shared';
import { api, downloadText } from '../api';
import { useAuth } from '../auth';
import { ErrorAlert, Loading, Spinner, useAsync } from '../components/ui';

export function ValidatePage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data, error: loadError, loading } = useAsync(() => Promise.all([api.fileTypes(), api.organizations()]), []);
  const [fileTypeId, setFileTypeId] = useState(params.get('type') ?? '');
  const [orgId, setOrgId] = useState(user?.orgId ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const input = useRef<HTMLInputElement>(null);

  const fileTypes = (data?.[0] ?? []).filter((f) => f.active);
  const orgs = (data?.[1] ?? []).filter((a) => a.active);
  const fileType = fileTypes.find((f) => f.id === fileTypeId);
  const org = orgs.find((a) => a.id === orgId);

  // Guess the file type from the name (e.g. CCSV_REC_20261024.csv).
  useEffect(() => {
    if (!file || !fileTypes.length) return;
    const m = /_([A-Z][A-Z0-9]{1,9})_\d{8}\.(csv|xlsx)$/i.exec(file.name);
    const guess = m && fileTypes.find((f) => f.id === m[1].toUpperCase());
    if (guess) setFileTypeId(guess.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, data]);

  const pick = (f: File | undefined | null) => {
    setError(undefined);
    if (!f) return;
    if (!/\.(csv|xlsx)$/i.test(f.name)) {
      setError(new Error('Please choose a .csv or .xlsx file. Older .xls workbooks must be re-saved as .xlsx or .csv.'));
      return;
    }
    setFile(f);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    pick(e.dataTransfer.files[0]);
  };

  const submit = async () => {
    if (!file || !fileType) return;
    setBusy(true);
    setError(undefined);
    try {
      const sub = await api.validate(file, fileType.id, isAdmin ? orgId || undefined : undefined);
      navigate(`/submissions/${sub.id}`, { state: { fresh: true } });
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  if (loading) return <Loading />;
  if (loadError) return <ErrorAlert error={loadError} />;

  const step = !fileType ? 1 : !file ? 2 : 3;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Validate a file</h1>
          <p>Check your file against the format and business rules before you submit it. CSV and Excel (.xlsx) files are accepted.</p>
        </div>
      </div>

      <ol className="steps">
        <li className={step > 1 ? 'done' : 'current'}>Choose file type</li>
        <li className={step > 2 ? 'done' : step === 2 ? 'current' : ''}>Select your CSV file</li>
        <li className={step === 3 ? 'current' : ''}>Validate &amp; review results</li>
      </ol>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <h2>1. File details</h2>
          <div className="grid">
            {isAdmin && (
              <label className="field">
                Organization <span className="hint">Optional. Organization-specific checks are skipped when none is selected.</span>
                <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                  <option value="">No organization</option>
                  {orgs.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.code})
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              File type
              <select value={fileTypeId} onChange={(e) => setFileTypeId(e.target.value)}>
                <option value="">Select a file type…</option>
                {fileTypes.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} ({f.id})
                  </option>
                ))}
              </select>
            </label>
            {fileType && <FileTypeHint def={fileType} org={org} />}
          </div>
        </div>

        <div className="card">
          <h2>2. Your file</h2>
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
            <div style={{ fontSize: '2rem' }}>📄</div>
            <div>
              <strong>Click to choose</strong> or drag a CSV or Excel file here
            </div>
            <div className="muted small">.csv or .xlsx · up to 25 MB</div>
            <input ref={input} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => pick(e.target.files?.[0])} />
          </div>
          {file && (
            <div className="file-chip">
              <span>📎</span>
              <div>
                <div>
                  <strong>{file.name}</strong>
                </div>
                <div className="muted small">{(file.size / 1024).toFixed(1)} KB</div>
              </div>
              <button className="btn ghost small" onClick={() => setFile(null)} aria-label="Remove file">
                ✕
              </button>
            </div>
          )}
          <ErrorAlert error={error} />
          <div className="row" style={{ marginTop: 16 }}>
            <span className="spacer" />
            <button className="btn primary" disabled={!file || !fileType || busy} onClick={submit}>
              {busy ? (
                <>
                  <Spinner /> Validating…
                </>
              ) : (
                'Validate file'
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function FileTypeHint({ def, org }: { def: FileTypeDefinition; org?: Organization }) {
  const code = org?.code ?? 'ORG';
  const name = (def.fileNamePattern || DEFAULT_FILE_NAME_PATTERN).replace('{ORG}', code).replace('{TYPE}', def.id).replace('{YYYYMMDD}', todayStamp()).replace('{ANY}', 'file');
  const sample = org ? sampleCsv(def, org) : undefined;
  return (
    <div className="alert info" style={{ marginBottom: 0 }}>
      <div>
        <strong>{def.name}</strong> — {def.columns.length} columns (A–{def.columns[def.columns.length - 1]?.letter}).
      </div>
      {def.fileRules.some((r) => r.type === 'fileName') && (
        <div className="small">
          File name: <code>{name}</code> (.csv or .xlsx)
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn small" onClick={() => downloadText(`${def.id}_TEMPLATE.csv`, templateCsv(def))}>
          ⬇ Blank template
        </button>
        {sample && (
          <button className="btn small" onClick={() => downloadText(name.replace(/\.xlsx$/i, '.csv'), sample())}>
            ⬇ Synthetic sample
          </button>
        )}
      </div>
    </div>
  );
}

/** Synthetic sample files for the built-in example types (fake data only). */
function sampleCsv(def: FileTypeDefinition, org: Organization): (() => string) | undefined {
  const placed = () => placementRecords(org, 10, Date.now() % 1000);
  const gen: Record<string, () => SyntheticRecord[]> = {
    PLC: placed,
    REC: () => recallRecords(org, placed(), LOOKUPS.find((l) => l.id === 'RECALL_REASON_CODES')!.values),
    ADJ: () => adjustmentRecords(org, placed()),
    DPF: () => directPaymentRecords(org, placed()),
  };
  const make = gen[def.id];
  return make && (() => recordsToCsv(def, make()));
}
