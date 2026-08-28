// Filter-value validation for the structured tools.
//
// Why this file exists, in one failure: list_techniques(gi_nogi: "nogi")
// returned 0 rows with truncated:false while the stored value is "no_gi" and
// the true answer is 28. A plausible spelling produced a clean, confident,
// wrong answer. Worse, list_techniques(gi_nogi: "gi") returned *no_gi* cards,
// because the filter was a substring match and 'no_gi' ILIKE '%gi%' is true.
//
// Both are the defining failure mode for a model-facing tool: not the error,
// the well-formed wrong answer. A model has no way to tell an empty result
// from a wrong-spelling result, and no way to tell "gi" from "not gi".
//
// The rule here: an enum-ish filter is matched exactly against the values that
// are actually stored, after canonicalising punctuation and case, and an
// unrecognised value is refused with the list of real ones rather than
// answered with an empty set.

import type { CorpusDatabase } from "./db.ts";

/** Fields matched exactly. Low cardinality, and a substring match on any of
 *  them can return the opposite of what was asked for. */
export const EXACT_FIELDS = ["gi_nogi", "type", "difficulty"] as const;
export type ExactField = (typeof EXACT_FIELDS)[number];

/** Fields matched as a substring on purpose: the position columns are
 *  hierarchical, so "guard" legitimately spans guard, open_guard and
 *  half_guard. Still validated, so an unknown position is refused rather than
 *  returning nothing. */
export type FuzzyField = "position";

export type FieldName = ExactField | FuzzyField;

/**
 * Canonical form for comparison only. Never stored, never returned.
 * "No Gi", "no-gi", "nogi" and "NO_GI" all collapse to "nogi".
 *
 * Safe because the collapse is injective over the real value set: checked at
 * load time by {@link assertInjective}, which refuses to build a lookup that
 * would map two different stored values onto one key.
 */
function canonical(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface FieldValues {
  /** Stored value -> row count, descending. Nulls excluded. */
  counts: Map<string, number>;
  /** canonical(stored) -> stored. */
  byCanonical: Map<string, string>;
}

function assertInjective(field: string, counts: Map<string, number>): Map<string, string> {
  const byCanonical = new Map<string, string>();
  for (const stored of counts.keys()) {
    const key = canonical(stored);
    const clash = byCanonical.get(key);
    // Two stored values collapsing to one key would make canonicalisation
    // itself a source of wrong answers, which is the thing being fixed.
    // Fall back to exact-only matching for the whole field rather than guess.
    if (clash !== undefined && clash !== stored) {
      throw new AmbiguousCanonicalisation(field, clash, stored);
    }
    byCanonical.set(key, stored);
  }
  return byCanonical;
}

export class AmbiguousCanonicalisation extends Error {
  constructor(field: string, a: string, b: string) {
    super(`${field}: '${a}' and '${b}' collapse to the same canonical form; exact spelling required.`);
  }
}

/** The technique-card columns whose distinct values are validated. */
const SOURCE_SQL: Record<FieldName, string> = {
  gi_nogi:
    "SELECT gi_nogi AS v, count(*)::int AS n FROM rag_mcp.v_techniques WHERE gi_nogi IS NOT NULL GROUP BY 1 ORDER BY 2 DESC",
  type:
    "SELECT type AS v, count(*)::int AS n FROM rag_mcp.v_techniques WHERE type IS NOT NULL GROUP BY 1 ORDER BY 2 DESC",
  difficulty:
    "SELECT difficulty AS v, count(*)::int AS n FROM rag_mcp.v_techniques WHERE difficulty IS NOT NULL GROUP BY 1 ORDER BY 2 DESC",
  // All three position columns, because the filter searches all three.
  position: `SELECT v, sum(n)::int AS n FROM (
               SELECT canonical_position AS v, count(*)::int AS n FROM rag_mcp.v_techniques WHERE canonical_position IS NOT NULL GROUP BY 1
               UNION ALL
               SELECT position, count(*)::int FROM rag_mcp.v_techniques WHERE position IS NOT NULL GROUP BY 1
               UNION ALL
               SELECT sub_position, count(*)::int FROM rag_mcp.v_techniques WHERE sub_position IS NOT NULL GROUP BY 1
             ) s GROUP BY 1 ORDER BY 2 DESC`,
};

export type Resolution =
  | { ok: true; field: FieldName; input: string; value: string; matched: string[] }
  | { ok: false; field: FieldName; input: string; message: string };

/**
 * Reads the live distinct values and answers "is this a real value".
 *
 * Cached per process, but a miss triggers exactly one refresh before the value
 * is refused. A stale cache must never be the reason a legitimate filter is
 * rejected: that would be the same class of confident-wrong-answer this file
 * exists to remove, just pointing the other way.
 */
export class FilterVocabulary {
  private db: CorpusDatabase;
  private cache = new Map<FieldName, FieldValues>();
  private exactOnly = new Set<FieldName>();

  constructor(db: CorpusDatabase) {
    this.db = db;
  }

  private async load(field: FieldName): Promise<FieldValues> {
    const result = await this.db.readOnly(SOURCE_SQL[field], []);
    const counts = new Map<string, number>();
    for (const row of result.rows as Array<Record<string, unknown>>) {
      counts.set(String(row.v), Number(row.n));
    }
    let byCanonical: Map<string, string>;
    try {
      byCanonical = assertInjective(field, counts);
      this.exactOnly.delete(field);
    } catch (error) {
      if (!(error instanceof AmbiguousCanonicalisation)) throw error;
      // Degrade to exact spelling for this field, and say so in the refusal.
      this.exactOnly.add(field);
      byCanonical = new Map([...counts.keys()].map((v) => [v, v]));
    }
    const values = { counts, byCanonical };
    this.cache.set(field, values);
    return values;
  }

  private async values(field: FieldName, forceReload = false): Promise<FieldValues> {
    if (!forceReload) {
      const cached = this.cache.get(field);
      if (cached) return cached;
    }
    return this.load(field);
  }

  /** Human-readable value list, most common first, capped so a long list does
   *  not swamp the caller's context. */
  private legend(values: FieldValues, cap = 20): string {
    const entries = [...values.counts.entries()];
    const shown = entries.slice(0, cap).map(([v, n]) => `${v} (${n})`);
    const rest = entries.length - shown.length;
    return shown.join(", ") + (rest > 0 ? `, and ${rest} more` : "");
  }

  /** Exact match after canonicalisation. Used for gi_nogi, type, difficulty. */
  async resolveExact(field: ExactField, input: string): Promise<Resolution> {
    const trimmed = input.trim();
    if (trimmed === "") {
      return { ok: false, field, input, message: `${field} was empty. Omit it instead of passing a blank string.` };
    }
    for (const reload of [false, true]) {
      const values = await this.values(field, reload);
      const hit = values.byCanonical.get(this.exactOnly.has(field) ? trimmed : canonical(trimmed));
      if (hit !== undefined) return { ok: true, field, input, value: hit, matched: [hit] };
      // Only refuse after a fresh read, so a stale cache cannot reject a value
      // that the corpus has since acquired.
      if (reload) {
        const spelling = this.exactOnly.has(field) ? " Exact spelling is required for this field." : "";
        return {
          ok: false,
          field,
          input,
          message:
            `No such ${field} value '${trimmed}'. Valid values, with card counts: ${this.legend(values)}.${spelling}`,
        };
      }
    }
    /* c8 ignore next */
    throw new Error("unreachable");
  }

  /** Substring match, but only against values that exist. Used for position,
   *  whose columns are hierarchical on purpose. */
  async resolveFuzzy(field: FuzzyField, input: string): Promise<Resolution> {
    const trimmed = input.trim();
    if (trimmed === "") {
      return { ok: false, field, input, message: `${field} was empty. Omit it instead of passing a blank string.` };
    }
    const needle = canonical(trimmed);
    for (const reload of [false, true]) {
      const values = await this.values(field, reload);
      const matched = [...values.counts.keys()]
        .filter((v) => canonical(v).includes(needle))
        .sort((a, b) => (values.counts.get(b) ?? 0) - (values.counts.get(a) ?? 0));
      if (matched.length > 0) return { ok: true, field, input, value: trimmed, matched };
      if (reload) {
        return {
          ok: false,
          field,
          input,
          message: `No ${field} matches '${trimmed}'. Known positions, with card counts: ${this.legend(values)}.`,
        };
      }
    }
    /* c8 ignore next */
    throw new Error("unreachable");
  }

  /** An unknown instructor slug is the same silent-empty-set failure, so it is
   *  refused the same way, with the near misses named. */
  async resolveInstructor(input: string): Promise<{ ok: true; slug: string } | { ok: false; message: string }> {
    const trimmed = input.trim();
    if (trimmed === "") return { ok: false, message: "instructor was empty. Omit it instead of passing a blank string." };
    const exact = await this.db.readOnly(
      "SELECT creator_slug FROM rag_mcp.v_instructors WHERE creator_slug = $1 LIMIT 1",
      [trimmed],
    );
    if (exact.rowCount > 0) return { ok: true, slug: trimmed };
    // Name it a slug problem and offer the real slugs, rather than returning
    // "this instructor has no techniques", which is a different claim.
    const near = await this.db.readOnly(
      `SELECT creator_slug, display_name, techniques_count
         FROM rag_mcp.v_instructors
        WHERE creator_slug ILIKE '%'||$1||'%' OR display_name ILIKE '%'||$1||'%'
        ORDER BY techniques_count DESC NULLS LAST
        LIMIT 10`,
      [trimmed],
    );
    const rows = near.rows as Array<Record<string, unknown>>;
    const suggestions = rows.map((r) => `${r.creator_slug} (${r.display_name})`).join(", ");
    return {
      ok: false,
      message:
        `No instructor with slug '${trimmed}'. ` +
        (suggestions ? `Did you mean: ${suggestions}?` : "Use get_instructor or v_instructors to find the slug.") +
        " This is a slug that does not exist, not an instructor with no techniques.",
    };
  }
}
