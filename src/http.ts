/**
 * HTTP transport, on Fastify.
 *
 * Each MCP session gets its own server instance and its own transport, keyed by
 * the session id the SDK issues. That matters here beyond bookkeeping: the
 * audit log records an actor per session, so two agents sharing one process are
 * still distinguishable in the log.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { Adapter } from './adapters/types.js';
import type { AuditSink } from './audit.js';
import type { Config } from './config.js';
import type { Policy } from './policy.js';
import { createServer } from './server.js';

export interface HttpOptions {
  adapter: Adapter;
  policy: Policy;
  audit: AuditSink;
  config: Config;
  port: number;
  host: string;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

const SESSION_IDLE_MS = 30 * 60 * 1000;

export async function startHttpServer(options: HttpOptions): Promise<FastifyInstance> {
  const { adapter, policy, audit, config } = options;

  const app = Fastify({
    logger: false,
    // The SDK transport reads the raw request, so Fastify must not consume the
    // body first.
    bodyLimit: 4 * 1024 * 1024,
  });

  const sessions = new Map<string, Session>();

  // Idle sessions would otherwise accumulate for the life of the process.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        void session.transport.close().catch(() => undefined);
        sessions.delete(id);
      }
    }
  }, 60_000);
  sweeper.unref();

  app.addHook('onClose', async () => {
    clearInterval(sweeper);
    for (const session of sessions.values()) {
      await session.transport.close().catch(() => undefined);
    }
    await adapter.close().catch(() => undefined);
  });

  app.get('/health', async () => ({
    status: 'ok',
    database: adapter.kind,
    maxRows: config.maxRows,
    timeoutMs: config.timeoutMs,
    sessions: sessions.size,
  }));

  app.all('/mcp', async (request, reply) => {
    const sessionId = request.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

    if (existing) {
      existing.lastSeen = Date.now();
      await existing.transport.handleRequest(request.raw, reply.raw, request.body);
      reply.hijack();
      return;
    }

    if (typeof sessionId === 'string') {
      reply.code(404).send({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'unknown or expired session' },
        id: null,
      });
      return;
    }

    // A new session. The actor comes from a header if the deployment sets one
    // (behind an authenticating proxy, say); otherwise it is anonymous and the
    // audit log says so honestly rather than inventing an identity.
    const actor =
      firstHeader(request.headers['x-querygate-actor']) ??
      firstHeader(request.headers['x-forwarded-user']) ??
      'anonymous';

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, { transport, lastSeen: Date.now() });
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    const server = createServer({
      adapter,
      policy,
      audit,
      maxRows: config.maxRows,
      timeoutMs: config.timeoutMs,
      actor,
    });

    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
    reply.hijack();
  });

  await app.listen({ port: options.port, host: options.host });
  return app;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
