/** What querygate needs from a database. Keeping it this small is what makes
 * the SQLite adapter usable as the offline demo and the test double at once. */

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface TableInfo {
  name: string;
  schema?: string;
  /** Approximate, and labelled as such wherever it is shown. */
  rowEstimate?: number;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  columns: string[];
  /** Milliseconds spent inside the database. */
  durationMs: number;
  /** True when the row cap stopped the result short. */
  truncated: boolean;
}

export interface Adapter {
  readonly kind: string;
  listTables(): Promise<TableInfo[]>;
  describeTable(table: string): Promise<ColumnInfo[]>;
  query(sql: string, timeoutMs: number): Promise<QueryResult>;
  explain(sql: string): Promise<string>;
  close(): Promise<void>;
}

export class AdapterError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
