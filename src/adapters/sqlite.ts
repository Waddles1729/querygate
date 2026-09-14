/**
 * SQLite adapter.
 *
 * Doubles as the offline demo: `npm run demo` seeds a small shop database and
 * points the server at it, so the whole thing is exercisable with no external
 * service and no credentials.
 */

import Database from 'better-sqlite3';

import {
  AdapterError,
  type Adapter,
  type ColumnInfo,
  type QueryResult,
  type TableInfo,
} from './types.js';

export class SqliteAdapter implements Adapter {
  readonly kind = 'sqlite';
  private readonly db: Database.Database;

  constructor(file: string, { readonly = true }: { readonly?: boolean } = {}) {
    try {
      // The real read-only boundary: SQLite refuses writes at the file handle,
      // so a statement that slipped past the guard still cannot change anything.
      this.db = new Database(file, { readonly, fileMustExist: readonly });
    } catch (error) {
      throw new AdapterError(`could not open the SQLite database at ${file}`, error);
    }
  }

  async listTables(): Promise<TableInfo[]> {
    const rows = this.db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as { name: string }[];

    return rows.map((row) => ({
      name: row.name,
      rowEstimate: this.rowEstimate(row.name),
    }));
  }

  async describeTable(table: string): Promise<ColumnInfo[]> {
    // PRAGMA takes the name as a bound parameter here, so the caller's string
    // is never concatenated into SQL.
    const rows = this.db.pragma(`table_info(${quoteIdent(table)})`) as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];

    if (rows.length === 0) {
      throw new AdapterError(`no table or view named ${table}`);
    }

    return rows.map((row) => ({
      name: row.name,
      type: row.type || 'unknown',
      nullable: row.notnull === 0,
      primaryKey: row.pk > 0,
    }));
  }

  async query(sql: string, timeoutMs: number): Promise<QueryResult> {
    const started = performance.now();
    try {
      // better-sqlite3 is synchronous, so a timeout can only be enforced as a
      // busy/progress limit rather than by cancelling mid-statement.
      this.db.pragma(`busy_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);

      const statement = this.db.prepare(sql);
      const rows = statement.all() as Record<string, unknown>[];
      const columns =
        rows.length > 0
          ? Object.keys(rows[0])
          : safeColumnNames(statement);

      return {
        rows,
        columns,
        durationMs: Math.round(performance.now() - started),
        truncated: false,
      };
    } catch (error) {
      throw new AdapterError(describeSqliteError(error), error);
    }
  }

  async explain(sql: string): Promise<string> {
    try {
      const rows = this.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as {
        detail: string;
      }[];
      return rows.map((row) => row.detail).join('\n') || '(no plan returned)';
    } catch (error) {
      throw new AdapterError(describeSqliteError(error), error);
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * A cheap row count.
   *
   * SQLite keeps no statistics, so this is a real COUNT(*) — fine at demo
   * scale, and the reason `rowEstimate` is documented as approximate rather
   * than promised to be free.
   */
  private rowEstimate(table: string): number | undefined {
    try {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`)
        .get() as { n: number };
      return row.n;
    } catch {
      return undefined;
    }
  }
}

/** Double-quote an identifier, escaping any embedded quote. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function safeColumnNames(statement: Database.Statement): string[] {
  try {
    return statement.columns().map((c) => c.name);
  } catch {
    // .columns() throws for statements that return no data.
    return [];
  }
}

function describeSqliteError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/no such table/i.test(message)) {
    return `${message} — call list_tables to see what is available`;
  }
  if (/attempt to write a readonly database/i.test(message)) {
    return 'the database is open read-only, so that statement was refused';
  }
  return message;
}
