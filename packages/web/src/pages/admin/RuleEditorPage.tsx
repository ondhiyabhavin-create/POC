import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  DEFAULT_FILE_NAME_PATTERN,
  checkFileTypeDefinition,
  columnLetter,
  isXlsx,
  tableFromCsv,
  tableFromXlsx,
  validateTable,
  type Organization,
  type ColumnCheck,
  type ColumnDefinition,
  type ConditionOperator,
  type DataType,
  type FileRule,
  type FileTypeDefinition,
  type LookupList,
  type RowRule,
  type Severity,
  type ValidationResult,
} from '@odr/shared';
import { api } from '../../api';
import { ConditionalRuleModal, newConditionalRule, type ConditionalRule } from '../../components/ConditionBuilder';
import { ImportModal } from '../../components/ImportModal';
import { ErrorAlert, Loading, Modal, Spinner, StatusBadge, SummaryStats, useAsync } from '../../components/ui';
import { columnRules, ruleText } from '../LayoutsPage';

const DATA_TYPES: { value: DataType; label: string }[] = [
  { value: 'varchar', label: 'Text (VarChar)' },
  { value: 'numeric', label: 'Digits only (Numeric)' },
  { value: 'int', label: 'Whole number (Int)' },
  { value: 'money', label: 'Money (123.45)' },
  { value: 'date', label: 'Date (CCYY-MM-DD)' },
];
const CHECKS: { value: ColumnCheck; label: string }[] = [
  { value: 'required', label: 'Required' },
  { value: 'dataType', label: 'Data type' },
  { value: 'length', label: 'Length' },
  { value: 'pattern', label: 'Format pattern' },
  { value: 'allowedValues', label: 'Allowed values' },
  { value: 'fixedValue', label: 'Fixed / organization value' },
];
const ROW_RULE_TYPES: { value: RowRule['type']; label: string }[] = [
  { value: 'requiredWhen', label: 'Required when (conditional required)' },
  { value: 'patternWhen', label: 'Format when (conditional format)' },
  { value: 'allOrNone', label: 'All or none' },
  { value: 'atLeastOne', label: 'At least one of' },
  { value: 'equalColumns', label: 'Two columns must match' },
  { value: 'dateOrder', label: 'Date order' },
];
const FILE_RULE_TYPES: { value: FileRule['type']; label: string }[] = [
  { value: 'fileName', label: 'File naming convention' },
  { value: 'notEmpty', label: 'File must not be empty' },
  { value: 'duplicateKey', label: 'Duplicate key detection' },
  { value: 'duplicateRow', label: 'Duplicate record detection' },
  { value: 'existsInPrior', label: 'Value must exist in previously passed files' },
];
const OPERATORS: { value: ConditionOperator; label: string }[] = [
  { value: 'equals', label: 'equals' },
  { value: 'notEquals', label: 'does not equal' },
  { value: 'in', label: 'is one of (comma separated)' },
  { value: 'notIn', label: 'is not one of (comma separated)' },
  { value: 'isEmpty', label: 'is blank' },
  { value: 'isNotEmpty', label: 'is provided' },
];

const blankType = (): FileTypeDefinition => ({
  id: '',
  name: '',
  description: '',
  active: false,
  headerMatch: 'relaxed',
  fileNamePattern: DEFAULT_FILE_NAME_PATTERN,
  version: 0,
  updatedAt: new Date().toISOString(),
  columns: [],
  rowRules: [],
  fileRules: [
    { id: 'fileName', type: 'fileName', severity: 'error' },
    { id: 'notEmpty', type: 'notEmpty', severity: 'error' },
    { id: 'duplicateRow', type: 'duplicateRow', severity: 'error' },
  ],
});

const toKey = (header: string) =>
  header
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('')
    .replace(/^(\d)/, 'c$1') || 'column';

const ruleId = (prefix: string) => `${prefix}.${Math.random().toString(36).slice(2, 8)}`;

export function RuleEditorPage() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data, error, loading } = useAsync(
    () => Promise.all([isNew ? Promise.resolve(blankType()) : api.fileType(id), api.lookups(), api.organizations(), api.fileTypes()]),
    [id],
  );
  const [importOpen, setImportOpen] = useState(isNew && params.get('import') === '1');
  const [editCond, setEditCond] = useState<{ index: number; rule: ConditionalRule } | null>(null);
  const [def, setDef] = useState<FileTypeDefinition>();
  const [tab, setTab] = useState<'columns' | 'row' | 'file' | 'test'>('columns');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  const [editCol, setEditCol] = useState<{ index: number; col: ColumnDefinition } | null>(null);
  const [editRow, setEditRow] = useState<{ index: number; rule: RowRule } | null>(null);
  const [editFile, setEditFile] = useState<{ index: number; rule: FileRule } | null>(null);

  useEffect(() => {
    if (data) setDef(structuredClone(data[0]));
  }, [data]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => dirty && e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const lookups = data?.[1] ?? [];
  const orgs = data?.[2] ?? [];
  const allTypes = data?.[3] ?? [];
  const orgKeys = useMemo(() => [...new Set(orgs.flatMap((o) => Object.keys(o.attributes)))].sort(), [orgs]);
  const problems = useMemo(
    () => (def ? checkFileTypeDefinition({ ...def, columns: relabel(def.columns) }, lookups, allTypes.map((t) => t.id)) : []),
    [def, lookups, allTypes],
  );

  if (loading) return <Loading />;
  if (error || !def) return <ErrorAlert error={error} />;

  const update = (patch: Partial<FileTypeDefinition>) => {
    setDef({ ...def, ...patch });
    setDirty(true);
    setSaved(false);
  };
  const setColumns = (columns: ColumnDefinition[]) => update({ columns: relabel(columns) });

  const save = async () => {
    setSaving(true);
    setSaveError(undefined);
    try {
      const res = await api.saveFileType(def, isNew);
      setDef(res);
      setDirty(false);
      setSaved(true);
      if (isNew) navigate(`/admin/rules/${res.id}`, { replace: true });
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete the ${def.name} file type? Past submissions are kept, but no new files can be validated against it.`)) return;
    try {
      await api.deleteFileType(def.id);
      navigate('/admin/rules', { replace: true });
    } catch (e) {
      setSaveError(e);
    }
  };

  const move = (i: number, d: -1 | 1) => {
    const cols = [...def.columns];
    const j = i + d;
    if (j < 0 || j >= cols.length) return;
    [cols[i], cols[j]] = [cols[j], cols[i]];
    setColumns(cols);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="muted small">
            <Link to="/admin/rules">Validation rules</Link> / {isNew ? 'New file type' : def.id}
          </div>
          <h1>{isNew ? 'New file type' : `${def.name} rule set`}</h1>
          <p>{isNew ? 'Define a new file type without any code changes.' : `Version ${def.version} · saving creates version ${def.version + 1}`}</p>
        </div>
        <div className="row">
          {!isNew && (
            <button className="btn danger" onClick={remove}>
              Delete
            </button>
          )}
          {dirty && <span className="badge warn">Unsaved changes</span>}
          {saved && !dirty && <span className="badge ok">✓ Saved</span>}
          <button className="btn primary" onClick={save} disabled={saving || !dirty || problems.length > 0}>
            {saving && <Spinner />} Save rule set
          </button>
        </div>
      </div>

      <ErrorAlert error={saveError} />
      {problems.length > 0 && (
        <div className="alert warn">
          <strong>Fix these before saving:</strong>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <div className="form-grid">
          <label className="field">
            File type code
            <span className="hint">Short unique code, used for {'{TYPE}'} in file names</span>
            <input value={def.id} disabled={!isNew} maxLength={10} onChange={(e) => update({ id: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />
          </label>
          <label className="field">
            Name
            <span className="hint">Shown to submitters</span>
            <input value={def.name} onChange={(e) => update({ name: e.target.value })} />
          </label>
          <label className="field">
            Header matching
            <span className="hint">Relaxed ignores capitalization, spaces and punctuation</span>
            <select value={def.headerMatch} onChange={(e) => update({ headerMatch: e.target.value as 'strict' | 'relaxed' })}>
              <option value="relaxed">Relaxed</option>
              <option value="strict">Strict (exact text)</option>
            </select>
          </label>
          <label className="field">
            Availability
            <span className="hint">Inactive types are hidden from submitters</span>
            <select value={def.active ? 'yes' : 'no'} onChange={(e) => update({ active: e.target.value === 'yes' })}>
              <option value="yes">Active</option>
              <option value="no">Inactive</option>
            </select>
          </label>
        </div>
        <div className="form-grid" style={{ marginTop: 14 }}>
          <label className="field">
            File naming convention
            <span className="hint">
              Tokens: {'{ORG}'} organization code · {'{TYPE}'} file type code · {'{YYYYMMDD}'} date · {'{ANY}'} anything. “.csv” also accepts “.xlsx”.
            </span>
            <input className="mono" value={def.fileNamePattern ?? ''} placeholder={DEFAULT_FILE_NAME_PATTERN} onChange={(e) => update({ fileNamePattern: e.target.value })} />
          </label>
          <div className="field">
            Example
            <span className="hint">What a valid file name looks like</span>
            <code className="example-name">
              {(def.fileNamePattern || DEFAULT_FILE_NAME_PATTERN).replace('{ORG}', orgs[0]?.code ?? 'ORG').replace('{TYPE}', def.id || 'CODE').replace('{YYYYMMDD}', '20261024').replace('{ANY}', 'anything')}
            </code>
          </div>
        </div>
        <label className="field" style={{ marginTop: 14 }}>
          Description
          <textarea rows={2} value={def.description ?? ''} onChange={(e) => update({ description: e.target.value })} />
        </label>
      </div>

      <div className="tabs">
        <button className={tab === 'columns' ? 'active' : ''} onClick={() => setTab('columns')}>
          Columns ({def.columns.length})
        </button>
        <button className={tab === 'row' ? 'active' : ''} onClick={() => setTab('row')}>
          Cross-field rules ({def.rowRules.length})
        </button>
        <button className={tab === 'file' ? 'active' : ''} onClick={() => setTab('file')}>
          File rules ({def.fileRules.length})
        </button>
        <button className={tab === 'test' ? 'active' : ''} onClick={() => setTab('test')}>
          🧪 Test rules
        </button>
      </div>

      {tab === 'columns' && (
        <div className="card tight">
          <div className="card-head">
            <span className="muted small">Columns are validated in this exact order. Click a column to edit its checks.</span>
            <span className="spacer" />
            <button className="btn small" onClick={() => setImportOpen(true)}>
              ⇪ Import columns from file
            </button>
            <button
              className="btn primary small"
              onClick={() =>
                setEditCol({ index: -1, col: { key: '', letter: columnLetter(def.columns.length), header: '', dataType: 'varchar', required: false } })
              }
            >
              + Add column
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Col</th>
                  <th>Header</th>
                  <th>Type</th>
                  <th>Required</th>
                  <th>Checks</th>
                  <th style={{ width: 150 }} />
                </tr>
              </thead>
              <tbody>
                {def.columns.map((c, i) => (
                  <tr key={`${c.key}-${i}`}>
                    <td className="mono">
                      <strong>{c.letter}</strong>
                    </td>
                    <td>
                      <a href="#" onClick={(e) => (e.preventDefault(), setEditCol({ index: i, col: structuredClone(c) }))}>
                        {c.header || <em>(no header)</em>}
                      </a>
                      <div className="muted small mono">{c.key}</div>
                    </td>
                    <td className="small">{DATA_TYPES.find((d) => d.value === c.dataType)?.label}</td>
                    <td>{c.required ? <span className="badge err">Required</span> : <span className="badge neutral">Optional</span>}</td>
                    <td className="small">
                      {columnRules(c, lookups).join(' · ') || <span className="muted">—</span>}
                      {c.severity && Object.keys(c.severity).length > 0 && (
                        <div className="muted">
                          Overrides: {Object.entries(c.severity).map(([k, v]) => `${k}=${v}`).join(', ')}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        <button className="btn small ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                          ↑
                        </button>
                        <button className="btn small ghost" onClick={() => move(i, 1)} disabled={i === def.columns.length - 1} aria-label="Move down">
                          ↓
                        </button>
                        <button
                          className="btn small danger"
                          onClick={() => confirm(`Remove column ${c.letter} "${c.header}"?`) && setColumns(def.columns.filter((_, j) => j !== i))}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {def.columns.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty">
                      <div style={{ marginBottom: 10 }}>No columns yet.</div>
                      <button className="btn primary" onClick={() => setImportOpen(true)}>
                        ⇪ Import all columns from a spreadsheet or sample file
                      </button>
                      <div className="muted small" style={{ marginTop: 8 }}>
                        or add them one by one with “+ Add column”
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'row' && (
        <RuleList
          title="Rules that look at more than one column in the same record — IF / AND / OR / THEN / ELSE, formulas and presets."
          rules={def.rowRules}
          columns={def.columns}
          addLabel="+ IF / THEN rule"
          onAdd={() => setEditCond({ index: -1, rule: newConditionalRule(def.columns, def.id.toLowerCase() || 'rule') })}
          extraAdd={
            <button
              className="btn small"
              disabled={def.columns.length === 0}
              onClick={() =>
                setEditRow({
                  index: -1,
                  rule: { id: ruleId(def.id.toLowerCase() || 'rule'), type: 'allOrNone', columns: [], severity: 'error' },
                })
              }
            >
              + Preset rule
            </button>
          }
          onEdit={(i) => {
            const r = def.rowRules[i];
            if (r.type === 'conditional') setEditCond({ index: i, rule: structuredClone(r) });
            else setEditRow({ index: i, rule: structuredClone(r) });
          }}
          onRemove={(i) => update({ rowRules: def.rowRules.filter((_, j) => j !== i) })}
          onSeverity={(i, s) => update({ rowRules: def.rowRules.map((r, j) => (j === i ? { ...r, severity: s } : r)) })}
        />
      )}

      {tab === 'file' && (
        <RuleList
          title="File-level rules look at the whole file, its name, or submission history."
          rules={def.fileRules}
          columns={def.columns}
          onAdd={() => setEditFile({ index: -1, rule: { id: ruleId(def.id.toLowerCase() || 'rule'), type: 'duplicateKey', columns: [], severity: 'warning' } })}
          onEdit={(i) => setEditFile({ index: i, rule: structuredClone(def.fileRules[i]) })}
          onRemove={(i) => update({ fileRules: def.fileRules.filter((_, j) => j !== i) })}
          onSeverity={(i, s) => update({ fileRules: def.fileRules.map((r, j) => (j === i ? { ...r, severity: s } : r)) })}
        />
      )}

      {tab === 'test' && <TestPanel def={def} lookups={lookups} orgs={orgs} />}

      {importOpen && (
        <ImportModal
          base={def}
          lookups={lookups}
          onClose={() => setImportOpen(false)}
          onApply={(next) => {
            update({ ...next, id: isNew ? next.id : def.id });
            setImportOpen(false);
            setTab('columns');
          }}
        />
      )}
      {editCond && (
        <ConditionalRuleModal
          initial={editCond.rule}
          columns={relabel(def.columns)}
          onClose={() => setEditCond(null)}
          onSave={(rule) => {
            const rules = [...def.rowRules];
            if (editCond.index === -1) rules.push(rule);
            else rules[editCond.index] = rule;
            update({ rowRules: rules });
            setEditCond(null);
          }}
        />
      )}

      {editCol && (
        <ColumnModal
          initial={editCol.col}
          lookups={lookups}
          orgKeys={orgKeys}
          existingKeys={def.columns.filter((_, i) => i !== editCol.index).map((c) => c.key)}
          onClose={() => setEditCol(null)}
          onSave={(col) => {
            const cols = [...def.columns];
            if (editCol.index === -1) cols.push(col);
            else cols[editCol.index] = col;
            setColumns(cols);
            setEditCol(null);
          }}
        />
      )}
      {editRow && (
        <RowRuleModal
          initial={editRow.rule}
          columns={def.columns}
          onClose={() => setEditRow(null)}
          onSave={(rule) => {
            const rules = [...def.rowRules];
            if (editRow.index === -1) rules.push(rule);
            else rules[editRow.index] = rule;
            update({ rowRules: rules });
            setEditRow(null);
          }}
        />
      )}
      {editFile && (
        <FileRuleModal
          initial={editFile.rule}
          columns={def.columns}
          fileTypes={[...allTypes.filter((t) => t.id !== def.id), def]}
          onClose={() => setEditFile(null)}
          onSave={(rule) => {
            const rules = [...def.fileRules];
            if (editFile.index === -1) rules.push(rule);
            else rules[editFile.index] = rule;
            update({ fileRules: rules });
            setEditFile(null);
          }}
        />
      )}
    </>
  );
}

function relabel(cols: ColumnDefinition[]) {
  return cols.map((c, i) => ({ ...c, letter: columnLetter(i) }));
}

function SeveritySelect({ value, onChange }: { value: Severity; onChange: (s: Severity) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Severity)} aria-label="Severity">
      <option value="error">Error (rejects file)</option>
      <option value="warning">Warning (can proceed)</option>
    </select>
  );
}

function RuleList<T extends RowRule | FileRule>({
  title,
  rules,
  columns,
  addLabel = '+ Add rule',
  extraAdd,
  onAdd,
  onEdit,
  onRemove,
  onSeverity,
}: {
  title: string;
  rules: T[];
  columns: ColumnDefinition[];
  addLabel?: string;
  extraAdd?: ReactNode;
  onAdd: () => void;
  onEdit: (i: number) => void;
  onRemove: (i: number) => void;
  onSeverity: (i: number, s: Severity) => void;
}) {
  return (
    <div className="card tight">
      <div className="card-head">
        <span className="muted small" style={{ flex: 1 }}>{title}</span>
        {extraAdd}
        <button className="btn primary small" onClick={onAdd} disabled={columns.length === 0}>
          {addLabel}
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Rule</th>
            <th style={{ width: 220 }}>Severity</th>
            <th style={{ width: 150 }} />
          </tr>
        </thead>
        <tbody>
          {rules.map((r, i) => (
            <tr key={r.id + i}>
              <td>
                {ruleText(r, columns)}
                <div className="muted small mono">
                  {r.id}
                  {r.description ? ` · ${r.description}` : ''}
                </div>
              </td>
              <td>
                <SeveritySelect value={r.severity} onChange={(s) => onSeverity(i, s)} />
              </td>
              <td>
                <div className="row" style={{ gap: 4 }}>
                  <button className="btn small" onClick={() => onEdit(i)}>
                    Edit
                  </button>
                  <button className="btn small danger" onClick={() => confirm('Remove this rule?') && onRemove(i)}>
                    Remove
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {rules.length === 0 && (
            <tr>
              <td colSpan={3} className="empty">
                No rules.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const numOrUndef = (v: string) => (v.trim() === '' ? undefined : Number(v));
const listFromText = (t: string) =>
  t
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

function ColumnModal({
  initial,
  lookups,
  orgKeys,
  existingKeys,
  onClose,
  onSave,
}: {
  initial: ColumnDefinition;
  lookups: LookupList[];
  orgKeys: string[];
  existingKeys: string[];
  onClose: () => void;
  onSave: (c: ColumnDefinition) => void;
}) {
  const [c, setC] = useState<ColumnDefinition>(initial);
  const [allowedText, setAllowedText] = useState((initial.allowedValues ?? []).join('\n'));
  const [keyTouched, setKeyTouched] = useState(!!initial.key);
  const [equalsMode, setEqualsMode] = useState<'none' | 'fixed' | 'org'>(initial.fixedValue !== undefined ? 'fixed' : initial.orgValue ? 'org' : 'none');
  const set = (patch: Partial<ColumnDefinition>) => setC({ ...c, ...patch });
  const keyClash = existingKeys.includes(c.key);
  let patternError = '';
  if (c.pattern) {
    try {
      new RegExp(c.pattern);
    } catch {
      patternError = 'Not a valid regular expression.';
    }
  }

  const finish = () => {
    const allowed = listFromText(allowedText);
    const out: ColumnDefinition = {
      ...c,
      allowedValues: allowed.length ? allowed : undefined,
      fixedValue: equalsMode === 'fixed' ? (c.fixedValue ?? '') : undefined,
      orgValue: equalsMode === 'org' ? c.orgValue || c.key : undefined,
      allowNegative: c.dataType === 'money' && c.allowNegative ? true : undefined,
    };
    for (const k of ['description', 'pattern', 'patternMessage', 'lookupListId', 'orgValue', 'hint', 'allowedValues', 'allowNegative'] as const) {
      if (!out[k]) delete out[k];
    }
    if (out.fixedValue === undefined) delete out.fixedValue;
    if (out.severity && Object.keys(out.severity).length === 0) delete out.severity;
    onSave(out);
  };

  return (
    <Modal
      title={initial.header ? `Column ${initial.letter} — ${initial.header}` : 'Add column'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={finish} disabled={!c.header.trim() || !c.key || keyClash || !!patternError}>
            Apply
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          Header text
          <span className="hint">Expected in row 1 of the file</span>
          <input
            value={c.header}
            onChange={(e) => set({ header: e.target.value, ...(keyTouched ? {} : { key: toKey(e.target.value) }) })}
            autoFocus
          />
        </label>
        <label className="field">
          Key
          <span className="hint">Internal name used by rules</span>
          <input
            className="mono"
            value={c.key}
            onChange={(e) => {
              setKeyTouched(true);
              set({ key: e.target.value.replace(/[^A-Za-z0-9_]/g, '') });
            }}
          />
          {keyClash && <span className="sev-error small">Key already used by another column.</span>}
        </label>
        <label className="field">
          Data type
          <select value={c.dataType} onChange={(e) => set({ dataType: e.target.value as DataType })}>
            {DATA_TYPES.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Required?
          <select value={c.required ? 'R' : 'O'} onChange={(e) => set({ required: e.target.value === 'R' })}>
            <option value="R">Required — blank is an error</option>
            <option value="O">Optional — blank passes</option>
          </select>
        </label>
        {c.dataType === 'money' && (
          <label className="field">
            Negative amounts
            <select value={c.allowNegative ? 'y' : 'n'} onChange={(e) => set({ allowNegative: e.target.value === 'y' })}>
              <option value="n">Not allowed</option>
              <option value="y">Allowed (leading “-”)</option>
            </select>
          </label>
        )}
        <label className="field">
          Exact length
          <input type="number" min={0} value={c.exactLength ?? ''} onChange={(e) => set({ exactLength: numOrUndef(e.target.value) })} />
        </label>
        <label className="field">
          Max length
          <input type="number" min={0} value={c.maxLength ?? ''} onChange={(e) => set({ maxLength: numOrUndef(e.target.value) })} />
        </label>
        <label className="field">
          Min length
          <input type="number" min={0} value={c.minLength ?? ''} onChange={(e) => set({ minLength: numOrUndef(e.target.value) })} />
        </label>
        <label className="field">
          Must equal
          <span className="hint">Exact match, including spaces and capitalization</span>
          <select value={equalsMode} onChange={(e) => setEqualsMode(e.target.value as 'none' | 'fixed' | 'org')}>
            <option value="none">— no fixed value —</option>
            <option value="fixed">A fixed value…</option>
            <option value="org">The organization's own value…</option>
          </select>
          {equalsMode === 'fixed' && <input placeholder="e.g. ADP" value={c.fixedValue ?? ''} onChange={(e) => set({ fixedValue: e.target.value })} />}
          {equalsMode === 'org' && (
            <>
              <input className="mono" list="org-keys" placeholder="organization value key" value={c.orgValue ?? c.key} onChange={(e) => set({ orgValue: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })} />
              <datalist id="org-keys">
                {orgKeys.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
            </>
          )}
        </label>
        <label className="field">
          Lookup list
          <span className="hint">Value must be in an admin-managed list</span>
          <select value={c.lookupListId ?? ''} onChange={(e) => set({ lookupListId: e.target.value || undefined })}>
            <option value="">— none —</option>
            {lookups.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.values.length})
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-grid" style={{ marginTop: 14 }}>
        <label className="field">
          Allowed values (inline)
          <span className="hint">One per line. Matched exactly.</span>
          <textarea rows={3} value={allowedText} onChange={(e) => setAllowedText(e.target.value)} />
        </label>
        <label className="field">
          Format pattern (regular expression)
          <span className="hint">Whole value must match, e.g. [A-Z]{'{3}'}</span>
          <input className="mono" value={c.pattern ?? ''} onChange={(e) => set({ pattern: e.target.value })} />
          {patternError && <span className="sev-error small">{patternError}</span>}
          <input placeholder="Message, e.g. must be a 3-letter code." value={c.patternMessage ?? ''} onChange={(e) => set({ patternMessage: e.target.value })} />
        </label>
      </div>
      <div className="form-grid" style={{ marginTop: 14 }}>
        <label className="field">
          Description
          <input value={c.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
        </label>
        <label className="field">
          Extra help text in error messages
          <input value={c.hint ?? ''} onChange={(e) => set({ hint: e.target.value })} />
        </label>
      </div>
      <h3 style={{ marginTop: 18 }}>Severity per check</h3>
      <p className="muted small">By default every failed check is an error. Downgrade individual checks to warnings here.</p>
      <div className="form-grid">
        {CHECKS.map((k) => (
          <label className="field" key={k.value}>
            {k.label}
            <select
              value={c.severity?.[k.value] ?? 'error'}
              onChange={(e) => {
                const sev = { ...(c.severity ?? {}) };
                if (e.target.value === 'error') delete sev[k.value];
                else sev[k.value] = 'warning';
                set({ severity: sev });
              }}
            >
              <option value="error">Error</option>
              <option value="warning">Warning</option>
            </select>
          </label>
        ))}
      </div>
    </Modal>
  );
}

function ColumnPicker({ columns, value, onChange, multiple }: { columns: ColumnDefinition[]; value: string[]; onChange: (v: string[]) => void; multiple?: boolean }) {
  return (
    <select
      multiple={multiple}
      size={multiple ? Math.min(8, columns.length) : undefined}
      value={multiple ? value : value[0] ?? ''}
      onChange={(e) => onChange(multiple ? Array.from(e.target.selectedOptions, (o) => o.value) : [e.target.value])}
    >
      {!multiple && <option value="">Select a column…</option>}
      {columns.map((c) => (
        <option key={c.key} value={c.key}>
          {c.letter} — {c.header}
        </option>
      ))}
    </select>
  );
}

function RowRuleModal({ initial, columns, onClose, onSave }: { initial: RowRule; columns: ColumnDefinition[]; onClose: () => void; onSave: (r: RowRule) => void }) {
  const [r, setR] = useState<RowRule>(initial);
  const first = columns[0]?.key ?? '';
  const changeType = (type: RowRule['type']) => {
    const base = { id: r.id, description: r.description, severity: r.severity };
    const when = r.type === 'requiredWhen' || r.type === 'patternWhen' ? r.when : { column: first, operator: 'equals' as const, value: '' };
    const cols = 'columns' in r ? (r.columns as string[]) : [];
    switch (type) {
      case 'requiredWhen':
        return setR({ ...base, type, when, columns: cols });
      case 'patternWhen':
        return setR({ ...base, type, when, column: cols[0] ?? first, pattern: '', patternMessage: '' });
      case 'allOrNone':
      case 'atLeastOne':
        return setR({ ...base, type, columns: cols });
      case 'equalColumns':
        return setR({ ...base, type, columns: [cols[0] ?? first, cols[1] ?? first] });
      case 'dateOrder':
        return setR({ ...base, type, before: first, after: first });
    }
  };
  const whenEditor = (r.type === 'requiredWhen' || r.type === 'patternWhen') && (
    <div className="form-grid">
      <label className="field">
        When column
        <ColumnPicker columns={columns} value={[r.when.column]} onChange={([v]) => setR({ ...r, when: { ...r.when, column: v } })} />
      </label>
      <label className="field">
        Condition
        <select value={r.when.operator} onChange={(e) => setR({ ...r, when: { ...r.when, operator: e.target.value as ConditionOperator } })}>
          {OPERATORS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {!['isEmpty', 'isNotEmpty'].includes(r.when.operator) && (
        <label className="field">
          Value
          <input
            value={Array.isArray(r.when.value) ? r.when.value.join(', ') : (r.when.value ?? '')}
            onChange={(e) =>
              setR({ ...r, when: { ...r.when, value: ['in', 'notIn'].includes(r.when.operator) ? listFromText(e.target.value) : e.target.value } })
            }
          />
        </label>
      )}
    </div>
  );
  return (
    <Modal
      title="Cross-field rule"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave(r)}>
            Apply
          </button>
        </>
      }
    >
      <div className="grid">
        <div className="form-grid">
          <label className="field">
            Rule type
            <select value={r.type} onChange={(e) => changeType(e.target.value as RowRule['type'])}>
              {ROW_RULE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Severity
            <SeveritySelect value={r.severity} onChange={(s) => setR({ ...r, severity: s })} />
          </label>
        </div>
        {whenEditor}
        {r.type === 'requiredWhen' && (
          <label className="field">
            Then these columns are required <span className="hint">Ctrl/⌘-click to select several</span>
            <ColumnPicker multiple columns={columns} value={r.columns} onChange={(v) => setR({ ...r, columns: v })} />
          </label>
        )}
        {r.type === 'patternWhen' && (
          <div className="form-grid">
            <label className="field">
              Then column
              <ColumnPicker columns={columns} value={[r.column]} onChange={([v]) => setR({ ...r, column: v })} />
            </label>
            <label className="field">
              Must match pattern
              <input className="mono" value={r.pattern} onChange={(e) => setR({ ...r, pattern: e.target.value })} />
            </label>
            <label className="field">
              Message
              <input placeholder="must be a 5-digit zip code" value={r.patternMessage} onChange={(e) => setR({ ...r, patternMessage: e.target.value })} />
            </label>
          </div>
        )}
        {(r.type === 'allOrNone' || r.type === 'atLeastOne') && (
          <label className="field">
            Columns <span className="hint">Ctrl/⌘-click to select several</span>
            <ColumnPicker multiple columns={columns} value={r.columns} onChange={(v) => setR({ ...r, columns: v })} />
          </label>
        )}
        {r.type === 'equalColumns' && (
          <div className="form-grid">
            <label className="field">
              Column
              <ColumnPicker columns={columns} value={[r.columns[0]]} onChange={([v]) => setR({ ...r, columns: [v, r.columns[1]] })} />
            </label>
            <label className="field">
              Must equal column
              <ColumnPicker columns={columns} value={[r.columns[1]]} onChange={([v]) => setR({ ...r, columns: [r.columns[0], v] })} />
            </label>
          </div>
        )}
        {r.type === 'dateOrder' && (
          <div className="form-grid">
            <label className="field">
              Earlier date column
              <ColumnPicker columns={columns.filter((c) => c.dataType === 'date')} value={[r.before]} onChange={([v]) => setR({ ...r, before: v })} />
            </label>
            <label className="field">
              Later date column
              <ColumnPicker columns={columns.filter((c) => c.dataType === 'date')} value={[r.after]} onChange={([v]) => setR({ ...r, after: v })} />
            </label>
          </div>
        )}
        <label className="field">
          Description (optional)
          <input value={r.description ?? ''} onChange={(e) => setR({ ...r, description: e.target.value || undefined })} />
        </label>
      </div>
    </Modal>
  );
}

function FileRuleModal({
  initial,
  columns,
  fileTypes,
  onClose,
  onSave,
}: {
  initial: FileRule;
  columns: ColumnDefinition[];
  fileTypes: FileTypeDefinition[];
  onClose: () => void;
  onSave: (r: FileRule) => void;
}) {
  const [r, setR] = useState<FileRule>(initial);
  const changeType = (type: FileRule['type']) => {
    const base = { id: r.id, description: r.description, severity: r.severity };
    switch (type) {
      case 'duplicateKey':
        return setR({ ...base, type, columns: [] });
      case 'existsInPrior': {
        const src = fileTypes[0];
        return setR({ ...base, type, column: columns[0]?.key ?? '', sourceFileTypeId: src?.id ?? '', sourceColumn: src?.columns[0]?.key ?? '' });
      }
      default:
        return setR({ ...base, type });
    }
  };
  return (
    <Modal
      title="File-level rule"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave(r)}>
            Apply
          </button>
        </>
      }
    >
      <div className="grid">
        <div className="form-grid">
          <label className="field">
            Rule type
            <select value={r.type} onChange={(e) => changeType(e.target.value as FileRule['type'])}>
              {FILE_RULE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Severity
            <SeveritySelect value={r.severity} onChange={(s) => setR({ ...r, severity: s })} />
          </label>
        </div>
        {r.type === 'duplicateKey' && (
          <label className="field">
            Key columns <span className="hint">A record is a duplicate when all selected columns match another record</span>
            <ColumnPicker multiple columns={columns} value={r.columns} onChange={(v) => setR({ ...r, columns: v })} />
          </label>
        )}
        {r.type === 'existsInPrior' && (
          <div className="form-grid">
            <label className="field">
              Column in this file
              <ColumnPicker columns={columns} value={[r.column]} onChange={([v]) => setR({ ...r, column: v })} />
            </label>
            <label className="field">
              Must exist in passed files of type
              <select
                value={r.sourceFileTypeId}
                onChange={(e) => setR({ ...r, sourceFileTypeId: e.target.value, sourceColumn: fileTypes.find((t) => t.id === e.target.value)?.columns[0]?.key ?? '' })}
              >
                {fileTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name || '(this file type)'} ({t.id})
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              …in column
              <ColumnPicker columns={fileTypes.find((t) => t.id === r.sourceFileTypeId)?.columns ?? []} value={[r.sourceColumn]} onChange={([v]) => setR({ ...r, sourceColumn: v })} />
            </label>
          </div>
        )}
        <label className="field">
          Description (optional)
          <input value={r.description ?? ''} onChange={(e) => setR({ ...r, description: e.target.value || undefined })} />
        </label>
      </div>
    </Modal>
  );
}

/** Runs the draft (unsaved) rule set in the browser against a sample file. */
function TestPanel({ def, lookups, orgs }: { def: FileTypeDefinition; lookups: LookupList[]; orgs: Organization[] }) {
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? '');
  const [result, setResult] = useState<ValidationResult & { fileName: string }>();
  const [error, setError] = useState('');
  const org = orgs.find((a) => a.id === orgId);

  const run = async (file: File | undefined) => {
    setError('');
    setResult(undefined);
    if (!file) return;
    try {
      const fileType = { ...def, columns: relabel(def.columns) };
      const bytes = new Uint8Array(await file.arrayBuffer());
      const table = isXlsx(bytes) ? tableFromXlsx(bytes, fileType) : tableFromCsv(new TextDecoder().decode(bytes));
      const res = validateTable(table, {
        fileType,
        organization: org,
        lookups: Object.fromEntries(lookups.map((l) => [l.id, l])),
        fileName: file.name,
      });
      setResult({ ...res, fileName: file.name });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <div className="card">
        <h2>Test the draft rules</h2>
        <p className="muted">
          Validate a file against the rules on this screen <strong>before saving</strong>. The test runs entirely in your browser and is not recorded as a submission. Cross-file
          checks against submission history are skipped.
        </p>
        <div className="form-grid">
          <label className="field">
            As organization
            <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              <option value="">No organization</option>
              {orgs.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            CSV file
            <input type="file" accept=".csv,.xlsx" onChange={(e) => run(e.target.files?.[0])} />
          </label>
        </div>
        {error && <div className="alert err">{error}</div>}
      </div>
      {result && (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>{result.fileName}</h2>
            <StatusBadge status={result.summary.status} />
          </div>
          <SummaryStats s={result.summary} />
          <div className="card tight">
            <div className="table-wrap" style={{ maxHeight: 520 }}>
              <table>
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th className="num">Row</th>
                    <th>Col</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {result.issues.slice(0, 300).map((i, idx) => (
                    <tr key={idx}>
                      <td className={`sev-${i.severity}`}>{i.severity}</td>
                      <td className="num">{i.row ?? '—'}</td>
                      <td className="mono">{i.column ?? '—'}</td>
                      <td>{i.message}</td>
                    </tr>
                  ))}
                  {result.issues.length === 0 && (
                    <tr>
                      <td colSpan={4} className="empty">
                        No issues.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {result.issues.length > 300 && <div className="muted small" style={{ padding: 12 }}>Showing first 300 of {result.issues.length} issues.</div>}
          </div>
        </>
      )}
    </>
  );
}
