// Shape checks for caller-supplied SQL.
//
// These are NOT the security boundary. The boundary is that `zencub_mcp_reader`
// holds SELECT on schema `rag_mcp` and no privilege anywhere else, and that
// every statement runs inside `BEGIN TRANSACTION READ ONLY`. A write, a call
// into another schema, or a DDL attempt fails at the database regardless of
// what passes here.
//
// What these checks buy is a clear error instead of a Postgres one, and a
// refusal to send obviously wrong shapes at all. Written as a guard, not a
// parser: pretending to parse SQL with regexes is how people end up trusting
// them.

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

const ALLOWED_LEADERS = /^(select|with|table|values|explain)\b/i;

/**
 * Strip string literals, dollar-quoted blocks, and comments so that keyword and
 * semicolon checks cannot be fooled by content inside them. The result is
 * inspected, never executed: the original text is what runs.
 */
function blank(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);

    // Line comment
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    // Block comment, which nests in Postgres
    if (rest.startsWith("/*")) {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.startsWith("/*", j)) { depth += 1; j += 2; continue; }
        if (sql.startsWith("*/", j)) { depth -= 1; j += 2; continue; }
        j += 1;
      }
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    // Dollar-quoted string, tag optional
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    // Single-quoted literal, '' escapes a quote
    if (rest.startsWith("'")) {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    // Double-quoted identifier: keep it, but blanked, so a table named
    // "delete from x" cannot trip the keyword check.
    if (rest.startsWith('"')) {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; continue; }
        if (sql[j] === '"') { j += 1; break; }
        j += 1;
      }
      out += " ".repeat(j - i);
      i = j;
      continue;
    }

    out += sql[i];
    i += 1;
  }
  return out;
}

// Statements that must never be sent, even though the role could not execute
// them. Listed for the error message, not for safety.
const FORBIDDEN = [
  "insert", "update", "delete", "truncate", "drop", "alter", "create", "grant",
  "revoke", "comment", "copy", "call", "do", "vacuum", "analyze", "reindex",
  "cluster", "refresh", "lock", "listen", "notify", "prepare", "execute",
  "begin", "commit", "rollback", "savepoint", "set", "reset", "discard",
  "security", "merge",
];

export function guardSql(input: string, maxLength = 20_000): GuardResult {
  const sql = input.trim().replace(/;\s*$/, "");

  if (sql.length === 0) return { ok: false, reason: "Empty query." };
  if (sql.length > maxLength) {
    return { ok: false, reason: `Query is longer than ${maxLength} characters.` };
  }

  const stripped = blank(sql);

  // One statement only. The trailing semicolon is already gone, so any
  // remaining one outside a literal means a second statement was appended.
  if (stripped.includes(";")) {
    return { ok: false, reason: "Only one statement is allowed. Remove the ';' and send a single query." };
  }

  if (!ALLOWED_LEADERS.test(stripped.trimStart())) {
    return {
      ok: false,
      reason: "Only SELECT, WITH, TABLE, VALUES, and EXPLAIN queries are accepted. This server is read-only.",
    };
  }

  // A data-modifying CTE (`with x as (delete from ... returning *)`) starts
  // with an allowed leader, so the leader check alone is not enough.
  for (const word of FORBIDDEN) {
    if (new RegExp(`\\b${word}\\b`, "i").test(stripped)) {
      return {
        ok: false,
        reason:
          `The keyword '${word.toUpperCase()}' is not accepted. This server can only read, ` +
          "and the database role it uses has no write privilege on anything.",
      };
    }
  }

  return { ok: true, sql };
}

/**
 * Wrap a caller's query so it cannot return more rows than the caller asked
 * for. Applied as an outer SELECT rather than by appending LIMIT, because the
 * inner query may already carry its own LIMIT, an ORDER BY, or a UNION, and
 * appending would change its meaning or be a syntax error.
 */
export function withRowLimit(sql: string, limit: number): string {
  return `SELECT * FROM (${sql}) AS mcp_limited LIMIT ${Math.trunc(limit)}`;
}
