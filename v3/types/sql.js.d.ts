declare module 'sql.js' {
  interface SqlJsStatic {
    Database: typeof Database;
  }

  class Database {
    constructor(data?: ArrayLike<number> | Buffer | null);
    run(sql: string, params?: any): Database;
    exec(sql: string, params?: any): QueryExecResult[];
    each(sql: string, params: any, callback: (row: any) => void, done?: () => void): Database;
    prepare(sql: string, params?: any): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }

  interface QueryExecResult {
    columns: string[];
    values: any[][];
  }

  class Statement {
    bind(params?: any): boolean;
    step(): boolean;
    getAsObject(params?: any): Record<string, any>;
    get(params?: any): any[];
    getColumnNames(): string[];
    free(): boolean;
    run(params?: any): void;
    reset(): void;
  }

  export default function initSqlJs(config?: {
    locateFile?: (filename: string) => string;
  }): Promise<SqlJsStatic>;

  export { Database, Statement, QueryExecResult, SqlJsStatic };
}
