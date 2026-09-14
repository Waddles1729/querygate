/**
 * The MCP server: five tools over a guarded database connection.
 *
 * A note on tool design. An agent cannot ask a follow-up question of the
 * database schema the way a person can, so each tool returns enough context to
 * make the *next* call correctly — `list_tables` includes row estimates so the
 * agent can tell a lookup table from a fact table, and a rejection explains
 * what would have been allowed instead of just saying no. Tools that only
 * return errors teach an agent to keep guessing.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Adapter } from './adapters/types.js';
import { AdapterError } from './adapters/types.js';
import {
  summariseSql,
  type AuditEntry,
  type AuditSink,
} from './audit.js';
import { Policy, PolicyViolation, collectCteNames } from './policy.js';
import { QueryRejected, guardQuery } from './sql/guard.js';

export interface ServerOptions {
  adapter: Adapter;
  policy: Policy;
  audit: AuditSink;
  maxRows: number;
  timeoutMs: number;
  /** Identifies the caller in the audit log. */
  actor?: string;
  name?: string;
  version?: string;
}

/**
 * The SDK's tool-result shape allows arbitrary extra keys (protocol
 * extensions live there), so the index signature is part of the contract
 * rather than looseness on our side.
 */
interface ToolText {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

const ok = (text: string): ToolText => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolText => ({
  content: [{ type: 'text', text }],
  isError: true,
});

export function createServer(options: ServerOptions): McpServer {
  const { adapter, policy, audit, maxRows, timeoutMs } = options;
  const actor = options.actor ?? 'anonymous';

  const server = new McpServer({
    name: options.name ?? 'querygate',
    version: options.version ?? '0.1.0',
  });

  const record = (entry: Omit<AuditEntry, 'at' | 'actor'>) => {
    audit.write({ at: new Date().toISOString(), actor, ...entry });
  };

  server.registerTool(
    'list_tables',
    {
      title: 'List tables',
      description:
        'List the tables and views this connection is permitted to read, with ' +
        'approximate row counts. Start here: table names are not guessable and ' +
        'anything hidden by policy is not listed.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      try {
        const tables = (await adapter.listTables()).filter((t) =>
          policy.isVisible(t.name),
        );
        record({ tool: 'list_tables', rows: tables.length, outcome: 'ok' });

        if (tables.length === 0) {
          return ok('No tables are visible to this connection.');
        }

        const lines = tables.map((t) => {
          const name = t.schema ? `${t.schema}.${t.name}` : t.name;
          const rows =
            t.rowEstimate === undefined ? '' : `  ~${t.rowEstimate.toLocaleString()} rows`;
          return `${name}${rows}`;
        });
        return ok(`${tables.length} table(s):\n${lines.join('\n')}`);
      } catch (error) {
        record({ tool: 'list_tables', outcome: 'error', reason: message(error) });
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe a table',
      description:
        'Show the columns of one table: name, type, nullability, primary key, ' +
        'and whether the column is masked by policy. Check this before writing ' +
        'a query rather than guessing column names.',
      inputSchema: { table: z.string().describe('Table or view name') },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ table }) => {
      try {
        if (!policy.isVisible(table)) {
          // Deliberately the same wording as a table that does not exist.
          // Distinguishing them tells the caller what is hidden.
          record({
            tool: 'describe_table',
            tables: [table],
            outcome: 'rejected',
            reason: 'not visible',
          });
          return fail(`No table named ${table} is available.`);
        }

        const columns = await adapter.describeTable(table);
        record({ tool: 'describe_table', tables: [table], rows: columns.length, outcome: 'ok' });

        const lines = columns.map((c) => {
          const flags = [
            c.primaryKey ? 'primary key' : null,
            c.nullable ? null : 'not null',
            policy.strategyFor(table, c.name)
              ? `masked: ${policy.strategyFor(table, c.name)}`
              : null,
          ].filter(Boolean);
          return `${c.name}  ${c.type}${flags.length ? `  (${flags.join(', ')})` : ''}`;
        });
        return ok(`${table}\n${lines.join('\n')}`);
      } catch (error) {
        record({
          tool: 'describe_table',
          tables: [table],
          outcome: 'error',
          reason: message(error),
        });
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    'run_query',
    {
      title: 'Run a read-only query',
      description:
        `Run a single SELECT and return the rows. Writes, DDL and multiple ` +
        `statements are refused. Results are capped at ${maxRows} rows and ` +
        `${timeoutMs}ms, and columns marked as masked are transformed before ` +
        `they are returned.`,
      inputSchema: {
        sql: z.string().describe('One SELECT statement'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Row limit; capped at ${maxRows}`),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ sql, limit }) => {
      const effectiveMax = limit ? Math.min(limit, maxRows) : maxRows;

      let guarded;
      try {
        guarded = guardQuery(sql, { maxRows: effectiveMax });
        policy.assertTablesAllowed(guarded.tables, collectCteNames(sql));
      } catch (error) {
        const reason = message(error);
        record({
          tool: 'run_query',
          sql: summariseSql(sql),
          outcome: 'rejected',
          reason,
        });
        if (error instanceof QueryRejected || error instanceof PolicyViolation) {
          return fail(`Query refused: ${reason}`);
        }
        return fail(reason);
      }

      try {
        const result = await adapter.query(guarded.sql, timeoutMs);
        const { rows, maskedColumns } = policy.maskRows(result.rows, guarded.tables);

        record({
          tool: 'run_query',
          sql: summariseSql(guarded.sql),
          tables: guarded.tables,
          rows: rows.length,
          durationMs: result.durationMs,
          maskedColumns,
          outcome: 'ok',
        });

        return ok(formatRows(rows, result.columns, {
          durationMs: result.durationMs,
          limit: guarded.limit,
          limitApplied: guarded.limitApplied,
          maskedColumns,
        }));
      } catch (error) {
        record({
          tool: 'run_query',
          sql: summariseSql(guarded.sql),
          tables: guarded.tables,
          outcome: 'error',
          reason: message(error),
        });
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    'explain_query',
    {
      title: 'Explain a query',
      description:
        'Show the planner output for a SELECT without running it. Use this ' +
        'before running anything that might be expensive.',
      inputSchema: { sql: z.string().describe('One SELECT statement') },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ sql }) => {
      try {
        const guarded = guardQuery(sql, { maxRows });
        policy.assertTablesAllowed(guarded.tables, collectCteNames(sql));
        const plan = await adapter.explain(guarded.sql);
        record({
          tool: 'explain_query',
          sql: summariseSql(guarded.sql),
          tables: guarded.tables,
          outcome: 'ok',
        });
        return ok(plan);
      } catch (error) {
        const reason = message(error);
        record({
          tool: 'explain_query',
          sql: summariseSql(sql),
          outcome: error instanceof AdapterError ? 'error' : 'rejected',
          reason,
        });
        return fail(reason);
      }
    },
  );

  server.registerTool(
    'audit_tail',
    {
      title: 'Recent activity',
      description:
        'Show what this server has been asked to do recently, including the ' +
        'calls it refused. Useful for a human checking what an agent has been ' +
        'reading.',
      inputSchema: {
        limit: z.number().int().positive().max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const entries = audit.recent(limit ?? 20);
      if (entries.length === 0) return ok('Nothing recorded yet.');

      const lines = entries.map((e) => {
        const parts = [e.at, e.tool, e.outcome.toUpperCase()];
        if (e.rows !== undefined) parts.push(`${e.rows} rows`);
        if (e.durationMs !== undefined) parts.push(`${e.durationMs}ms`);
        if (e.maskedColumns?.length) parts.push(`masked: ${e.maskedColumns.join(',')}`);
        if (e.reason) parts.push(e.reason);
        return parts.join('  ');
      });
      return ok(lines.join('\n'));
    },
  );

  return server;
}

/**
 * Render rows as a text table.
 *
 * Fixed-width columns rather than JSON: it is markedly cheaper in tokens for
 * wide result sets, and a model reads it about as well. Long values are
 * truncated per cell so one enormous JSON blob in a column cannot blow out the
 * whole response.
 */
function formatRows(
  rows: Record<string, unknown>[],
  columns: string[],
  meta: {
    durationMs: number;
    limit: number;
    limitApplied: boolean;
    maskedColumns: string[];
  },
): string {
  const footerParts = [`${rows.length} row(s)`, `${meta.durationMs}ms`];
  if (meta.maskedColumns.length > 0) {
    footerParts.push(`masked by policy: ${meta.maskedColumns.join(', ')}`);
  }
  if (meta.limitApplied && rows.length >= meta.limit) {
    footerParts.push(`capped at ${meta.limit} rows — narrow the query for more`);
  }
  const footer = footerParts.join(' · ');

  if (rows.length === 0) return `No rows.\n\n${footer}`;

  const headers = columns.length > 0 ? columns : Object.keys(rows[0]);
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return 'NULL';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    const text = String(value);
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  };

  const widths = headers.map((header, i) =>
    Math.min(
      40,
      Math.max(header.length, ...rows.map((row) => cell(row[headers[i]]).length)),
    ),
  );

  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]).slice(0, widths[i])).join('  ');

  const out = [
    line(headers),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map((row) => line(headers.map((h) => cell(row[h])))),
  ];

  return `${out.join('\n')}\n\n${footer}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
