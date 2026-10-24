import { useMemo, useState } from 'react';
import {
  ACTION_CHECKS,
  COMPARE_OPERATORS,
  ConditionEngine,
  FORMULA_OPERATORS,
  FUNCTIONS,
  compileFormula,
  type ActionCheck,
  type ColumnDefinition,
  type CompareOperator,
  type ConditionGroup,
  type ConditionLeaf,
  type ConditionNode,
  type Operand,
  type RowRule,
  type RuleAction,
  type Severity,
} from '@odr/shared';
import { Modal } from './ui';

export type ConditionalRule = Extract<RowRule, { type: 'conditional' }>;

const firstKey = (cols: ColumnDefinition[]) => cols[0]?.key ?? '';
const newLeaf = (cols: ColumnDefinition[]): ConditionLeaf => ({ kind: 'condition', left: { kind: 'column', column: firstKey(cols) }, operator: 'equals', right: { kind: 'value', value: '' } });
const newGroup = (cols: ColumnDefinition[]): ConditionGroup => ({ kind: 'group', op: 'and', items: [newLeaf(cols)] });

export function newConditionalRule(cols: ColumnDefinition[], idPrefix: string): ConditionalRule {
  return {
    id: `${idPrefix}.${Math.random().toString(36).slice(2, 8)}`,
    type: 'conditional',
    name: '',
    when: newGroup(cols),
    then: [{ column: cols[1]?.key ?? firstKey(cols), check: 'required' }],
    severity: 'error',
  };
}

// ---------------------------------------------------------------------------
// Formula input with live checking
// ---------------------------------------------------------------------------

export function FormulaInput({ value, onChange, columns, placeholder }: { value: string; onChange: (v: string) => void; columns: ColumnDefinition[]; placeholder?: string }) {
  const status = useMemo(() => (value.trim() ? compileFormula(value, columns) : undefined), [value, columns]);
  return (
    <div className="formula-input">
      <span className="fx">ƒx</span>
      <input className="mono" value={value} placeholder={placeholder ?? '[C] + [D] > 100'} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      {status && (status.ok ? <span className="formula-ok" title="Formula is valid">✓</span> : <span className="formula-err">{status.error}</span>)}
    </div>
  );
}

export function FormulaHelp({ columns }: { columns: ColumnDefinition[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="formula-help">
      <button className="btn ghost small" onClick={() => setOpen(!open)} type="button">
        {open ? '▾' : '▸'} Formula help
      </button>
      {open && (
        <div className="formula-help-body">
          <p className="small muted">
            Refer to columns with square brackets — by letter <code>[C]</code>, key <code>[{columns[0]?.key ?? 'key'}]</code> or header <code>[{columns[0]?.header ?? 'Header'}]</code>. Text goes in quotes.
          </p>
          <table>
            <tbody>
              {FORMULA_OPERATORS.map((o) => (
                <tr key={o.op}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>{o.op}</td>
                  <td className="small">{o.doc}</td>
                </tr>
              ))}
              {Object.entries(FUNCTIONS).map(([name, f]) => (
                <tr key={name}>
                  <td className="mono">{name}()</td>
                  <td className="small">
                    {f.doc} <span className="muted mono">{f.example}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Operand picker: Column | Value | Formula
// ---------------------------------------------------------------------------

function OperandPicker({ value, onChange, columns, kinds, placeholder }: { value: Operand; onChange: (o: Operand) => void; columns: ColumnDefinition[]; kinds: Operand['kind'][]; placeholder?: string }) {
  const switchKind = (k: Operand['kind']) => {
    if (k === value.kind) return;
    if (k === 'column') onChange({ kind: 'column', column: firstKey(columns) });
    else if (k === 'value') onChange({ kind: 'value', value: '' });
    else onChange({ kind: 'formula', formula: value.kind === 'column' ? `[${columns.find((c) => c.key === value.column)?.letter ?? ''}]` : '' });
  };
  const label: Record<Operand['kind'], string> = { column: 'Column', value: 'Value', formula: 'ƒx' };
  return (
    <div className="operand">
      {kinds.length > 1 && (
        <div className="seg" role="group">
          {kinds.map((k) => (
            <button type="button" key={k} className={value.kind === k ? 'on' : ''} onClick={() => switchKind(k)} title={k === 'formula' ? 'Formula' : label[k]}>
              {label[k]}
            </button>
          ))}
        </div>
      )}
      {value.kind === 'column' && (
        <select value={value.column} onChange={(e) => onChange({ kind: 'column', column: e.target.value })}>
          {columns.map((c) => (
            <option key={c.key} value={c.key}>
              {c.letter} — {c.header}
            </option>
          ))}
        </select>
      )}
      {value.kind === 'value' && <input value={value.value} placeholder={placeholder ?? 'value'} onChange={(e) => onChange({ kind: 'value', value: e.target.value })} />}
      {value.kind === 'formula' && <FormulaInput value={value.formula} columns={columns} onChange={(f) => onChange({ kind: 'formula', formula: f })} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Condition tree
// ---------------------------------------------------------------------------

type Match = 'all' | 'any' | 'none';
const matchOf = (g: ConditionGroup): Match => (g.not ? 'none' : g.op === 'and' ? 'all' : 'any');
const withMatch = (g: ConditionGroup, m: Match): ConditionGroup => ({ ...g, op: m === 'all' ? 'and' : 'or', not: m === 'none' || undefined });

function ConditionRow({ leaf, onChange, onRemove, columns }: { leaf: ConditionLeaf; onChange: (l: ConditionLeaf) => void; onRemove: () => void; columns: ColumnDefinition[] }) {
  const meta = COMPARE_OPERATORS.find((o) => o.value === leaf.operator);
  const listOp = leaf.operator === 'in' || leaf.operator === 'notIn';
  return (
    <div className="cond-row">
      <OperandPicker value={leaf.left} columns={columns} kinds={['column', 'formula']} onChange={(left) => onChange({ ...leaf, left })} />
      <select
        className="op-select"
        value={leaf.operator}
        onChange={(e) => {
          const operator = e.target.value as CompareOperator;
          const needs = COMPARE_OPERATORS.find((o) => o.value === operator)?.needsRight;
          onChange({ ...leaf, operator, right: needs ? (leaf.right ?? { kind: 'value', value: '' }) : undefined });
        }}
      >
        {COMPARE_OPERATORS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {meta?.needsRight && leaf.right && (
        <OperandPicker
          value={leaf.right}
          columns={columns}
          kinds={listOp || leaf.operator === 'matches' ? ['value'] : ['value', 'column', 'formula']}
          placeholder={listOp ? 'A, B, C' : leaf.operator === 'matches' ? 'regular expression, e.g. \\d{5}' : 'value'}
          onChange={(right) => onChange({ ...leaf, right })}
        />
      )}
      <button type="button" className="btn ghost small icon-btn" onClick={onRemove} aria-label="Remove condition">
        ✕
      </button>
    </div>
  );
}

export function GroupEditor({ group, onChange, onRemove, columns, depth = 0 }: { group: ConditionGroup; onChange: (g: ConditionGroup) => void; onRemove?: () => void; columns: ColumnDefinition[]; depth?: number }) {
  const setItem = (i: number, n: ConditionNode) => onChange({ ...group, items: group.items.map((x, j) => (j === i ? n : x)) });
  const removeItem = (i: number) => onChange({ ...group, items: group.items.filter((_, j) => j !== i) });
  return (
    <div className={`cond-group depth-${depth}`}>
      <div className="cond-group-head">
        <span>Match</span>
        <select value={matchOf(group)} onChange={(e) => onChange(withMatch(group, e.target.value as Match))}>
          <option value="all">ALL (and)</option>
          <option value="any">ANY (or)</option>
          <option value="none">NONE (not)</option>
        </select>
        <span>of these conditions</span>
        <span className="spacer" />
        {onRemove && (
          <button type="button" className="btn ghost small" onClick={onRemove}>
            Remove group
          </button>
        )}
      </div>
      {group.items.map((item, i) => (
        <div key={i} className="cond-item">
          {i > 0 && <span className={`joiner ${group.op}`}>{group.op === 'and' ? 'AND' : 'OR'}</span>}
          {item.kind === 'group' ? (
            <GroupEditor group={item} columns={columns} depth={depth + 1} onChange={(g) => setItem(i, g)} onRemove={() => removeItem(i)} />
          ) : (
            <ConditionRow leaf={item} columns={columns} onChange={(l) => setItem(i, l)} onRemove={() => removeItem(i)} />
          )}
        </div>
      ))}
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button type="button" className="btn small" onClick={() => onChange({ ...group, items: [...group.items, newLeaf(columns)] })}>
          + Condition
        </button>
        {depth < 3 && (
          <button type="button" className="btn small" onClick={() => onChange({ ...group, items: [...group.items, { ...newGroup(columns), op: group.op === 'and' ? 'or' : 'and' }] })}>
            + Group ( )
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Actions (THEN / ELSE)
// ---------------------------------------------------------------------------

function ActionsEditor({ actions, onChange, columns, label }: { actions: RuleAction[]; onChange: (a: RuleAction[]) => void; columns: ColumnDefinition[]; label: 'THEN' | 'ELSE' }) {
  const [msgOpen, setMsgOpen] = useState<Record<number, boolean>>({});
  const set = (i: number, a: RuleAction) => onChange(actions.map((x, j) => (j === i ? a : x)));
  return (
    <div className="actions">
      {actions.map((a, i) => {
        const meta = ACTION_CHECKS.find((c) => c.value === a.check);
        const listCheck = a.check === 'oneOf' || a.check === 'notOneOf';
        return (
          <div key={i} className="action-item">
            <div className="cond-row">
              <select value={a.column} onChange={(e) => set(i, { ...a, column: e.target.value })}>
                {columns.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.letter} — {c.header}
                  </option>
                ))}
              </select>
              <select
                className="op-select"
                value={a.check}
                onChange={(e) => {
                  const check = e.target.value as ActionCheck;
                  const m = ACTION_CHECKS.find((c) => c.value === check);
                  const value: Operand | undefined = !m?.needsValue ? undefined : check === 'formula' ? { kind: 'formula', formula: a.value?.kind === 'formula' ? a.value.formula : '' } : a.value && a.value.kind !== 'formula' ? a.value : { kind: 'value', value: '' };
                  set(i, { ...a, check, value });
                }}
              >
                {ACTION_CHECKS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              {meta?.needsValue && a.value && (
                <OperandPicker
                  value={a.value}
                  columns={columns}
                  kinds={a.check === 'formula' ? ['formula'] : listCheck || a.check === 'matches' || a.check === 'minLength' || a.check === 'maxLength' ? ['value'] : ['value', 'column', 'formula']}
                  placeholder={listCheck ? 'A, B, C' : a.check === 'matches' ? 'regular expression' : a.check.endsWith('Length') ? 'number' : 'value'}
                  onChange={(value) => set(i, { ...a, value })}
                />
              )}
              <button type="button" className="btn ghost small" onClick={() => setMsgOpen({ ...msgOpen, [i]: !msgOpen[i] })} title="Custom error message">
                💬
              </button>
              <button type="button" className="btn ghost small icon-btn" onClick={() => onChange(actions.filter((_, j) => j !== i))} aria-label="Remove action">
                ✕
              </button>
            </div>
            {(msgOpen[i] || a.message) && (
              <input
                className="action-msg"
                placeholder="Custom message (optional). Placeholders: {header} {column} {value} {row}"
                value={a.message ?? ''}
                onChange={(e) => set(i, { ...a, message: e.target.value || undefined })}
              />
            )}
          </div>
        );
      })}
      <button type="button" className="btn small" onClick={() => onChange([...actions, { column: firstKey(columns), check: 'required' }])}>
        + {label} action
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

export function ConditionalRuleModal({ initial, columns, onClose, onSave }: { initial: ConditionalRule; columns: ColumnDefinition[]; onClose: () => void; onSave: (r: ConditionalRule) => void }) {
  const [r, setR] = useState<ConditionalRule>(initial);
  const [hasElse, setHasElse] = useState((initial.else ?? []).length > 0);
  const engine = useMemo(() => new ConditionEngine(columns), [columns]);
  const always = r.when.items.length === 0;
  const final: ConditionalRule = { ...r, else: hasElse ? (r.else ?? []) : undefined };
  const problems = engine.check(final.when, [...final.then, ...(final.else ?? [])]);
  if (final.then.length === 0 && (final.else ?? []).length === 0) problems.push('Add at least one THEN action.');

  const preview = problems.length
    ? null
    : `${always ? 'Always' : `IF ${engine.describe(r.when)}`} THEN ${final.then.map((a) => engine.describeAction(a)).join('; ') || '—'}${hasElse && final.else?.length ? ` ELSE ${final.else.map((a) => engine.describeAction(a)).join('; ')}` : ''}`;

  return (
    <Modal
      title="IF / THEN / ELSE rule"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted small" style={{ marginRight: 'auto' }}>
            {problems.length ? `${problems.length} problem(s) to fix` : 'Rule looks good'}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={problems.length > 0} onClick={() => onSave(final)}>
            Apply rule
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          Rule name
          <input value={r.name ?? ''} placeholder="e.g. Business needs FEIN" onChange={(e) => setR({ ...r, name: e.target.value })} />
        </label>
        <label className="field">
          When the rule fails
          <select value={r.severity} onChange={(e) => setR({ ...r, severity: e.target.value as Severity })}>
            <option value="error">Error — file is rejected</option>
            <option value="warning">Warning — file can proceed</option>
          </select>
        </label>
      </div>

      <section className="rule-block">
        <div className="rule-block-head">
          <span className="pill if">IF</span>
          <div className="seg">
            <button type="button" className={always ? 'on' : ''} onClick={() => setR({ ...r, when: { kind: 'group', op: 'and', items: [] } })}>
              Always
            </button>
            <button type="button" className={!always ? 'on' : ''} onClick={() => always && setR({ ...r, when: newGroup(columns) })}>
              Only when…
            </button>
          </div>
        </div>
        {!always && <GroupEditor group={r.when} columns={columns} onChange={(when) => setR({ ...r, when })} />}
        {always && <p className="muted small" style={{ margin: '8px 0 0' }}>The THEN actions are checked on every record.</p>}
      </section>

      <section className="rule-block">
        <div className="rule-block-head">
          <span className="pill then">THEN</span>
          <span className="muted small">these must be true</span>
        </div>
        <ActionsEditor label="THEN" actions={r.then} columns={columns} onChange={(then) => setR({ ...r, then })} />
      </section>

      {!always && (
        <section className={`rule-block ${hasElse ? '' : 'collapsed'}`}>
          <div className="rule-block-head">
            <span className="pill else">ELSE</span>
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={hasElse} onChange={(e) => setHasElse(e.target.checked)} />
              {hasElse ? 'these must be true otherwise' : 'Add actions for when the condition is NOT met (otherwise nothing is checked)'}
            </label>
          </div>
          {hasElse && <ActionsEditor label="ELSE" actions={r.else ?? []} columns={columns} onChange={(els) => setR({ ...r, else: els })} />}
        </section>
      )}

      {problems.length > 0 ? (
        <div className="alert warn small">
          <ul style={{ margin: 0 }}>
            {problems.slice(0, 6).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rule-preview">
          <span className="muted small">Reads as</span>
          <div>{preview}</div>
        </div>
      )}
      <FormulaHelp columns={columns} />
    </Modal>
  );
}
