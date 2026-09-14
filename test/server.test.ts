/**
 * End-to-end over a real MCP client/server pair and a real SQLite database.
 *
 * These go through the actual protocol rather than calling the handlers
 * directly, because the tool schemas and result shapes are part of the
 * contract — a tool that works when called in-process and fails to serialise
 * over MCP is still broken.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SqliteAdapter } from '../src/adapters/sqlite.js';
import { MemoryAuditSink } from '../src/audit.js';
import { seed } from '../src/demo/seed.js';
import { Policy } from '../src/policy.js';
import { createServer } from '../src/server.js';

let directory: string;
let client: Client;
let adapter: SqliteAdapter;
let audit: MemoryAuditSink;

const text = (result: unknown): string => {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content.map((c) => c.text).join('\n');
};
const isError = (result: unknown): boolean =>
  (result as { isError?: boolean }).isError === true;

const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args });

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'querygate-'));
  const file = join(directory, 'shop.db');
  seed(file);

  adapter = new SqliteAdapter(file, { readonly: true });
  audit = new MemoryAuditSink();

  const server = createServer({
    adapter,
    policy: new Policy({
      denyTables: ['employee_salaries'],
      hashSalt: 'test',
      mask: [
        { table: 'customers', column: 'email', strategy: 'domain' },
        { table: 'customers', column: 'phone', strategy: 'partial' },
      ],
    }),
    audit,
    maxRows: 25,
    timeoutMs: 2000,
    actor: 'test',
  });

  client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  await adapter.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('tool surface', () => {
  it('advertises every tool with a description', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'audit_tail',
      'describe_table',
      'explain_query',
      'list_tables',
      'run_query',
    ]);
    for (const tool of tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
    }
  });

  it('marks the querying tools as read-only', async () => {
    const { tools } = await client.listTools();
    const run = tools.find((t) => t.name === 'run_query');
    expect(run?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('list_tables', () => {
  it('lists the visible tables with row counts', async () => {
    const output = text(await call('list_tables'));
    expect(output).toContain('customers');
    expect(output).toContain('orders');
    expect(output).toMatch(/~2,500 rows/);
  });

  it('omits a denied table entirely', async () => {
    const output = text(await call('list_tables'));
    expect(output).not.toContain('employee_salaries');
  });
});

describe('describe_table', () => {
  it('shows columns, keys and which are masked', async () => {
    const output = text(await call('describe_table', { table: 'customers' }));
    expect(output).toContain('id');
    expect(output).toContain('primary key');
    expect(output).toMatch(/email.*masked: domain/);
  });

  it('treats a denied table the same as one that does not exist', async () => {
    const denied = text(await call('describe_table', { table: 'employee_salaries' }));
    const missing = text(await call('describe_table', { table: 'no_such_table' }));
    // Identical wording: the difference would leak the schema.
    expect(denied).toBe('No table named employee_salaries is available.');
    expect(missing).toContain('no_such_table');
  });
});

describe('run_query', () => {
  it('returns rows for a plain SELECT', async () => {
    const output = text(await call('run_query', { sql: 'SELECT id, city FROM customers LIMIT 3' }));
    expect(output).toContain('city');
    expect(output).toContain('3 row(s)');
  });

  it('masks columns on the way out', async () => {
    const output = text(await call('run_query', { sql: 'SELECT email, phone FROM customers LIMIT 2' }));
    expect(output).toContain('[redacted]@example.com');
    expect(output).not.toMatch(/aoi\.sato\d+@example\.com/);
    expect(output).toContain('masked by policy: email, phone');
  });

  it('still aggregates correctly over a masked column', async () => {
    // The point of masking on egress: the database sees real values.
    const output = text(
      await call('run_query', { sql: 'SELECT COUNT(DISTINCT email) AS n FROM customers' }),
    );
    expect(output).toMatch(/\b400\b/);
  });

  it('caps the row count and says so', async () => {
    const output = text(await call('run_query', { sql: 'SELECT * FROM orders' }));
    expect(output).toContain('25 row(s)');
    expect(output).toContain('capped at 25 rows');
  });

  it('honours a smaller explicit limit', async () => {
    const output = text(await call('run_query', { sql: 'SELECT * FROM orders', limit: 5 }));
    expect(output).toContain('5 row(s)');
  });

  it('refuses a write', async () => {
    const result = await call('run_query', { sql: 'DELETE FROM orders' });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain('only SELECT statements are allowed');
  });

  it('refuses a query against a denied table', async () => {
    const result = await call('run_query', { sql: 'SELECT * FROM employee_salaries' });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain('not permitted to read');
  });

  it('refuses a denied table reached through a join', async () => {
    const result = await call('run_query', {
      sql: 'SELECT c.city FROM customers c JOIN employee_salaries s ON s.id = c.id',
    });
    expect(isError(result)).toBe(true);
  });

  it('allows a CTE without mistaking it for a table', async () => {
    const result = await call('run_query', {
      sql: `WITH busy AS (
              SELECT customer_id, COUNT(*) AS n FROM orders GROUP BY customer_id
            )
            SELECT customer_id, n FROM busy ORDER BY n DESC LIMIT 3`,
    });
    expect(isError(result)).toBe(false);
    expect(text(result)).toContain('3 row(s)');
  });

  it('reports a bad query without crashing', async () => {
    const result = await call('run_query', { sql: 'SELECT * FROM nope' });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain('call list_tables');
  });

  it('renders an empty result set as no rows', async () => {
    const output = text(await call('run_query', { sql: "SELECT * FROM orders WHERE status = 'imaginary'" }));
    expect(output).toContain('No rows.');
  });
});

describe('explain_query', () => {
  it('returns a plan without running the query', async () => {
    const output = text(await call('explain_query', { sql: 'SELECT * FROM orders WHERE customer_id = 1' }));
    expect(output.toLowerCase()).toContain('orders');
  });

  it('applies the policy to EXPLAIN too', async () => {
    const result = await call('explain_query', { sql: 'SELECT * FROM employee_salaries' });
    expect(isError(result)).toBe(true);
  });
});

describe('audit trail', () => {
  it('records refused calls, not just successful ones', async () => {
    await call('run_query', { sql: 'DROP TABLE orders' });
    const entries = audit.recent(5);
    const rejected = entries.find((e) => e.outcome === 'rejected');
    expect(rejected).toBeDefined();
    expect(rejected?.tool).toBe('run_query');
    expect(rejected?.reason).toContain('only SELECT');
  });

  it('records which columns were masked', async () => {
    await call('run_query', { sql: 'SELECT email FROM customers LIMIT 1' });
    const entry = audit.recent(1)[0];
    expect(entry.maskedColumns).toContain('email');
    expect(entry.actor).toBe('test');
  });

  it('is readable through the audit_tail tool', async () => {
    const output = text(await call('audit_tail', { limit: 5 }));
    expect(output).toContain('run_query');
  });
});
