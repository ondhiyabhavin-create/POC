import { useState } from 'react';
import { ConditionEngine, DEFAULT_FILE_NAME_PATTERN, describeCondition, templateCsv, type FileTypeDefinition, type LookupList, type RowRule, type FileRule, type ColumnDefinition } from '@odr/shared';
import { api, downloadText } from '../api';
import { ErrorAlert, Loading, useAsync } from '../components/ui';

/** Read-only view of each file layout and the rules applied to it (for submitters). */
export function LayoutsPage() {
  const { data, error, loading } = useAsync(() => Promise.all([api.fileTypes(), api.lookups()]), []);
  const [active, setActive] = useState('');
  if (loading) return <Loading />;
  if (error || !data) return <ErrorAlert error={error} />;
  const [types, lookups] = data;
  const def = types.find((t) => t.id === active) ?? types[0];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>File layouts</h1>
          <p>The columns and rules each file is checked against. Columns must appear in exactly this order.</p>
        </div>
      </div>
      <div className="tabs">
        {types.map((t) => (
          <button key={t.id} className={t.id === def?.id ? 'active' : ''} onClick={() => setActive(t.id)}>
            {t.name} ({t.id})
          </button>
        ))}
      </div>
      {def && <LayoutDetail def={def} lookups={lookups} />}
    </>
  );
}

export function ruleText(r: RowRule | FileRule, cols: ColumnDefinition[]): string {
  const name = (k: string) => {
    const c = cols.find((x) => x.key === k);
    return c ? `${c.letter} ${c.header}` : k;
  };
  switch (r.type) {
    case 'requiredWhen':
      return `When ${describeCondition(r.when, cols)}: ${r.columns.map(name).join(', ')} required`;
    case 'patternWhen':
      return `When ${describeCondition(r.when, cols)}: ${name(r.column)} ${r.patternMessage}`;
    case 'allOrNone':
      return `${r.columns.map(name).join(', ')} must all be provided or all blank`;
    case 'atLeastOne':
      return `At least one of ${r.columns.map(name).join(', ')}`;
    case 'equalColumns':
      return `${name(r.columns[0])} must equal ${name(r.columns[1])}`;
    case 'dateOrder':
      return `${name(r.before)} must be on or before ${name(r.after)}`;
    case 'duplicateKey':
      return `Duplicate ${r.columns.map(name).join(' + ')} within the file`;
    case 'duplicateRow':
      return 'Exact duplicate records';
    case 'fileName':
      return 'File name must follow the naming convention';
    case 'notEmpty':
      return 'File must contain at least one record';
    case 'existsInPrior':
      return `${name(r.column)} should exist in a previously validated ${r.sourceFileTypeId} file (column ${r.sourceColumn})`;
    case 'conditional': {
      const e = new ConditionEngine(cols);
      const then = r.then.map((a) => e.describeAction(a)).join('; ');
      const els = (r.else ?? []).map((a) => e.describeAction(a)).join('; ');
      const head = r.when.items.length === 0 ? `Always: ${then}` : `IF ${e.describe(r.when)} THEN ${then}`;
      return `${r.name ? `${r.name} — ` : ''}${head}${els ? ` ELSE ${els}` : ''}`;
    }
  }
}

export function columnRules(c: ColumnDefinition, lookups: LookupList[]): string[] {
  const out: string[] = [];
  if (c.fixedValue !== undefined) out.push(`Must be exactly "${c.fixedValue}"`);
  if (c.orgValue) out.push(`Must match your organization's "${c.orgValue}" value`);
  if (c.allowNegative) out.push('Negative allowed');
  if (c.exactLength !== undefined) out.push(`Exactly ${c.exactLength} characters`);
  if (c.maxLength !== undefined) out.push(`Max ${c.maxLength} characters`);
  if (c.minLength !== undefined) out.push(`Min ${c.minLength} characters`);
  if (c.allowedValues?.length) out.push(`One of: ${c.allowedValues.join(', ')}`);
  if (c.lookupListId) {
    const l = lookups.find((x) => x.id === c.lookupListId);
    out.push(l ? `From list "${l.name}"${l.values.length <= 8 ? `: ${l.values.join(', ')}` : ` (${l.values.length} values)`}` : `List ${c.lookupListId}`);
  }
  if (c.pattern) out.push(`Format: ${c.patternMessage ?? c.pattern}`);
  return out;
}

const TYPE_LABEL: Record<string, string> = { varchar: 'Text', numeric: 'Digits', int: 'Integer', money: 'Money', date: 'Date (CCYY-MM-DD)' };

function LayoutDetail({ def, lookups }: { def: FileTypeDefinition; lookups: LookupList[] }) {
  return (
    <>
      <div className="card">
        <div className="row">
          <div style={{ flex: 1 }}>
            <h2>
              {def.name} <span className="muted">· {def.columns.length} columns · rule set v{def.version}</span>
            </h2>
            <p className="muted">{def.description}</p>
            <div className="small">
              Naming convention: <code>{(def.fileNamePattern || DEFAULT_FILE_NAME_PATTERN).replace('{TYPE}', def.id)}</code> · .csv or .xlsx
            </div>
          </div>
          <button className="btn" onClick={() => downloadText(`${def.id}_TEMPLATE.csv`, templateCsv(def))}>
            ⬇ Download blank template
          </button>
        </div>
      </div>
      <div className="card tight">
        <div className="table-wrap">
          <table className="cols-table">
            <thead>
              <tr>
                <th>Col</th>
                <th>Header</th>
                <th>Type</th>
                <th>Required</th>
                <th>Rules</th>
              </tr>
            </thead>
            <tbody>
              {def.columns.map((c) => (
                <tr key={c.key}>
                  <td className="mono">
                    <strong>{c.letter}</strong>
                  </td>
                  <td>
                    {c.header}
                    {c.description && <div className="muted small">{c.description}</div>}
                  </td>
                  <td className="small">{TYPE_LABEL[c.dataType]}</td>
                  <td>{c.required ? <span className="badge err">Required</span> : <span className="badge neutral">Optional</span>}</td>
                  <td className="small">{columnRules(c, lookups).join(' · ') || <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <h2>Cross-field and file-level rules</h2>
        <table>
          <tbody>
            {[...def.rowRules, ...def.fileRules].map((r) => (
              <tr key={r.id}>
                <td style={{ width: 100 }}>{r.severity === 'error' ? <span className="badge err">Error</span> : <span className="badge warn">Warning</span>}</td>
                <td>{ruleText(r, def.columns)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
