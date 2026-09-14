/**
 * Postgres adapter.
 *
 * `pg` is an optional dependency: someone running the SQLite demo should not
 * have to install a Postgres driver, so it is imported lazily and a missing
 * install produces an instruction rather than a stack trace.
 */

import {
  AdapterError,
  type Adapter,
  type ColumnInfo,
  type QueryResult,
  type TableInfo,
} from './types.js';

interface PgClientLike {
  query(config: { text: string; values?: unknown[] }): Promise<{
    rows: Record<string, unknown>[];
    fields: { name: string }[];
  }>;
  end(): Promise<void>;
}

export class PostgresAdapter implements Adapter {
  readonly kind = 'postgres';
  private client: PgClientLike | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly schema = 'public',
  ) {}

  static async connect(connectionString: string, schema = 'public'): Promise<PostgresAdapter> {
    const adapter = new PostgresAdapter(connectionString, schema);
    await adapter.getClient();
    return adapter;
  }

  private async getClient(): Promise<PgClientLike> {
    if (this.client) return this.client;

    let pg: { Client: new (config: { connectionString: string }) => PgClientLike };
    try {
      pg = (await import('pg')) as never;
    } catch {
      throw new AdapterError(
        "the Postgres adapter needs the 'pg' package: npm install pg",
      );
    }

    const client = new pg.Client({ connectionString: this.connectionString });
    try {
      await (client as unknown as { connect(): Promise<void> }).connect();
    } catch (error) {
      throw new AdapterError('could not connect to Postgres', error);
    }

    // Belt and braces alongside the read-only role: this makes the *session*
    // reject writes even if the role somehow has them.
    await client.query({ text: 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY' });

    this.client = client;
    return client;
  }

  async listTables(): Promise<TableInfo[]> {
    const client = await this.getClient();
    const { rows } = await client.query({
      text: `SELECT c.relname AS name,
                    n.nspname AS schema,
                    CASE WHEN c.reltuples < 0 THEN NULL
                         ELSE c.reltuples::bigint END AS row_estimate
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r', 'v', 'm', 'p')
               AND n.nspname = $1
             ORDER BY c.relname`,
      values: [this.schema],
    });

    return rows.map((row) => ({
      name: String(row.name),
      schema: String(row.schema),
      // reltuples is the planner's estimate, refreshed by ANALYZE; -1 means
      // "never analysed", which we surface as unknown rather than as zero.
      rowEstimate:
        row.row_estimate === null ? undefined : Number(row.row_estimate),
    }));
  }

  async describeTable(table: string): Promise<ColumnInfo[]> {
    const client = await this.getClient();
    const { rows } = await client.query({
      text: `SELECT a.attname AS name,
                    format_type(a.atttypid, a.atttypmod) AS type,
                    NOT a.attnotnull AS nullable,
                    COALESCE(i.indisprimary, false) AS primary_key
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             LEFT JOIN pg_index i
               ON i.indrelid = c.oid AND a.attnum = ANY(i.indkey) AND i.indisprimary
             WHERE n.nspname = $1 AND c.relname = $2
               AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum`,
      values: [this.schema, table],
    });

    if (rows.length === 0) {
      throw new AdapterError(`no table or view named ${table} in schema ${this.schema}`);
    }

    return rows.map((row) => ({
      name: String(row.name),
      type: String(row.type),
      nullable: Boolean(row.nullable),
      primaryKey: Boolean(row.primary_key),
    }));
  }

  async query(sql: string, timeoutMs: number): Promise<QueryResult> {
    const client = await this.getClient();
    const started = performance.now();
    try {
      // A real server-side cancel, unlike the SQLite case.
      await client.query({ text: `SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}` });
      const result = await client.query({ text: sql });
      return {
        rows: result.rows,
        columns: result.fields.map((f) => f.name),
        durationMs: Math.round(performance.now() - started),
        truncated: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/canceling statement due to statement timeout/i.test(message)) {
        throw new AdapterError(
          `the query exceeded the ${timeoutMs}ms timeout and was cancelled`,
          error,
        );
      }
      if (/read-only transaction/i.test(message)) {
        throw new AdapterError(
          'the session is read-only, so that statement was refused',
          error,
        );
      }
      throw new AdapterError(message, error);
    }
  }

  async explain(sql: string): Promise<string> {
    const client = await this.getClient();
    try {
      // No ANALYZE: the point of explain is to inspect a query *without*
      // running it.
      const { rows } = await client.query({ text: `EXPLAIN ${sql}` });
      return rows.map((row) => String(row['QUERY PLAN'] ?? '')).join('\n');
    } catch (error) {
      throw new AdapterError(
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }
}
