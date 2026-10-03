declare module 'sql.js' {
  interface Statement {
    bind(values: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  }
  interface Database {
    exec(sql: string): unknown;
    prepare(sql: string): Statement;
    getRowsModified(): number;
  }
  interface SqlJsStatic {
    Database: new () => Database;
  }
  export default function initSqlJs(): Promise<SqlJsStatic>;
}
