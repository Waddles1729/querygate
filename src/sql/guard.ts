/**
 * Read-only enforcement and row capping.
 *
 * ## What this is, and what it is not
 *
 * This module rejects statements that are not plainly read-only, and clamps the
 * number of rows a query may return. It is a *guard rail*, not a security
 * boundary. The security boundary is the database role querygate connects as,
 * which should have no write privilege at all — see the README.
 *
 * Saying so plainly matters, because a SQL firewall that claims to be airtight
 * is how people end up running one as their only defence.
 */

import { SqlSyntaxError, tokenize, wordAt, type Token } from './tokenize.js';

export class QueryRejected extends Error {
  constructor(
    message: string,
    readonly reason: RejectionReason,
  ) {
    super(message);
    this.name = 'QueryRejected';
  }
}

export type RejectionReason =
  | 'empty'
  | 'syntax'
  | 'multiple-statements'
  | 'not-a-select'
  | 'forbidden-keyword'
  | 'forbidden-function'
  | 'table-not-allowed';

/**
 * Statement keywords that write, change structure, or change session state.
 * Matched as whole word tokens, so a column named `update_at` is fine.
 */
const FORBIDDEN_KEYWORDS = new Set([
  'insert', 'update', 'delete', 'merge', 'upsert', 'replace',
  'drop', 'create', 'alter', 'truncate', 'rename', 'comment',
  'grant', 'revoke', 'deny',
  'commit', 'rollback', 'savepoint', 'begin', 'start', 'end',
  'vacuum', 'analyze', 'reindex', 'cluster', 'checkpoint',
  'attach', 'detach', 'pragma', 'copy', 'load', 'install',
  'set', 'reset', 'discard', 'listen', 'notify', 'unlisten',
  'lock', 'prepare', 'execute', 'deallocate', 'call', 'do',
  'refresh', 'import', 'export', 'backup', 'restore',
]);

/**
 * Functions that read or write outside the query — the usual escape hatches
 * out of a read-only SQL session.
 */
const FORBIDDEN_FUNCTIONS = new Set([
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
  'pg_sleep', 'pg_terminate_backend', 'pg_cancel_backend',
  'pg_reload_conf', 'pg_rotate_logfile',
  'lo_import', 'lo_export', 'dblink', 'dblink_exec',
  'readfile', 'writefile', 'edit', 'load_extension',
  'system', 'shell', 'xp_cmdshell',
]);

/** Clauses after which a LIMIT cannot simply be appended. */
const TAIL_CLAUSES = new Set(['limit', 'offset', 'fetch']);

export interface GuardOptions {
  /** Hard ceiling on rows. A query asking for more is clamped down to it. */
  maxRows: number;
  /** Allow statements that only read but are not SELECT (e.g. EXPLAIN). */
  allowExplain?: boolean;
}

export interface GuardedQuery {
  /** The SQL to actually execute, with a LIMIT applied. */
  sql: string;
  /** Table-ish identifiers the statement refers to, lower-cased. */
  tables: string[];
  /** True when querygate added or lowered a LIMIT. */
  limitApplied: boolean;
  /** The effective row ceiling for this query. */
  limit: number;
}

/**
 * Validate `sql` as a read-only statement and return it with a row cap applied.
 *
 * @throws {QueryRejected} when the statement is not plainly read-only.
 */
export function guardQuery(sql: string, options: GuardOptions): GuardedQuery {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!trimmed) {
    throw new QueryRejected('the query is empty', 'empty');
  }

  let tokens: Token[];
  try {
    tokens = tokenize(trimmed);
  } catch (error) {
    if (error instanceof SqlSyntaxError) {
      throw new QueryRejected(
        `could not parse the query: ${error.message} at position ${error.position}`,
        'syntax',
      );
    }
    throw error;
  }

  if (tokens.length === 0) {
    throw new QueryRejected('the query contains no statement', 'empty');
  }

  // Stacked statements. A trailing `;` was already stripped, so any `;` left
  // at depth zero separates two statements.
  let depth = 0;
  for (const token of tokens) {
    if (token.type !== 'punct') continue;
    if (token.raw === '(') depth += 1;
    else if (token.raw === ')') depth -= 1;
    else if (token.raw === ';' && depth === 0) {
      throw new QueryRejected(
        'only one statement may be sent at a time',
        'multiple-statements',
      );
    }
  }

  const first = wordAt(tokens, 0);
  const isExplain = first === 'explain' && options.allowExplain === true;
  const body = isExplain ? tokens.slice(skipExplainPrefix(tokens)) : tokens;
  const head = wordAt(body, 0);

  if (head !== 'select' && head !== 'with' && head !== 'values' && head !== 'table') {
    throw new QueryRejected(
      `only SELECT statements are allowed; this one starts with ${
        (body[0]?.raw ?? '').toUpperCase() || 'nothing recognisable'
      }`,
      'not-a-select',
    );
  }

  // `WITH x AS (...) DELETE FROM ...` is legal Postgres and is emphatically
  // not read-only, so a WITH has to be checked all the way to its body.
  for (let i = 0; i < body.length; i += 1) {
    const word = wordAt(body, i);
    if (!word) continue;

    if (FORBIDDEN_KEYWORDS.has(word) && !isBenign(body, i)) {
      throw new QueryRejected(
        `${word.toUpperCase()} is not allowed; querygate serves read-only queries`,
        'forbidden-keyword',
      );
    }

    if (FORBIDDEN_FUNCTIONS.has(word) && body[i + 1]?.raw === '(') {
      throw new QueryRejected(
        `the function ${word}() is not allowed`,
        'forbidden-function',
      );
    }
  }

  const tables = collectTables(body);
  const { sql: limited, applied, limit } = applyLimit(trimmed, body, options.maxRows);

  return { sql: limited, tables, limitApplied: applied, limit };
}

/** How many tokens the EXPLAIN prefix occupies, including any (ANALYZE, ...). */
function skipExplainPrefix(tokens: Token[]): number {
  let i = 1;
  if (tokens[i]?.raw === '(') {
    let depth = 0;
    while (i < tokens.length) {
      if (tokens[i].raw === '(') depth += 1;
      if (tokens[i].raw === ')') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
      i += 1;
    }
  }
  // EXPLAIN QUERY PLAN (SQLite), EXPLAIN ANALYZE (Postgres)
  while (['query', 'plan', 'analyze', 'verbose'].includes(wordAt(tokens, i))) i += 1;
  return i;
}

/**
 * Some forbidden words are also ordinary SQL in a read-only context.
 *
 * `END` closes a CASE, `SET` appears in `GROUPING SETS`, and any of them can be
 * a column or alias name when written after a dot or AS. Blocking those would
 * make the guard useless on real schemas, so each exception is narrow and
 * positional rather than a blanket allowance.
 */
function isBenign(tokens: Token[], index: number): boolean {
  const word = wordAt(tokens, index);
  const previous = tokens[index - 1];
  const previousWord = wordAt(tokens, index - 1);
  const nextWord = wordAt(tokens, index + 1);

  // A qualified name: t.end, schema.set
  if (previous?.raw === '.') return true;
  // An alias: ... AS end
  if (previousWord === 'as') return true;

  switch (word) {
    // CASE ... END, and END inside it.
    case 'end':
      return true;
    // GROUPING SETS (...)
    case 'set':
      return previousWord === 'grouping';
    // `SELECT ... FROM t START WITH ...` hierarchical queries read only.
    case 'start':
      return nextWord === 'with';
    // ORDER BY x USING <, and `ANALYZE` as a column name handled by the dot rule.
    default:
      return false;
  }
}

/**
 * Collect the identifiers that follow FROM and JOIN.
 *
 * This drives the table allowlist. It is intentionally generous about what it
 * calls a table: a CTE name shows up here too, and the policy layer resolves
 * that (see `policy.ts`), because under-collecting would let a table slip past
 * the allowlist while over-collecting only costs a clearer error message.
 */
function collectTables(tokens: Token[]): string[] {
  const found = new Set<string>();

  for (let i = 0; i < tokens.length; i += 1) {
    const word = wordAt(tokens, i);
    if (word !== 'from' && word !== 'join') continue;

    // FROM (SELECT ...) — a subquery, whose own FROM is visited in turn.
    let j = i + 1;
    if (tokens[j]?.raw === '(') continue;

    const parts: string[] = [];
    while (j < tokens.length) {
      const token = tokens[j];
      if (token.type === 'word' || token.type === 'quoted-identifier') {
        parts.push(token.type === 'word' ? token.value : token.value.toLowerCase());
        j += 1;
        if (tokens[j]?.raw === '.') {
          parts.push('.');
          j += 1;
          continue;
        }
      }
      break;
    }

    if (parts.length > 0) {
      // Keep the last segment: db.schema.table -> table
      const name = parts.filter((p) => p !== '.').pop();
      if (name) found.add(name);
    }
  }

  return [...found];
}

/**
 * Append a LIMIT, or lower one that is already there.
 *
 * A caller asking for 10 rows should get 10, not `maxRows`; the cap only ever
 * reduces. When the statement already ends in a tail clause we wrap it instead
 * of appending, because `... LIMIT 100000 LIMIT 1000` is not valid SQL.
 */
function applyLimit(
  sql: string,
  tokens: Token[],
  maxRows: number,
): { sql: string; applied: boolean; limit: number } {
  const limitIndex = findTopLevelKeyword(tokens, 'limit');

  if (limitIndex === -1) {
    const hasTail = tokens.some(
      (t, i) => t.type === 'word' && TAIL_CLAUSES.has(t.value) && isTopLevel(tokens, i),
    );
    if (hasTail) {
      // OFFSET or FETCH without LIMIT: wrapping is the safe way to cap.
      return {
        sql: `SELECT * FROM (${sql}) AS querygate_capped LIMIT ${maxRows}`,
        applied: true,
        limit: maxRows,
      };
    }
    return { sql: `${sql} LIMIT ${maxRows}`, applied: true, limit: maxRows };
  }

  const valueToken = tokens[limitIndex + 1];
  if (!valueToken || valueToken.type !== 'number') {
    // LIMIT ? or LIMIT :n — the value is not knowable here, so wrap.
    return {
      sql: `SELECT * FROM (${sql}) AS querygate_capped LIMIT ${maxRows}`,
      applied: true,
      limit: maxRows,
    };
  }

  const requested = Number.parseInt(valueToken.raw, 10);
  if (Number.isFinite(requested) && requested <= maxRows) {
    return { sql, applied: false, limit: requested };
  }

  const rewritten =
    sql.slice(0, valueToken.start) + String(maxRows) + sql.slice(valueToken.end);
  return { sql: rewritten, applied: true, limit: maxRows };
}

function isTopLevel(tokens: Token[], index: number): boolean {
  let depth = 0;
  for (let i = 0; i < index; i += 1) {
    if (tokens[i].raw === '(') depth += 1;
    else if (tokens[i].raw === ')') depth -= 1;
  }
  return depth === 0;
}

function findTopLevelKeyword(tokens: Token[], keyword: string): number {
  for (let i = 0; i < tokens.length; i += 1) {
    if (wordAt(tokens, i) === keyword && isTopLevel(tokens, i)) return i;
  }
  return -1;
}
