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
export function likePattern(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// A typed value sits in the unfinished statement between two marks. A mark inside the value is escaped.
const HELD_VALUE_RX = /\u0001([^\u0002]*)\u0002/g;
const unheld = (held: string): string => held.replace(/\u0003([123])/g, (_, n: string) => String.fromCharCode(Number(n)));

/**
 * A value a person typed, such as a selected code or a keyword pattern, as it sits in a statement
 * that is still being put together. It never becomes statement text: `bindValues` puts a `?` in
 * its place and hands the value back beside the statement.
 */
export function sqlValue(value: string): string {
  return `\u0001${value.replace(/[\u0001-\u0003]/g, (c) => `\u0003${c.charCodeAt(0)}`)}\u0002`;
}

/** The finished statement, a `?` for each typed value, and the values in the order the statement reads them. */
export function bindValues(held: string): { sql: string; params: string[] } {
  const params: string[] = [];
  const sql = held.replace(HELD_VALUE_RX, (_, value: string) => {
    params.push(unheld(value));
    return '?';
  });
  return { sql, params };
}

/** How long an unfinished statement is with every value written in, the longest form a caller can send. */
export function writtenLength(held: string): number {
  return held.replace(HELD_VALUE_RX, (_, value: string) => sqlString(unheld(value))).length;
}

/**
 * The statement with each `?` replaced by its value as a string literal, for an engine or a route
 * that takes no values beside the statement. A `?` inside a literal or a quoted name is left alone.
 */
export function inlineParams(sql: string, params: readonly string[]): string {
  let next = 0;
  const written = sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\?/g, (token) => {
    if (token !== '?') return token;
    const value = params[next];
    next += 1;
    if (typeof value !== 'string') throw new ReportingError('bad_params', `the statement reads more values than the ${params.length} given`);
    return sqlString(value);
  });
  if (next !== params.length) throw new ReportingError('bad_params', `the statement reads ${next} values and ${params.length} were given`);
  return written;
}

/** The names the compiler gives the stages of its own statement (its WITH names). */
const STAGE_NAME_RX = /^(?:g|r|v|a|sm|rw|cl|s\d+)$/i;

/**
 * True for a name a table must not have. DuckDB looks a table name up among the statement's stages
 * first, whatever its case, so a table called `s1` would be read as the stage `s1`.
 */
export function isStageName(name: string): boolean {
  return STAGE_NAME_RX.test(name);
}

/**
 * The words the query route refuses anywhere in a statement outside a string literal. It reads
 * them as whole words whatever their case, and a quoted name is not a string literal, so a table
 * or column called `set` or `Update` gets every statement that names it refused.
 */
const ROUTE_WORDS = new Set([
  'read_parquet', 'parquet_scan', 'read_csv', 'read_csv_auto', 'read_json', 'read_json_auto',
  'read_json_objects', 'read_json_objects_auto', 'read_ndjson', 'read_ndjson_auto', 'read_ndjson_objects',
  'read_text', 'read_blob', 'read_duckdb', 'glob', 'sniff_csv',
  'parquet_metadata', 'parquet_file_metadata', 'parquet_kv_metadata', 'parquet_full_metadata',
  'parquet_schema', 'parquet_bloom_probe', 'json_execute_serialized_sql',
  'sqlite_scan', 'sqlite_attach', 'postgres_scan', 'postgres_attach', 'httpfs', 'iceberg_scan', 'delta_scan',
  'attach', 'detach', 'copy', 'export', 'import', 'install', 'load', 'force', 'pragma',
  'set', 'reset', 'call', 'create', 'insert', 'update', 'delete', 'drop', 'alter', 'merge',
  'truncate', 'vacuum', 'checkpoint', 'begin', 'commit', 'rollback', 'use', 'grant', 'revoke',
]);

/** True for a name no table or column of a model may have, since the route refuses the word. */
export function isRouteWord(name: string): boolean {
  return ROUTE_WORDS.has(name.toLowerCase());
}

/**
 * The tables a compiled statement reads, in the order it first reads them. The compiler quotes
 * every table and never quotes a stage, so a quoted name after FROM or JOIN is a table. Text inside
 * a string literal is skipped.
 */
export function tablesIn(sql: string): string[] {
  const bare = sql.replace(/'(?:[^']|'')*'/g, "''");
  const found = new Set<string>();
  for (const match of bare.matchAll(/\b(?:FROM|JOIN)\s+"([A-Za-z_][A-Za-z0-9_]*)"/g)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found];
}
