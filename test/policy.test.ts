import { describe, expect, it } from 'vitest';

import { Policy, PolicyViolation, collectCteNames } from '../src/policy.js';

describe('table visibility', () => {
  it('allows everything when no lists are configured', () => {
    const policy = new Policy();
    expect(policy.isVisible('anything')).toBe(true);
  });

  it('restricts to the allowlist when one is set', () => {
    const policy = new Policy({ allowTables: ['orders', 'customers'] });
    expect(policy.isVisible('orders')).toBe(true);
    expect(policy.isVisible('employee_salaries')).toBe(false);
  });

  it('supports a trailing wildcard', () => {
    const policy = new Policy({ allowTables: ['analytics_*'] });
    expect(policy.isVisible('analytics_daily')).toBe(true);
    expect(policy.isVisible('raw_events')).toBe(false);
  });

  it('lets the denylist override the allowlist', () => {
    const policy = new Policy({ allowTables: ['*'], denyTables: ['employee_salaries'] });
    expect(policy.isVisible('orders')).toBe(true);
    expect(policy.isVisible('employee_salaries')).toBe(false);
  });

  it('ignores the schema qualifier and case', () => {
    const policy = new Policy({ denyTables: ['secrets'] });
    expect(policy.isVisible('public.SECRETS')).toBe(false);
  });

  it('refuses a query that touches a hidden table', () => {
    const policy = new Policy({ denyTables: ['employee_salaries'] });
    expect(() => policy.assertTablesAllowed(['orders', 'employee_salaries'])).toThrow(
      PolicyViolation,
    );
    expect(() => policy.assertTablesAllowed(['orders'])).not.toThrow();
  });

  it('does not mistake a CTE for a hidden table', () => {
    const policy = new Policy({ allowTables: ['orders'] });
    // `recent` is defined in the query, not in the database.
    expect(() => policy.assertTablesAllowed(['orders', 'recent'], ['recent'])).not.toThrow();
    expect(() => policy.assertTablesAllowed(['orders', 'recent'], [])).toThrow(PolicyViolation);
  });
});

describe('CTE detection', () => {
  it('finds a single CTE', () => {
    expect(collectCteNames('WITH recent AS (SELECT 1) SELECT * FROM recent')).toEqual(['recent']);
  });

  it('finds several, including RECURSIVE', () => {
    const sql = 'WITH RECURSIVE tree AS (SELECT 1), leaves AS (SELECT 2) SELECT * FROM tree';
    expect(collectCteNames(sql).sort()).toEqual(['leaves', 'tree']);
  });

  it('returns nothing for a query without a WITH', () => {
    expect(collectCteNames('SELECT * FROM orders')).toEqual([]);
  });
});

describe('masking', () => {
  const policy = new Policy({
    hashSalt: 'test-salt',
    mask: [
      { table: 'customers', column: 'email', strategy: 'domain' },
      { table: 'customers', column: 'phone', strategy: 'partial' },
      { table: 'customers', column: 'ssn', strategy: 'hash' },
      { table: '*', column: 'password_hash', strategy: 'redact' },
    ],
  });

  it('redacts', () => {
    expect(policy.maskValue('hunter2', 'redact')).toBe('[redacted]');
  });

  it('keeps only the domain of an address', () => {
    expect(policy.maskValue('aoi.sato@example.com', 'domain')).toBe('[redacted]@example.com');
    expect(policy.maskValue('not-an-address', 'domain')).toBe('[redacted]');
  });

  it('keeps the last four characters for partial', () => {
    expect(policy.maskValue('080-1234-5678', 'partial')).toBe('*********5678');
    expect(policy.maskValue('abc', 'partial')).toBe('***');
  });

  it('hashes stably, so grouping still works', () => {
    const a = policy.maskValue('aoi@example.com', 'hash');
    const b = policy.maskValue('aoi@example.com', 'hash');
    const c = policy.maskValue('ren@example.com', 'hash');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(String(a)).toHaveLength(16);
  });

  it('salts the hash, so it differs between deployments', () => {
    const other = new Policy({ hashSalt: 'different', mask: [] });
    expect(policy.maskValue('x', 'hash')).not.toBe(other.maskValue('x', 'hash'));
  });

  it('leaves null alone', () => {
    expect(policy.maskValue(null, 'redact')).toBeNull();
    expect(policy.maskValue(undefined, 'hash')).toBeUndefined();
  });

  it('prefers a table-specific rule over a wildcard', () => {
    const p = new Policy({
      mask: [
        { table: '*', column: 'email', strategy: 'redact' },
        { table: 'customers', column: 'email', strategy: 'domain' },
      ],
    });
    expect(p.strategyFor('customers', 'email')).toBe('domain');
    expect(p.strategyFor('vendors', 'email')).toBe('redact');
  });

  it('masks a result set and reports which columns it touched', () => {
    const { rows, maskedColumns } = policy.maskRows(
      [
        { id: 1, name: 'Aoi Sato', email: 'aoi@example.com', phone: '080-1111-2222' },
        { id: 2, name: 'Ren Ito', email: 'ren@example.com', phone: '080-3333-4444' },
      ],
      ['customers'],
    );

    expect(maskedColumns.sort()).toEqual(['email', 'phone']);
    expect(rows[0].email).toBe('[redacted]@example.com');
    expect(rows[0].phone).toBe('*********2222');
    // Untouched columns come through unchanged.
    expect(rows[0].name).toBe('Aoi Sato');
    expect(rows[1].id).toBe(2);
  });

  it('applies a wildcard rule regardless of which table was queried', () => {
    const { maskedColumns } = policy.maskRows(
      [{ password_hash: 'abc' }],
      ['some_other_table'],
    );
    expect(maskedColumns).toEqual(['password_hash']);
  });

  it('returns the rows untouched when nothing matches', () => {
    const rows = [{ id: 1, total: 100 }];
    const result = policy.maskRows(rows, ['orders']);
    expect(result.rows).toBe(rows);
    expect(result.maskedColumns).toEqual([]);
  });

  it('handles an empty result set', () => {
    expect(policy.maskRows([], ['customers'])).toEqual({ rows: [], maskedColumns: [] });
  });
});
