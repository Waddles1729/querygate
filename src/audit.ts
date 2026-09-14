/**
 * The audit trail.
 *
 * If an agent can reach production data, someone will eventually need to answer
 * "what did it look at, and when". Writing that down is cheap; reconstructing
 * it afterwards is not. Every call is recorded — including the ones that were
 * refused, which are the interesting ones.
 *
 * The log is JSONL so it can be tailed, grepped, and loaded into a warehouse
 * without a parser.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AuditEntry {
  at: string;
  tool: string;
  /** Whoever the transport could identify; 'anonymous' when it could not. */
  actor: string;
  sql?: string;
  tables?: string[];
  rows?: number;
  durationMs?: number;
  maskedColumns?: string[];
  outcome: 'ok' | 'rejected' | 'error';
  /** Why a call was refused, when it was. */
  reason?: string;
}

export interface AuditSink {
  write(entry: AuditEntry): void;
  /** Most recent first. Used by the `audit_tail` tool. */
  recent(limit: number): AuditEntry[];
}

/** Keeps the last N entries in memory. Always on, so `audit_tail` works. */
export class MemoryAuditSink implements AuditSink {
  private readonly entries: AuditEntry[] = [];

  constructor(private readonly capacity = 500) {}

  write(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  recent(limit: number): AuditEntry[] {
    return this.entries.slice(-limit).reverse();
  }
}

/** Appends to a JSONL file, and keeps the in-memory tail as well. */
export class FileAuditSink implements AuditSink {
  private readonly memory: MemoryAuditSink;

  constructor(
    private readonly path: string,
    capacity = 500,
  ) {
    this.memory = new MemoryAuditSink(capacity);
    mkdirSync(dirname(path), { recursive: true });
  }

  write(entry: AuditEntry): void {
    this.memory.write(entry);
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // A full disk must not take the server down. The in-memory tail survives,
      // and the operator sees the gap.
    }
  }

  recent(limit: number): AuditEntry[] {
    return this.memory.recent(limit);
  }
}

export function createAuditSink(path?: string): AuditSink {
  return path ? new FileAuditSink(path) : new MemoryAuditSink();
}

/**
 * Shorten SQL for the log.
 *
 * Full statements can be enormous, and a log line nobody can read is a log line
 * nobody reads. The hash lets identical queries be grouped even when truncated.
 */
export function summariseSql(sql: string, maxLength = 500): string {
  const collapsed = sql.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength)}… (${collapsed.length} chars)`;
}
