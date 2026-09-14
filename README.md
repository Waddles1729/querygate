# querygate

**A read-only SQL MCP server with guard rails.** Give an agent access to a
database without giving it the keys: read-only enforcement, table visibility
rules, column masking on the way out, row and time caps, and an audit trail of
everything it asked for — including what was refused.

[![CI](https://github.com/Waddles1729/querygate/actions/workflows/ci.yml/badge.svg)](https://github.com/Waddles1729/querygate/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Why

Connecting an agent to your warehouse is a two-line change, and that is the
problem. The usual result is a connection with the same privileges the analyst
had, no record of what was read, and an `email` column that is now flowing
through a model's context window on every question about signups.

querygate sits between the two and makes each of those a configuration
decision instead of an accident.

## Try it — no database, no credentials

```bash
git clone https://github.com/Waddles1729/querygate
cd querygate
npm install
npm run demo:http     # seeds a small SQLite shop database and serves it
```

Then, as an agent would:

```
> list_tables

4 table(s):
customers  ~400 rows
order_items  ~4,955 rows
orders  ~2,500 rows
products  ~8 rows
```

`employee_salaries` exists in that database. It is denied by policy, so it is
not listed — the agent never learns it is there to ask about.

```
> run_query  SELECT name, email, phone, city FROM customers LIMIT 3

name             email                   phone          city
---------------  ----------------------  -------------  ------
Mei Tanaka       [redacted]@example.com  *********1667  Sendai
Sota Sato        [redacted]@example.com  *********6121  Tokyo
Haruto Nakamura  [redacted]@example.com  *********7922  Tokyo

3 row(s) · 1ms · masked by policy: email, phone
```

Masking happens on egress, after the database has done its work — so analysis
over those columns still gives true answers:

```
> run_query  SELECT COUNT(DISTINCT email) AS distinct_customers FROM customers

distinct_customers
------------------
400
```

And the refusals:

```
> run_query  DROP TABLE customers
Query refused: only SELECT statements are allowed; this one starts with DROP

> run_query  SELECT * FROM employee_salaries
Query refused: not permitted to read: employee_salaries
```

## Tools

| Tool | What it does |
| --- | --- |
| `list_tables` | Visible tables and views, with approximate row counts |
| `describe_table` | Columns, types, keys, and which columns are masked |
| `run_query` | One SELECT, capped and masked |
| `explain_query` | The planner's output, without running the query |
| `audit_tail` | What this server has been asked to do recently |

## Configuration

```json
{
  "database": { "kind": "postgres", "url": "postgres://readonly@db/app" },
  "maxRows": 1000,
  "timeoutMs": 10000,
  "auditLog": "/var/log/querygate.jsonl",
  "policy": {
    "allowTables": ["analytics_*", "orders", "customers"],
    "denyTables": ["employee_salaries", "*_pii"],
    "hashSalt": "${QUERYGATE_SALT}",
    "mask": [
      { "table": "customers", "column": "email", "strategy": "domain" },
      { "table": "customers", "column": "phone", "strategy": "partial" },
      { "table": "customers", "column": "ssn",   "strategy": "hash" },
      { "table": "*",         "column": "password_hash", "strategy": "redact" }
    ]
  }
}
```

Masking strategies:

| Strategy | `aoi.sato@example.com` becomes | Use it when |
| --- | --- | --- |
| `redact` | `[redacted]` | The value must never appear |
| `domain` | `[redacted]@example.com` | The domain is the analytically useful part |
| `partial` | `*************.com` | Last four characters identify a record for support |
| `hash` | `4e9f2a1c8b7d3e60` | The agent must group or join on it but never read it |

`hash` is the one worth understanding: it is stable across rows and runs, so
`GROUP BY user_id` still works and the values are still never disclosed. It is
salted, so the same input hashes differently in each deployment.

## Connecting it

Claude Desktop / Claude Code, over stdio:

```json
{
  "mcpServers": {
    "warehouse": {
      "command": "npx",
      "args": ["-y", "querygate", "stdio"],
      "env": {
        "DATABASE_URL": "postgres://readonly@db/app",
        "QUERYGATE_CONFIG": "/etc/querygate.json"
      }
    }
  }
}
```

Or one shared HTTP server for several agents:

```bash
querygate http --config /etc/querygate.json    # POST /mcp, GET /health
```

Behind an authenticating proxy, set `X-Querygate-Actor` and the audit log
records who each session was. Without it, entries say `anonymous` rather than
inventing an identity.

## What this is not

**The SQL guard is defence in depth, not a security boundary.** It tokenises
before it inspects — so `SELECT 'drop table users'` is allowed and
`DR/**/OP TABLE users` is not — and it refuses stacked statements, DDL, DML,
`ATTACH`, `COPY`, `pg_read_file()` and their neighbours. It also catches the
one people forget:

```sql
WITH gone AS (DELETE FROM users RETURNING *) SELECT * FROM gone
```

which is valid Postgres, is not read-only, and passes any check that only looks
at the first keyword.

But a SQL firewall is a filter, and filters have edges. **The actual boundary is
the database role querygate connects as**, which should have no write privilege
at all. querygate reinforces it — the Postgres adapter sets the session to
`READ ONLY`, and the SQLite adapter opens the file read-only — so a statement
that somehow slipped past the parser still cannot change anything.

Configure the role first. Treat everything here as the layer that gives you
good error messages and an audit trail.

## Databases

- **SQLite** — bundled, used by the demo and the tests.
- **Postgres** — `npm install pg`. Optional peer dependency, so the demo does
  not drag a driver along.

Adding another is one interface with five methods (`src/adapters/types.ts`).

## Development

```bash
npm install
npm test          # 79 tests
npm run typecheck
npm run build
```

The end-to-end tests run a real MCP client against a real server over the
protocol, against a real SQLite database — not mocks. A tool that works when
called in-process but fails to serialise over MCP is still broken.

## License

MIT.
