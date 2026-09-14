/**
 * What an agent is allowed to see.
 *
 * Two independent controls:
 *
 *  - **Table visibility.** A denylist always wins over an allowlist. Anything
 *    not visible is also hidden from schema introspection, so the agent never
 *    learns that `salaries` exists and then explains to the user that it was
 *    denied access to it.
 *  - **Column masking.** Some columns are fine to aggregate over but not to
 *    read row by row. Masking happens on the way out, after the database has
 *    done its work, so `COUNT(DISTINCT email)` still returns the true count
 *    while the email addresses themselves never leave the process intact.
 */

import { createHash } from 'node:crypto';

export type MaskStrategy = 'redact' | 'hash' | 'partial' | 'domain';

export interface ColumnRule {
  /** Table name, or '*' for every table. */
  table: string;
  /** Column name, matched case-insensitively. */
  column: string;
  strategy: MaskStrategy;
}

export interface PolicyConfig {
  /** If set, only these tables are visible. Supports a trailing '*'. */
  allowTables?: string[];
  /** Always hidden, even if an allow pattern matches. */
  denyTables?: string[];
  mask?: ColumnRule[];
  /** Salt for the `hash` strategy. Changing it changes every hashed value. */
  hashSalt?: string;
}

export class PolicyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyViolation';
  }
}

export class Policy {
  private readonly allow: string[];
  private readonly deny: string[];
  private readonly rules: ColumnRule[];
  private readonly salt: string;

  constructor(config: PolicyConfig = {}) {
    this.allow = (config.allowTables ?? []).map((p) => p.toLowerCase());
    this.deny = (config.denyTables ?? []).map((p) => p.toLowerCase());
    this.rules = (config.mask ?? []).map((r) => ({
      table: r.table.toLowerCase(),
      column: r.column.toLowerCase(),
      strategy: r.strategy,
    }));
    this.salt = config.hashSalt ?? '';
  }

  /** Whether `table` may be queried or listed at all. */
  isVisible(table: string): boolean {
    const name = stripQualifier(table).toLowerCase();
    if (this.deny.some((pattern) => matches(name, pattern))) return false;
    if (this.allow.length === 0) return true;
    return this.allow.some((pattern) => matches(name, pattern));
  }

  /**
   * Throw unless every table the query touches is visible.
   *
   * Names that are not visible tables may still be CTEs defined in the same
   * statement, so those are passed in and excluded — otherwise `WITH recent AS
   * (...) SELECT * FROM recent` would be rejected for querying "recent".
   */
  assertTablesAllowed(tables: string[], knownCtes: Iterable<string> = []): void {
    const ctes = new Set([...knownCtes].map((c) => c.toLowerCase()));
    const blocked = tables
      .map((t) => stripQualifier(t).toLowerCase())
      .filter((t) => !ctes.has(t) && !this.isVisible(t));

    if (blocked.length > 0) {
      const unique = [...new Set(blocked)];
      throw new PolicyViolation(
        `not permitted to read: ${unique.join(', ')}`,
      );
    }
  }

  /** The masking strategy for a column, or null when it may be returned as-is. */
  strategyFor(table: string, column: string): MaskStrategy | null {
    const t = stripQualifier(table).toLowerCase();
    const c = column.toLowerCase();
    // A table-specific rule beats a wildcard one.
    const specific = this.rules.find((r) => r.table === t && r.column === c);
    if (specific) return specific.strategy;
    const wildcard = this.rules.find((r) => r.table === '*' && r.column === c);
    return wildcard ? wildcard.strategy : null;
  }

  /** Apply masking to one value. */
  maskValue(value: unknown, strategy: MaskStrategy): unknown {
    if (value === null || value === undefined) return value;
    const text = String(value);

    switch (strategy) {
      case 'redact':
        return '[redacted]';

      case 'hash':
        // Stable across rows and runs, so an agent can still join and group on
        // the column without ever seeing the value.
        return createHash('sha256')
          .update(this.salt + text)
          .digest('hex')
          .slice(0, 16);

      case 'partial': {
        if (text.length <= 4) return '*'.repeat(text.length);
        return '*'.repeat(text.length - 4) + text.slice(-4);
      }

      case 'domain': {
        const at = text.lastIndexOf('@');
        return at === -1 ? '[redacted]' : `[redacted]${text.slice(at)}`;
      }

      default:
        return '[redacted]';
    }
  }

  /**
   * Mask a result set.
   *
   * `sourceTables` is what the query read. When a query joins two tables we
   * apply the union of their rules: a column called `email` is masked if any
   * table in the query masks `email`. Erring toward masking is the right
   * default when column provenance is ambiguous.
   */
  maskRows<T extends Record<string, unknown>>(
    rows: T[],
    sourceTables: string[],
  ): { rows: Record<string, unknown>[]; maskedColumns: string[] } {
    if (rows.length === 0) return { rows: [], maskedColumns: [] };

    const columns = Object.keys(rows[0]);
    const plan = new Map<string, MaskStrategy>();

    for (const column of columns) {
      for (const table of sourceTables.length > 0 ? sourceTables : ['*']) {
        const strategy = this.strategyFor(table, column);
        if (strategy) {
          plan.set(column, strategy);
          break;
        }
      }
      if (!plan.has(column)) {
        const wildcard = this.strategyFor('*', column);
        if (wildcard) plan.set(column, wildcard);
      }
    }

    if (plan.size === 0) return { rows, maskedColumns: [] };

    const masked = rows.map((row) => {
      const copy: Record<string, unknown> = { ...row };
      for (const [column, strategy] of plan) {
        copy[column] = this.maskValue(row[column], strategy);
      }
      return copy;
    });

    return { rows: masked, maskedColumns: [...plan.keys()] };
  }
}

/** `public.users` -> `users` */
function stripQualifier(name: string): string {
  const parts = name.split('.');
  return parts[parts.length - 1].replace(/^["`[]|["`\]]$/g, '');
}

/** Glob matching limited to a trailing '*', which is all a table pattern needs. */
function matches(name: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/** CTE names defined by a `WITH` clause, so they are not mistaken for tables. */
export function collectCteNames(sql: string): string[] {
  const names: string[] = [];
  const pattern = /(?:\bwith\b|,)\s*(?:recursive\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+as\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    names.push(match[1].toLowerCase());
  }
  return names;
}
