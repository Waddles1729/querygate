#!/usr/bin/env node
/**
 * Entry point. Two transports:
 *
 *   querygate stdio           for Claude Desktop, Claude Code, Codex
 *   querygate http            for a shared server several agents connect to
 *
 * stdio is the default because that is how an MCP server is usually run, and
 * because it needs no network exposure at all.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { PostgresAdapter } from './adapters/postgres.js';
import { SqliteAdapter } from './adapters/sqlite.js';
import type { Adapter } from './adapters/types.js';
import { createAuditSink } from './audit.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { Policy } from './policy.js';
import { createServer } from './server.js';
import { startHttpServer } from './http.js';

export async function openAdapter(config: Config): Promise<Adapter> {
  if (config.database.kind === 'sqlite') {
    return new SqliteAdapter(config.database.file, { readonly: true });
  }
  return PostgresAdapter.connect(config.database.url, config.database.schema);
}

async function main(argv: string[]): Promise<number> {
  const mode = argv[0] ?? 'stdio';
  if (mode === '--help' || mode === '-h' || mode === 'help') {
    printHelp();
    return 0;
  }

  const configFlag = argv.indexOf('--config');
  const configPath = configFlag === -1 ? process.env.QUERYGATE_CONFIG : argv[configFlag + 1];

  let config: Config;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`querygate: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const adapter = await openAdapter(config);
  const policy = new Policy(config.policy);
  const audit = createAuditSink(config.auditLog);

  const shutdown = async () => {
    await adapter.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (mode === 'http') {
    const { port, host } = config.http ?? { port: 8765, host: '127.0.0.1' };
    await startHttpServer({ adapter, policy, audit, config, port, host });
    // Log to stderr: stdout belongs to the protocol in the other mode, and
    // keeping the habit avoids a nasty surprise when someone switches.
    process.stderr.write(
      `querygate listening on http://${host}:${port}/mcp (${adapter.kind}, ` +
        `max ${config.maxRows} rows, ${config.timeoutMs}ms timeout)\n`,
    );
    return -1; // keep running
  }

  if (mode !== 'stdio') {
    process.stderr.write(`querygate: unknown mode ${mode}\n`);
    printHelp();
    return 2;
  }

  const server = createServer({
    adapter,
    policy,
    audit,
    maxRows: config.maxRows,
    timeoutMs: config.timeoutMs,
    actor: process.env.QUERYGATE_ACTOR ?? 'stdio',
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `querygate ready on stdio (${adapter.kind}, max ${config.maxRows} rows)\n`,
  );
  return -1; // keep running
}

function printHelp(): void {
  process.stdout.write(
    `querygate — a read-only SQL MCP server with guard rails

  querygate stdio [--config <file>]   run over stdio (default)
  querygate http  [--config <file>]   run an HTTP server

Environment:
  DATABASE_URL          postgres://... or sqlite:///path/to.db
  QUERYGATE_SQLITE      path to a SQLite file
  QUERYGATE_CONFIG      path to a config file
  QUERYGATE_MAX_ROWS    row cap (default 1000)
  QUERYGATE_TIMEOUT_MS  query timeout (default 10000)
  QUERYGATE_AUDIT_LOG   path to a JSONL audit log
`,
  );
}

// Only run when invoked directly, so the module stays importable from tests.
const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('index.ts'));

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code >= 0) process.exit(code);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `querygate: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}

export { main };
