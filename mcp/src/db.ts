// Database access for the MCP server.
//
// One connection string, one role, one schema. The role holds SELECT on
// `rag_mcp` and nothing else in the database, so scope is enforced by Postgres
// grants rather than by inspecting the SQL a caller sends. See
// mcp/migrations/0001-rag-mcp-schema-and-reader-role.sql.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Load .env.local into process.env without clobbering real environment values.
 *
 * An MCP server is launched by the client (Claude Code, Claude Desktop) with a
 * near-empty environment, so it cannot rely on a shell having sourced anything.
 * Mirrors the loader in scripts/embed-rag-chunks.ts rather than adding a
 * dependency for four lines of parsing.
 */
export function loadEnv(): void {
  try {
    const raw = readFileSync(resolve(REPO_ROOT, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      if (line.startsWith("#")) continue;
      const index = line.indexOf("=");
      if (index < 1) continue;
      const key = line.slice(0, index).trim();
      let value = line.slice(index + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // Env may legitimately come from the launching process instead.
  }
}

export type ServerConfig = {
  databaseUrl: string;
  projectRef: string;
  statementTimeoutMs: number;
  defaultRowLimit: number;
  maxRowLimit: number;
};

/**
 * Resolve config and refuse to start on anything that is not the configured
 * TEST project.
 *
 * This is asserted rather than inherited on purpose. The corpus lives in the
 * TEST database and production is not a target for this repository, but an
 * inherited connection string is exactly the kind of thing that drifts quietly
 * when someone edits an env file months from now. RAG_TEST_PROJECT_REF is
 * already the app's own guard for the same reason (see
 * scripts/embed-rag-chunks.ts), so this reuses it rather than inventing a
 * second source of truth that can disagree with the first.
 */
export function loadConfig(): ServerConfig {
  const databaseUrl = process.env.MCP_DATABASE_URL;
  const projectRef = process.env.RAG_TEST_PROJECT_REF;

  if (!databaseUrl) {
    throw new Error(
      "Missing MCP_DATABASE_URL. This must be the read-only zencub_mcp_reader " +
        "role, never SUPABASE_SERVICE_ROLE_KEY or LANGGRAPH_DATABASE_URL.",
    );
  }
  if (!projectRef) {
    throw new Error("Missing RAG_TEST_PROJECT_REF, which names the only project this server may reach.");
  }
  if (!databaseUrl.includes(projectRef)) {
    throw new Error(
      "MCP_DATABASE_URL does not point at the project named by RAG_TEST_PROJECT_REF. Refusing to start.",
    );
  }
  // A connection string carrying the service-role JWT is a different shape
  // entirely, but the owner DSN looks almost identical to the reader one, and
  // the difference is a single word. Catch it rather than trust the operator.
  if (/:\/\/postgres[.:]/.test(databaseUrl)) {
    throw new Error(
      "MCP_DATABASE_URL appears to use the `postgres` owner role, which can write to every table " +
        "in the database. Use the zencub_mcp_reader role. Refusing to start.",
    );
  }

  return {
    databaseUrl,
    projectRef,
    statementTimeoutMs: numberFromEnv("MCP_STATEMENT_TIMEOUT_MS", 5_000),
    defaultRowLimit: numberFromEnv("MCP_DEFAULT_ROW_LIMIT", 200),
    maxRowLimit: numberFromEnv("MCP_MAX_ROW_LIMIT", 1_000),
  };
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export type QueryResult = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
};

export class CorpusDatabase {
  private readonly pool: pg.Pool;
  private readonly config: ServerConfig;

  // Fields assigned explicitly rather than via parameter properties: Node's
  // strip-only type stripping does not support them, and this file runs
  // straight from source under `node --experimental-strip-types`.
  constructor(config: ServerConfig) {
    this.config = config;
    this.pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      application_name: "zencub-rag-mcp",
    });
    // A pool error on an idle client is emitted on the pool, and an unhandled
    // 'error' event on an EventEmitter takes the process down. An MCP server
    // dying on a dropped idle socket would look, from the client, exactly like
    // the tool never existing.
    this.pool.on("error", (error) => {
      process.stderr.write(`[zencub-rag-mcp] idle client error: ${error.message}\n`);
    });
  }

  /**
   * Run one statement inside an explicit read-only transaction.
   *
   * The role already carries `default_transaction_read_only` and a statement
   * timeout, and those were verified live through the pooler. They are not
   * relied on here: a later ALTER ROLE does not reach warm pooled connections
   * (measured), so any setting we might want to tune has to be applied by the
   * client to be trustworthy. The transaction is rolled back rather than
   * committed because nothing here ever intends to write.
   */
  async readOnly(sql: string, params: unknown[] = [], timeoutMs?: number): Promise<QueryResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${Number(timeoutMs ?? this.config.statementTimeoutMs)}`);
      const result = await client.query({ text: sql, values: params, rowMode: "array" });

      // Array row mode, then name the columns here, because arbitrary caller
      // SQL can produce duplicates (`select a.id, b.id from ...`) and pg's
      // object mode silently keeps only the last one. Suffixing makes the
      // collision visible instead of dropping a column the caller asked for.
      const seen = new Map<string, number>();
      const columns = result.fields.map((field) => {
        const count = seen.get(field.name) ?? 0;
        seen.set(field.name, count + 1);
        return count === 0 ? field.name : `${field.name}_${count + 1}`;
      });
      const rows = (result.rows as unknown[][]).map((row) =>
        Object.fromEntries(row.map((value, index) => [columns[index], value])),
      );
      return { columns, rows, rowCount: rows.length, truncated: false };
    } finally {
      // ROLLBACK can itself fail on a broken connection; releasing the client
      // matters more than the rollback succeeding, so it must not throw here.
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
