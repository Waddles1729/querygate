import { describe, expect, it } from 'vitest';

import { QueryRejected, guardQuery } from '../src/sql/guard.js';
import { tokenize } from '../src/sql/tokenize.js';

const guard = (sql: string, maxRows = 100) => guardQuery(sql, { maxRows });

/** Assert that `sql` is refused, and (optionally) refused for the stated reason. */
const rejects = (sql: string, reason?: string) => {
  let thrown: unknown;
  try {
    guard(sql);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected ${sql} to be rejected`).toBeInstanceOf(QueryRejected);
  if (reason) expect((thrown as QueryRejected).reason).toBe(reason);
};

describe('tokenizer', () => {
  it('keeps string contents out of the keyword stream', () => {
    const tokens = tokenize("SELECT 'drop table users' AS note");
    expect(tokens.map((t) => t.type)).toEqual(['word', 'string', 'word', 'word']);
    expect(tokens[1].value).toBe('drop table users');
  });

  it('handles doubled quotes inside a literal', () => {
    const tokens = tokenize("SELECT 'it''s fine'");
    expect(tokens[1].value).toBe("it's fine");
  });

  it('strips line and nested block comments', () => {
    const tokens = tokenize('SELECT 1 -- drop table t\n/* a /* nested */ comment */ , 2');
    expect(tokens.map((t) => t.raw)).toEqual(['SELECT', '1', ',', '2']);
  });

  it('rejects an unterminated literal rather than swallowing the rest', () => {
    expect(() => tokenize("SELECT 'oops")).toThrow(/unterminated string/);
    expect(() => tokenize('SELECT "oops')).toThrow(/unterminated quoted identifier/);
    expect(() => tokenize('SELECT 1 /* oops')).toThrow(/unterminated block comment/);
  });

  it('reads bind parameters as single tokens', () => {
    expect(tokenize('SELECT $1, :name, ?, @x').filter((t) => t.type === 'parameter')).toHaveLength(4);
  });
});

describe('read-only enforcement', () => {
  it('allows a plain SELECT', () => {
    expect(guard('SELECT 1').sql).toBe('SELECT 1 LIMIT 100');
  });

  it('allows WITH ... SELECT', () => {
    const result = guard('WITH recent AS (SELECT * FROM orders) SELECT * FROM recent');
    expect(result.tables).toContain('orders');
    expect(result.tables).toContain('recent');
  });

  it.each([
    ['INSERT INTO users VALUES (1)', 'not-a-select'],
    ['UPDATE users SET name = 1', 'not-a-select'],
    ['DELETE FROM users', 'not-a-select'],
    ['DROP TABLE users', 'not-a-select'],
    ['TRUNCATE users', 'not-a-select'],
    ['PRAGMA table_info(users)', 'not-a-select'],
    ['ATTACH DATABASE \'/etc/passwd\' AS p', 'not-a-select'],
    ['COPY users TO \'/tmp/out\'', 'not-a-select'],
  ])('refuses %s', (sql, reason) => {
    rejects(sql, reason);
  });

  it('refuses a write hidden behind a CTE', () => {
    // Valid Postgres, and emphatically not read-only.
    rejects(
      'WITH gone AS (DELETE FROM users RETURNING *) SELECT * FROM gone',
      'forbidden-keyword',
    );
  });

  it('refuses stacked statements', () => {
    rejects('SELECT 1; DROP TABLE users', 'multiple-statements');
  });

  it('allows a single trailing semicolon', () => {
    expect(() => guard('SELECT 1;')).not.toThrow();
  });

  it('is not fooled by a keyword inside a string', () => {
    expect(() => guard("SELECT 'drop table users' AS note")).not.toThrow();
  });

  it('does not reassemble a keyword split by a comment', () => {
    // A scanner that strips comments before tokenising turns this into DROP.
    // Tokenising first leaves `DR` and `OP` as separate words, so the statement
    // simply is not a SELECT — refused either way, but for the honest reason.
    rejects('DR/**/OP TABLE users', 'not-a-select');
  });

  it('refuses a write appended after a comment', () => {
    rejects('SELECT 1 -- fine\n; DROP TABLE users', 'multiple-statements');
  });

  it('refuses file-reading functions', () => {
    rejects("SELECT pg_read_file('/etc/passwd')", 'forbidden-function');
    rejects("SELECT lo_import('/etc/passwd')", 'forbidden-function');
  });

  it('allows a column named like a keyword when qualified or aliased', () => {
    expect(() => guard('SELECT t.end FROM spans t')).not.toThrow();
    expect(() => guard('SELECT finished AS end FROM spans')).not.toThrow();
  });

  it('allows CASE ... END', () => {
    expect(() =>
      guard('SELECT CASE WHEN x > 1 THEN 1 ELSE 0 END AS flag FROM t'),
    ).not.toThrow();
  });

  it('refuses an empty query', () => {
    rejects('', 'empty');
    rejects('   -- just a comment', 'empty');
  });

  it('reports unparsable SQL as a syntax rejection', () => {
    rejects("SELECT 'unterminated", 'syntax');
  });
});

describe('row capping', () => {
  it('appends a LIMIT when there is none', () => {
    expect(guard('SELECT * FROM orders', 50).sql).toBe('SELECT * FROM orders LIMIT 50');
  });

  it('leaves a smaller LIMIT alone', () => {
    const result = guard('SELECT * FROM orders LIMIT 10', 50);
    expect(result.sql).toBe('SELECT * FROM orders LIMIT 10');
    expect(result.limitApplied).toBe(false);
    expect(result.limit).toBe(10);
  });

  it('lowers a LIMIT that exceeds the cap', () => {
    const result = guard('SELECT * FROM orders LIMIT 100000', 50);
    expect(result.sql).toBe('SELECT * FROM orders LIMIT 50');
    expect(result.limitApplied).toBe(true);
  });

  it('ignores a LIMIT inside a subquery when capping the outer query', () => {
    const result = guard('SELECT * FROM (SELECT * FROM t LIMIT 5) x', 50);
    expect(result.sql).toBe('SELECT * FROM (SELECT * FROM t LIMIT 5) x LIMIT 50');
  });

  it('wraps rather than appending when the query ends in OFFSET', () => {
    const result = guard('SELECT * FROM orders OFFSET 20', 50);
    expect(result.sql).toContain('querygate_capped');
    expect(result.sql.endsWith('LIMIT 50')).toBe(true);
  });

  it('wraps when the LIMIT is a bind parameter', () => {
    const result = guard('SELECT * FROM orders LIMIT ?', 50);
    expect(result.sql).toContain('querygate_capped');
  });
});

describe('table collection', () => {
  it('finds tables behind FROM and JOIN', () => {
    const result = guard(
      'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id',
    );
    expect(result.tables.sort()).toEqual(['customers', 'orders']);
  });

  it('strips the schema qualifier', () => {
    expect(guard('SELECT * FROM public.orders').tables).toEqual(['orders']);
  });

  it('reads quoted identifiers', () => {
    expect(guard('SELECT * FROM "Orders"').tables).toEqual(['orders']);
  });

  it('sees into a subquery', () => {
    expect(guard('SELECT * FROM (SELECT * FROM secrets) s').tables).toEqual(['secrets']);
  });
});
