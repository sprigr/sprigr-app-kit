import { ReportingError } from './reasons';

const IDENT_RX = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

export function isIdentifier(name: unknown): name is string {
  return typeof name === 'string' && IDENT_RX.test(name);
}

/** A table, column or alias. Only plain names pass, so nothing here can close the quote. */
export function quoteIdent(name: string): string {
  if (!isIdentifier(name)) throw new ReportingError('bad_identifier', `"${String(name).slice(0, 60)}" is not a plain identifier`);
  return `"${name}"`;
}

/** A string literal. DuckDB reads a backslash literally, so doubling the quote is the whole escape. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function sqlNumber(value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ReportingError('bad_number', `${String(value)} is not a finite number`);
  return String(value);
}

export function sqlDate(iso: string): string {
  if (!ISO_DATE_RX.test(iso)) throw new ReportingError('bad_date', `"${String(iso).slice(0, 20)}" is not YYYY-MM-DD`);
  return `DATE '${iso}'`;
}

/** A `%keyword%` pattern with the wildcards in the keyword itself escaped. Use with `ESCAPE '\'`. */
export function likeContains(keyword: string): string {
  return sqlString(`%${keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
}
