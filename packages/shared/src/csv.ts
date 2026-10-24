/**
 * Minimal RFC 4180 CSV parser. Values are returned exactly as written
 * (no trimming, no type coercion) so the validator can detect things such as
 * trailing spaces and lost leading zeros.
 */
export interface ParsedCsv {
  rows: string[][];
  /** 1-based physical line number on which each parsed row starts. */
  lineNumbers: number[];
  hadBom: boolean;
  errors: { line: number; message: string }[];
  /** Counts of line-ending styles seen outside quoted values. */
  lineEndings: { crlf: number; lf: number; cr: number };
}

export interface CsvParseOptions {
  delimiter?: string;
  /** Quote character, or "none" to treat quotes as ordinary text. */
  quote?: string;
}

export function parseCsv(input: string, opts: CsvParseOptions = {}): ParsedCsv {
  const delim = opts.delimiter === '\\t' ? '\t' : opts.delimiter || ',';
  const quote = opts.quote === 'none' ? '' : opts.quote || '"';
  const lineEndings = { crlf: 0, lf: 0, cr: 0 };
  let text = input;
  let hadBom = false;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    hadBom = true;
  }

  const rows: string[][] = [];
  const lineNumbers: number[] = [];
  const errors: ParsedCsv['errors'] = [];

  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;
  let fieldWasQuoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
    fieldWasQuoted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    lineNumbers.push(rowStartLine);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === quote) {
        if (text[i + 1] === quote) {
          field += quote;
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (ch === '\n') line++;
      field += ch;
      i++;
      continue;
    }

    if (quote && ch === quote) {
      if (field.length === 0 && !fieldWasQuoted) {
        inQuotes = true;
        fieldWasQuoted = true;
      } else {
        // Stray quote inside an unquoted field — keep it, but report.
        errors.push({ line, message: 'Unexpected quote character inside an unquoted value.' });
        field += ch;
      }
      i++;
      continue;
    }
    if (ch === delim) {
      endField();
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRow();
      if (ch === '\r' && text[i + 1] === '\n') {
        lineEndings.crlf++;
        i++;
      } else if (ch === '\n') lineEndings.lf++;
      else lineEndings.cr++;
      i++;
      line++;
      rowStartLine = line;
      continue;
    }
    field += ch;
    i++;
  }

  if (inQuotes) {
    errors.push({ line: rowStartLine, message: 'A quoted value was never closed.' });
  }
  // Flush the last row unless the file ended with a newline.
  if (field.length > 0 || row.length > 0 || fieldWasQuoted) {
    endRow();
  }

  // Drop fully blank trailing rows (common when files end with extra newlines).
  while (rows.length > 0 && isBlankRow(rows[rows.length - 1])) {
    rows.pop();
    lineNumbers.pop();
  }

  return { rows, lineNumbers, hadBom, errors, lineEndings };
}

export function isBlankRow(row: string[]): boolean {
  return row.every((v) => v.trim() === '');
}

/** Serialize rows to CSV (used for error reports). */
export function toCsv(rows: (string | number | undefined | null)[][]): string {
  return (
    rows
      .map((r) =>
        r
          .map((v) => {
            const s = v === undefined || v === null ? '' : String(v);
            return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(','),
      )
      .join('\r\n') + '\r\n'
  );
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA" ... */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Guess the delimiter from the first line: the candidate that splits it into the most fields. */
export function detectDelimiter(text: string): string {
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t', '|']) {
    const n = first.split(d).length - 1;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

export const DELIMITER_LABEL: Record<string, string> = { ',': 'comma (,)', ';': 'semicolon (;)', '\t': 'tab', '|': 'pipe (|)' };
