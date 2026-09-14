/**
 * Configuration.
 *
 * One JSON file, plus environment overrides for the values that differ between
 * environments (credentials, mostly). Defaults are deliberately conservative:
 * an operator who writes no config at all gets a tight row cap and a short
 * timeout rather than an open connection.
 */

import { readFileSync } from 'node:fs';

import type { PolicyConfig } from './policy.js';

export interface Config {
  database: { kind: 'sqlite'; file: string } | { kind: 'postgres'; url: string; schema?: string };
  maxRows: number;
  timeoutMs: number;
  auditLog?: string;
  policy: PolicyConfig;
  http?: { port: number; host: string };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULTS = { maxRows: 1000, timeoutMs: 10_000 };

export function loadConfig(path?: string): Config {
  const raw: Record<string, unknown> = path ? readJson(path) : {};

  const database = resolveDatabase(raw.database);
  const policy = (raw.policy ?? {}) as PolicyConfig;

  const maxRows = intFrom(process.env.QUERYGATE_MAX_ROWS, raw.maxRows, DEFAULTS.maxRows);
  const timeoutMs = intFrom(process.env.QUERYGATE_TIMEOUT_MS, raw.timeoutMs, DEFAULTS.timeoutMs);

  if (maxRows < 1) throw new ConfigError('maxRows must be at least 1');
  if (timeoutMs < 1) throw new ConfigError('timeoutMs must be at least 1');

  const http = raw.http as { port?: number; host?: string } | undefined;

  return {
    database,
    maxRows,
    timeoutMs,
    auditLog: process.env.QUERYGATE_AUDIT_LOG ?? (raw.auditLog as string | undefined),
    policy,
    http: {
      port: intFrom(process.env.PORT, http?.port, 8765),
      host: process.env.HOST ?? http?.host ?? '127.0.0.1',
    },
  };
}

function readJson(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`could not read the config file at ${path}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function resolveDatabase(value: unknown): Config['database'] {
  // Environment wins, so the same config file works in dev and production with
  // the connection string supplied by the platform.
  const url = process.env.DATABASE_URL;
  if (url) {
    return url.startsWith('postgres')
      ? { kind: 'postgres', url, schema: process.env.PGSCHEMA ?? 'public' }
      : { kind: 'sqlite', file: url.replace(/^sqlite:\/*/, '') };
  }

  const file = process.env.QUERYGATE_SQLITE;
  if (file) return { kind: 'sqlite', file };

  if (!value || typeof value !== 'object') {
    throw new ConfigError(
      'no database configured: set DATABASE_URL, or add a "database" block to the config file',
    );
  }

  const block = value as Record<string, unknown>;
  if (block.kind === 'sqlite' && typeof block.file === 'string') {
    return { kind: 'sqlite', file: block.file };
  }
  if (block.kind === 'postgres' && typeof block.url === 'string') {
    return {
      kind: 'postgres',
      url: block.url,
      schema: typeof block.schema === 'string' ? block.schema : 'public',
    };
  }
  throw new ConfigError(
    'the "database" block must be {"kind":"sqlite","file":...} or {"kind":"postgres","url":...}',
  );
}

function intFrom(env: string | undefined, configured: unknown, fallback: number): number {
  if (env !== undefined && env !== '') {
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof configured === 'number' && Number.isFinite(configured)) return configured;
  return fallback;
}
