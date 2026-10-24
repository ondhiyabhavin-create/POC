/**
 * IF / AND / OR / THEN / ELSE rule evaluation and plain-English descriptions.
 */
import {
  columnResolver,
  compareValues,
  isNumeric,
  compileFormula,
  evaluate,
  safeRegex,
  toNumber,
  truthy,
  valuesEqual,
  valueToString,
  type ColumnResolver,
  type CompiledFormula,
  type Value,
} from './expression';
import type { ActionCheck, ColumnDefinition, CompareOperator, ConditionGroup, ConditionNode, Operand, RuleAction } from './types';

export const COMPARE_OPERATORS: { value: CompareOperator; label: string; needsRight: boolean }[] = [
  { value: 'equals', label: 'equals', needsRight: true },
  { value: 'notEquals', label: 'does not equal', needsRight: true },
  { value: 'gt', label: 'is greater than', needsRight: true },
  { value: 'gte', label: 'is greater than or equal to', needsRight: true },
  { value: 'lt', label: 'is less than', needsRight: true },
  { value: 'lte', label: 'is less than or equal to', needsRight: true },
  { value: 'isBlank', label: 'is blank', needsRight: false },
  { value: 'isNotBlank', label: 'is not blank', needsRight: false },
  { value: 'in', label: 'is one of', needsRight: true },
  { value: 'notIn', label: 'is not one of', needsRight: true },
  { value: 'contains', label: 'contains', needsRight: true },
  { value: 'notContains', label: 'does not contain', needsRight: true },
  { value: 'startsWith', label: 'starts with', needsRight: true },
  { value: 'endsWith', label: 'ends with', needsRight: true },
  { value: 'matches', label: 'matches pattern', needsRight: true },
  { value: 'isTrue', label: 'is true', needsRight: false },
  { value: 'isFalse', label: 'is false', needsRight: false },
];

export const ACTION_CHECKS: { value: ActionCheck; label: string; needsValue: boolean; phrase: string }[] = [
  { value: 'required', label: 'is required', needsValue: false, phrase: 'is required' },
  { value: 'blank', label: 'must be blank', needsValue: false, phrase: 'must be blank' },
  { value: 'equals', label: 'must equal', needsValue: true, phrase: 'must equal' },
  { value: 'notEquals', label: 'must not equal', needsValue: true, phrase: 'must not equal' },
  { value: 'oneOf', label: 'must be one of', needsValue: true, phrase: 'must be one of' },
  { value: 'notOneOf', label: 'must not be one of', needsValue: true, phrase: 'must not be one of' },
  { value: 'gt', label: 'must be greater than', needsValue: true, phrase: 'must be greater than' },
  { value: 'gte', label: 'must be at least', needsValue: true, phrase: 'must be at least' },
  { value: 'lt', label: 'must be less than', needsValue: true, phrase: 'must be less than' },
  { value: 'lte', label: 'must be at most', needsValue: true, phrase: 'must be at most' },
  { value: 'matches', label: 'must match pattern', needsValue: true, phrase: 'must match the pattern' },
  { value: 'minLength', label: 'must have at least N characters', needsValue: true, phrase: 'must have at least this many characters:' },
  { value: 'maxLength', label: 'must have at most N characters', needsValue: true, phrase: 'must have at most this many characters:' },
  { value: 'formula', label: 'must satisfy formula', needsValue: true, phrase: 'must satisfy' },
];

const listOf = (v: Value) =>
  valueToString(v)
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');

/** Compiles formulas once per rule set and evaluates conditions/actions against rows. */
export class ConditionEngine {
  private readonly resolver: ColumnResolver;
  private readonly cache = new Map<string, CompiledFormula | { ok: false; error: string }>();
  private readonly colIndex: Map<string, number>;

  constructor(private readonly columns: ColumnDefinition[]) {
    this.resolver = columnResolver(columns);
    this.colIndex = new Map(columns.map((c, i) => [c.key, i]));
  }

  formula(src: string): CompiledFormula | { ok: false; error: string } {
    let f = this.cache.get(src);
    if (!f) {
      f = compileFormula(src, this.resolver);
      this.cache.set(src, f);
    }
    return f;
  }

  /** Returns problems (unknown columns, bad formulas, bad regex) in a condition tree / actions. */
  check(when: ConditionGroup | undefined, actions: RuleAction[]): string[] {
    const out: string[] = [];
    const operand = (o: Operand | undefined, where: string) => {
      if (!o) return;
      if (o.kind === 'column' && !this.colIndex.has(o.column)) out.push(`${where}: unknown column "${o.column}".`);
      if (o.kind === 'formula') {
        const f = this.formula(o.formula);
        if (!f.ok) out.push(`${where}: ${f.error}`);
      }
    };
    const walk = (n: ConditionNode, path: string) => {
      if (n.kind === 'group') n.items.forEach((c, i) => walk(c, `${path}.${i + 1}`));
      else {
        operand(n.left, `Condition ${path}`);
        const meta = COMPARE_OPERATORS.find((o) => o.value === n.operator);
        if (!meta) out.push(`Condition ${path}: unknown operator "${n.operator}".`);
        if (meta?.needsRight) {
          if (!n.right) out.push(`Condition ${path}: a value to compare with is required.`);
          operand(n.right, `Condition ${path}`);
          if (n.operator === 'matches' && n.right?.kind === 'value') {
            try {
              new RegExp(n.right.value);
            } catch {
              out.push(`Condition ${path}: "${n.right.value}" is not a valid regular expression.`);
            }
          }
        }
      }
    };
    if (when) walk(when, '1');
    actions.forEach((a, i) => {
      const where = `Action ${i + 1}`;
      if (!this.colIndex.has(a.column)) out.push(`${where}: unknown column "${a.column}".`);
      const meta = ACTION_CHECKS.find((c) => c.value === a.check);
      if (!meta) out.push(`${where}: unknown check "${a.check}".`);
      if (meta?.needsValue && !a.value) out.push(`${where}: a value is required.`);
      operand(a.value, where);
      if (a.check === 'matches' && a.value?.kind === 'value') {
        try {
          new RegExp(a.value.value);
        } catch {
          out.push(`${where}: "${a.value.value}" is not a valid regular expression.`);
        }
      }
    });
    return out;
  }

  value(o: Operand, row: string[]): Value {
    switch (o.kind) {
      case 'column': {
        const i = this.colIndex.get(o.column);
        return i === undefined ? '' : (row[i] ?? '').trim();
      }
      case 'value':
        return o.value;
      case 'formula': {
        const f = this.formula(o.formula);
        return f.ok ? evaluate(f, row) : '';
      }
    }
  }

  test(node: ConditionNode, row: string[]): boolean {
    if (node.kind === 'group') {
      if (node.items.length === 0) return !node.not;
      const r = node.op === 'and' ? node.items.every((c) => this.test(c, row)) : node.items.some((c) => this.test(c, row));
      return node.not ? !r : r;
    }
    const l = this.value(node.left, row);
    const r = node.right ? this.value(node.right, row) : '';
    const ls = valueToString(l);
    const rs = valueToString(r);
    switch (node.operator) {
      case 'equals':
        return valuesEqual(l, r);
      case 'notEquals':
        return !valuesEqual(l, r);
      case 'gt':
        return ls.trim() !== '' && compareValues(l, r) > 0;
      case 'gte':
        return ls.trim() !== '' && compareValues(l, r) >= 0;
      case 'lt':
        return ls.trim() !== '' && compareValues(l, r) < 0;
      case 'lte':
        return ls.trim() !== '' && compareValues(l, r) <= 0;
      case 'isBlank':
        return ls.trim() === '';
      case 'isNotBlank':
        return ls.trim() !== '';
      case 'in':
        return listOf(r).some((x) => valuesEqual(l, x));
      case 'notIn':
        return !listOf(r).some((x) => valuesEqual(l, x));
      case 'contains':
        return ls.toLowerCase().includes(rs.toLowerCase());
      case 'notContains':
        return !ls.toLowerCase().includes(rs.toLowerCase());
      case 'startsWith':
        return ls.toLowerCase().startsWith(rs.toLowerCase());
      case 'endsWith':
        return ls.toLowerCase().endsWith(rs.toLowerCase());
      case 'matches':
        return safeRegex(rs).test(ls);
      case 'isTrue':
        return truthy(l);
      case 'isFalse':
        return !truthy(l);
    }
  }

  /** Returns true when the action is satisfied. Blank cells only fail "required"/"equals"/formula-type checks. */
  satisfied(a: RuleAction, row: string[]): boolean {
    const i = this.colIndex.get(a.column);
    if (i === undefined) return true;
    const v = (row[i] ?? '').trim();
    const target = a.value ? this.value(a.value, row) : '';
    // A non-numeric value compared with a number is a data-type problem, reported by the column checks.
    if ((a.check === 'gt' || a.check === 'gte' || a.check === 'lt' || a.check === 'lte') && v !== '' && isNumeric(target) && !isNumeric(v)) return true;
    switch (a.check) {
      case 'required':
        return v !== '';
      case 'blank':
        return v === '';
      case 'equals':
        return valuesEqual(v, target);
      case 'notEquals':
        return !valuesEqual(v, target);
      case 'oneOf':
        return v === '' || listOf(target).some((x) => valuesEqual(v, x));
      case 'notOneOf':
        return !listOf(target).some((x) => valuesEqual(v, x));
      case 'gt':
        return v === '' || compareValues(v, target) > 0;
      case 'gte':
        return v === '' || compareValues(v, target) >= 0;
      case 'lt':
        return v === '' || compareValues(v, target) < 0;
      case 'lte':
        return v === '' || compareValues(v, target) <= 0;
      case 'matches':
        return v === '' || safeRegex(valueToString(target)).test(v);
      case 'minLength':
        return v === '' || v.length >= toNumber(target);
      case 'maxLength':
        return v.length <= toNumber(target);
      case 'formula':
        return truthy(target);
    }
  }

  // ---------- Descriptions ----------

  private colName(key: string): string {
    const c = this.columns.find((x) => x.key === key);
    return c ? `${c.header} (${c.letter})` : key;
  }

  describeOperand(o: Operand | undefined): string {
    if (!o) return '';
    if (o.kind === 'column') return this.colName(o.column);
    if (o.kind === 'formula') return o.formula;
    return `"${o.value}"`;
  }

  describe(node: ConditionNode, top = true): string {
    if (node.kind === 'group') {
      if (node.items.length === 0) return 'always';
      const parts = node.items.map((c) => this.describe(c, false));
      const joined = parts.join(node.op === 'and' ? ' and ' : ' or ');
      const wrapped = !top && parts.length > 1 ? `(${joined})` : joined;
      return node.not ? `not ${parts.length > 1 || !top ? wrapped : `(${wrapped})`}` : wrapped;
    }
    const meta = COMPARE_OPERATORS.find((o) => o.value === node.operator);
    const left = this.describeOperand(node.left);
    if (!meta?.needsRight) return `${left} ${meta?.label ?? node.operator}`;
    const right =
      (node.operator === 'in' || node.operator === 'notIn') && node.right?.kind === 'value'
        ? listOf(node.right.value).map((x) => `"${x}"`).join(', ')
        : this.describeOperand(node.right);
    return `${left} ${meta.label} ${right}`;
  }

  describeAction(a: RuleAction): string {
    const meta = ACTION_CHECKS.find((c) => c.value === a.check);
    const val =
      (a.check === 'oneOf' || a.check === 'notOneOf') && a.value?.kind === 'value'
        ? listOf(a.value.value).map((x) => `"${x}"`).join(', ')
        : this.describeOperand(a.value);
    return `${this.colName(a.column)} ${meta?.phrase ?? a.check}${meta?.needsValue ? ` ${val}` : ''}`;
  }
}

export function emptyGroup(): ConditionGroup {
  return { kind: 'group', op: 'and', items: [] };
}
