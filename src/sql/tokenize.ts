/**
 * A small SQL tokenizer.
 *
 * Everything in this project that inspects SQL does it over tokens, never over
 * raw text. The difference matters: `SELECT 'we should drop table users'` is a
 * harmless query, and a regex looking for `drop table` blocks it. Worse, the
 * mirror-image mistake lets a real statement through when it is spelled with a
 * comment in the middle — `DROP/**\/TABLE users`.
 *
 * The tokenizer is deliberately dialect-agnostic about *meaning*; it only needs
 * to know where strings, comments and identifiers begin and end.
 */

export type TokenType =
  | 'word'
  | 'number'
  | 'string'
  | 'quoted-identifier'
  | 'punct'
  | 'parameter';

export interface Token {
  type: TokenType;
  /** The token as written. */
  raw: string;
  /** For words: lower-cased. For strings/identifiers: the unquoted contents. */
  value: string;
  start: number;
  end: number;
}

export class SqlSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = 'SqlSyntaxError';
  }
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

function isWordStart(ch: string): boolean {
  return /[A-Za-z_-￿]/.test(ch);
}

function isWordPart(ch: string): boolean {
  return /[A-Za-z0-9_$-￿]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/**
 * Split `sql` into tokens.
 *
 * Unterminated strings, identifiers and block comments are errors rather than
 * being silently consumed to end-of-input — an unterminated quote is the
 * classic way to smuggle text past a naive scanner.
 */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const push = (type: TokenType, start: number, end: number, value?: string) => {
    const raw = sql.slice(start, end);
    tokens.push({ type, raw, value: value ?? raw, start, end });
  };

  while (i < sql.length) {
    const ch = sql[i];

    if (WHITESPACE.has(ch)) {
      i += 1;
      continue;
    }

    // -- line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const newline = sql.indexOf('\n', i);
      i = newline === -1 ? sql.length : newline + 1;
      continue;
    }

    // /* block comment */ — nested, as Postgres allows.
    if (ch === '/' && sql[i + 1] === '*') {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      if (depth > 0) {
        throw new SqlSyntaxError('unterminated block comment', start);
      }
      continue;
    }

    // 'string literal', with '' as the escape for a quote.
    if (ch === "'") {
      const start = i;
      let value = '';
      i += 1;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        value += sql[i];
        i += 1;
      }
      if (!closed) throw new SqlSyntaxError('unterminated string literal', start);
      push('string', start, i, value);
      continue;
    }

    // "quoted identifier" / `backtick` / [bracket]
    if (ch === '"' || ch === '`' || ch === '[') {
      const start = i;
      const close = ch === '[' ? ']' : ch;
      let value = '';
      i += 1;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === close) {
          if (sql[i + 1] === close && close !== ']') {
            value += close;
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        value += sql[i];
        i += 1;
      }
      if (!closed) throw new SqlSyntaxError('unterminated quoted identifier', start);
      push('quoted-identifier', start, i, value);
      continue;
    }

    // Bind parameters: $1, :name, ?, @name
    if (ch === '$' && isDigit(sql[i + 1] ?? '')) {
      const start = i;
      i += 1;
      while (i < sql.length && isDigit(sql[i])) i += 1;
      push('parameter', start, i);
      continue;
    }
    if ((ch === ':' || ch === '@') && isWordStart(sql[i + 1] ?? '')) {
      const start = i;
      i += 1;
      while (i < sql.length && isWordPart(sql[i])) i += 1;
      push('parameter', start, i);
      continue;
    }
    if (ch === '?') {
      push('parameter', i, i + 1);
      i += 1;
      continue;
    }

    if (isDigit(ch) || (ch === '.' && isDigit(sql[i + 1] ?? ''))) {
      const start = i;
      while (i < sql.length && /[0-9.eE]/.test(sql[i])) {
        // Exponent sign, as in 1e-9.
        if ((sql[i] === 'e' || sql[i] === 'E') && /[+-]/.test(sql[i + 1] ?? '')) i += 1;
        i += 1;
      }
      push('number', start, i);
      continue;
    }

    if (isWordStart(ch)) {
      const start = i;
      while (i < sql.length && isWordPart(sql[i])) i += 1;
      push('word', start, i, sql.slice(start, i).toLowerCase());
      continue;
    }

    push('punct', i, i + 1);
    i += 1;
  }

  return tokens;
}

/** The lower-cased keyword at `index`, or '' if that token is not a word. */
export function wordAt(tokens: Token[], index: number): string {
  const token = tokens[index];
  return token && token.type === 'word' ? token.value : '';
}
