/**
 * Minimal ambient declaration for `pg`.
 *
 * `pg` is an optional peer dependency — someone running the SQLite demo should
 * not have to install a Postgres driver — so it is imported dynamically. This
 * declaration is what lets the project typecheck without it installed; when it
 * *is* installed, its own richer types take precedence.
 */
declare module 'pg' {
  export interface QueryConfig {
    text: string;
    values?: unknown[];
  }

  export interface QueryResult {
    rows: Record<string, unknown>[];
    fields: { name: string }[];
  }

  export class Client {
    constructor(config: { connectionString: string });
    connect(): Promise<void>;
    query(config: QueryConfig): Promise<QueryResult>;
    end(): Promise<void>;
  }
}
