import { useMemo, useState } from 'react';
import { DEFAULT_CSV_OPTIONS, DEFAULT_FILE_NAME_PATTERN, describeFileName, fileNameRegex, type CsvOptions, type FileTypeDefinition, type Organization } from '@odr/shared';

const DELIMITERS: { value: string; label: string }[] = [
  { value: ',', label: 'Comma  ,' },
  { value: ';', label: 'Semicolon  ;' },
  { value: '\\t', label: 'Tab' },
  { value: '|', label: 'Pipe  |' },
];
const TOKENS = ['{ORG}', '{TYPE}', '{YYYYMMDD}', '{YYMMDD}', '{MMDDYYYY}', '{XXXXXX}', '{####}', '{ANY}'];
const TOKEN_HELP: Record<string, string> = {
  '{ORG}': 'organization code',
  '{TYPE}': 'file type code',
  '{YYYYMMDD}': 'date, e.g. 20261024',
  '{YYMMDD}': 'date, e.g. 261024',
  '{MMDDYYYY}': 'date, e.g. 10242026',
  '{XXXXXX}': 'exactly that many letters/digits',
  '{####}': 'exactly that many digits',
  '{ANY}': 'anything',
};

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle-row">
      <span className="toggle-text">
        <span>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <span className={`switch ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} tabIndex={0} onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), onChange(!checked))}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="knob" />
      </span>
      <span className="toggle-state">{checked ? 'Yes' : 'No'}</span>
    </label>
  );
}

const num = (v: string) => (v.trim() === '' ? undefined : Math.trunc(Number(v)));

/** The "file validation template" settings for a file type. */
export function TemplateSettings({
  def,
  update,
  isNew,
  orgs,
  onImport,
  onTest,
}: {
  def: FileTypeDefinition;
  update: (patch: Partial<FileTypeDefinition>) => void;
  isNew: boolean;
  orgs: Organization[];
  onImport: () => void;
  onTest: () => void;
}) {
  const formats = def.formats ?? { csv: true, xlsx: true };
  const csv: CsvOptions = { ...DEFAULT_CSV_OPTIONS, ...(def.csv ?? {}) };
  const setCsv = (patch: Partial<CsvOptions>) => update({ csv: { ...csv, ...patch } });
  const customDelim = !DELIMITERS.some((d) => d.value === csv.delimiter);
  const pattern = def.fileNamePattern ?? '';
  const exts = [formats.csv && 'csv', formats.xlsx && 'xlsx'].filter(Boolean) as string[];
  const example = describeFileName(pattern || DEFAULT_FILE_NAME_PATTERN, def.id || 'CODE', orgs[0]?.code, exts)
    .replace('YYYYMMDD', '20261024')
    .replace('YYMMDD', '261024')
    .replace('MMDDYYYY', '10242026')
    .replace(/\{(X+)\}/gi, (_, x: string) => 'A1B2C3D4E5F6'.slice(0, x.length))
    .replace(/\{(#+)\}/g, (_, x: string) => '123456789'.slice(0, x.length))
    .replace('…', 'anything');
  const [tryName, setTryName] = useState('');
  const nameOk = useMemo(() => {
    if (!tryName.trim()) return undefined;
    try {
      return fileNameRegex(pattern || DEFAULT_FILE_NAME_PATTERN, def.id, undefined, exts).test(tryName.trim());
    } catch {
      return false;
    }
  }, [tryName, pattern, def.id, exts]);

  const min = def.minRecords ?? 1;
  const headerRow = def.headerRow ?? 1;
  const start = def.dataStartRow ?? headerRow + 1;
  const errMin = min < 1 ? 'Must be at least 1.' : '';
  const errMax = def.maxRecords !== undefined && def.maxRecords < min ? `Cannot be less than the minimum (${min}).` : '';
  const errHeader = headerRow < 1 ? 'Must be at least 1.' : '';
  const errStart = start <= headerRow ? `Must be after the header row (${headerRow}).` : '';

  return (
    <div className="card settings-card">
      <div className="settings-head">
        <div>
          <h2>File validation template</h2>
          <p className="muted small">How files of this type must look. Columns and rules are on the tabs below.</p>
        </div>
        <div className="row">
          <button className="btn" onClick={onImport}>
            ⇪ Upload sample template
          </button>
          <button className="btn" onClick={onTest} disabled={def.columns.length === 0}>
            🧪 Validate a sample file
          </button>
        </div>
      </div>

      <section className="settings-section">
        <h3>Template</h3>
        <div className="form-grid">
          <label className="field">
            Name
            <span className="hint">Shown to people validating files</span>
            <input value={def.name} onChange={(e) => update({ name: e.target.value })} placeholder="e.g. Placement" />
          </label>
          <label className="field">
            Code
            <span className="hint">Short unique code, used for {'{TYPE}'} in file names</span>
            <input value={def.id} disabled={!isNew} maxLength={10} onChange={(e) => update({ id: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} placeholder="e.g. PLC" />
          </label>
          <label className="field">
            Availability
            <span className="hint">Inactive templates are hidden from submitters</span>
            <select value={def.active ? 'yes' : 'no'} onChange={(e) => update({ active: e.target.value === 'yes' })}>
              <option value="yes">Active</option>
              <option value="no">Inactive</option>
            </select>
          </label>
        </div>
        <label className="field" style={{ marginTop: 14 }}>
          Description
          <textarea rows={2} value={def.description ?? ''} onChange={(e) => update({ description: e.target.value })} />
        </label>
      </section>

      <section className="settings-section">
        <h3>Allowed file types</h3>
        <div className="check-cards">
          <label className={`check-card ${formats.xlsx ? 'on' : ''}`}>
            <input type="checkbox" checked={formats.xlsx} onChange={(e) => update({ formats: { ...formats, xlsx: e.target.checked } })} />
            <span className="check-card-icon">📗</span>
            <span>
              <strong>Excel</strong>
              <span className="hint">.xlsx</span>
            </span>
          </label>
          <label className={`check-card ${formats.csv ? 'on' : ''}`}>
            <input type="checkbox" checked={formats.csv} onChange={(e) => update({ formats: { ...formats, csv: e.target.checked } })} />
            <span className="check-card-icon">📄</span>
            <span>
              <strong>Comma separated</strong>
              <span className="hint">.csv</span>
            </span>
          </label>
        </div>
        {!formats.csv && !formats.xlsx && <div className="field-error">Allow at least one file type.</div>}
        {formats.csv && (
          <div className="sub-panel">
            <div className="sub-panel-title">CSV options</div>
            <div className="form-grid">
              <label className="field">
                Delimiter
                <select value={customDelim ? 'custom' : csv.delimiter} onChange={(e) => setCsv({ delimiter: e.target.value === 'custom' ? '~' : e.target.value })}>
                  {DELIMITERS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                  <option value="custom">Other…</option>
                </select>
                {customDelim && <input className="mono" maxLength={1} value={csv.delimiter} onChange={(e) => setCsv({ delimiter: e.target.value })} placeholder="one character" />}
              </label>
              <label className="field">
                Encoding
                <select value={csv.encoding} onChange={(e) => setCsv({ encoding: e.target.value as CsvOptions['encoding'] })}>
                  <option value="utf-8">UTF-8 (BOM optional)</option>
                  <option value="utf-8-no-bom">UTF-8 without BOM</option>
                  <option value="utf-8-bom">UTF-8 with BOM</option>
                  <option value="windows-1252">ANSI / Windows-1252</option>
                </select>
              </label>
              <label className="field">
                Quoting
                <select value={csv.quote} onChange={(e) => setCsv({ quote: e.target.value as CsvOptions['quote'] })}>
                  <option value={'"'}>Double quotes " "</option>
                  <option value={"'"}>Single quotes ' '</option>
                  <option value="none">No quoting</option>
                </select>
              </label>
              <label className="field">
                Line endings
                <select value={csv.lineEnding} onChange={(e) => setCsv({ lineEnding: e.target.value as CsvOptions['lineEnding'] })}>
                  <option value="any">Any</option>
                  <option value="crlf">Windows (CRLF)</option>
                  <option value="lf">Unix / Mac (LF)</option>
                </select>
              </label>
            </div>
          </div>
        )}
      </section>

      <section className="settings-section">
        <h3>File name</h3>
        <div className="form-grid">
          <label className="field">
            Pattern
            <input className="mono" value={pattern} placeholder={DEFAULT_FILE_NAME_PATTERN} onChange={(e) => update({ fileNamePattern: e.target.value })} />
            <span className="token-list">
              {TOKENS.map((t) => (
                <button type="button" key={t} className="token" title={TOKEN_HELP[t]} onClick={() => update({ fileNamePattern: `${pattern}${t}` })}>
                  {t}
                </button>
              ))}
            </span>
            {!def.fileRules.some((r) => r.type === 'fileName') && <span className="field-warn">The file name is not checked — add a “File naming convention” rule on the File rules tab.</span>}
          </label>
          <div className="field">
            Example
            <code className="example-name">{example}</code>
            <input placeholder="Try a file name…" value={tryName} onChange={(e) => setTryName(e.target.value)} />
            {nameOk !== undefined && <span className={nameOk ? 'field-ok' : 'field-error'}>{nameOk ? '✓ Matches the pattern' : '✕ Does not match'}</span>}
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h3>Records &amp; rows</h3>
        <div className="form-grid">
          <label className="field">
            Minimum records
            <span className="hint">At least 1</span>
            <input type="number" min={1} value={def.minRecords ?? 1} onChange={(e) => update({ minRecords: num(e.target.value) ?? 1 })} />
            {errMin && <span className="field-error">{errMin}</span>}
          </label>
          <label className="field">
            Maximum records
            <span className="hint">Blank = no limit</span>
            <input type="number" min={min} value={def.maxRecords ?? ''} placeholder="No limit" onChange={(e) => update({ maxRecords: num(e.target.value) })} />
            {errMax && <span className="field-error">{errMax}</span>}
          </label>
          <label className="field">
            Header row number
            <span className="hint">Row that holds the column names</span>
            <input
              type="number"
              min={1}
              value={headerRow}
              onChange={(e) => {
                const h = num(e.target.value) ?? 1;
                update({ headerRow: h, dataStartRow: def.dataStartRow !== undefined && def.dataStartRow > h ? def.dataStartRow : undefined });
              }}
            />
            {errHeader && <span className="field-error">{errHeader}</span>}
          </label>
          <label className="field">
            Records start on row
            <span className="hint">Default: header row + 1</span>
            <input type="number" min={headerRow + 1} value={def.dataStartRow ?? ''} placeholder={String(headerRow + 1)} onChange={(e) => update({ dataStartRow: num(e.target.value) })} />
            {errStart && <span className="field-error">{errStart}</span>}
          </label>
        </div>
      </section>

      <section className="settings-section">
        <h3>Columns, storage &amp; privacy</h3>
        <div className="toggle-grid">
          <Toggle
            label="Must follow column order"
            hint={def.enforceColumnOrder === false ? 'Columns are matched by header name, in any order' : 'Columns must appear exactly in the defined order'}
            checked={def.enforceColumnOrder !== false}
            onChange={(v) => update({ enforceColumnOrder: v ? undefined : false })}
          />
          <Toggle
            label="Exact header text"
            hint={def.headerMatch === 'strict' ? 'Headers must match exactly' : 'Ignores capitalization, spaces and punctuation'}
            checked={def.headerMatch === 'strict'}
            onChange={(v) => update({ headerMatch: v ? 'strict' : 'relaxed' })}
          />
          <Toggle
            label="Store the source file"
            hint={def.storeSourceFile === false ? 'Uploaded files are deleted right after validation' : 'Uploaded files are kept and can be downloaded later'}
            checked={def.storeSourceFile !== false}
            onChange={(v) => update({ storeSourceFile: v ? undefined : false })}
          />
          <Toggle
            label="Mask SSN/FEIN in error reports"
            hint="Shows only the last 4 digits of sensitive columns, e.g. *****6789"
            checked={!!def.maskSensitive}
            onChange={(v) => update({ maskSensitive: v || undefined })}
          />
        </div>
      </section>
    </div>
  );
}
