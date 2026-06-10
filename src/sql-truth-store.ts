import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { MemoryEntry, MemorySearchResult } from "./store.js";
import { parseSmartMetadata, isMemoryActiveAt } from "./smart-metadata.js";

const require = createRequire(import.meta.url);

type DatabaseSync = any;

interface SqlRow {
  id: string;
  text: string;
  category: MemoryEntry["category"];
  scope: string;
  importance: number;
  timestamp: number;
  metadata: string;
  metadata_text: string;
  raw_bm25?: number | null;
}

interface ScopeClause {
  sql: string;
  params: unknown[];
}

export interface SqlTruthStats {
  totalCount: number;
  scopeCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
}

export interface SqlTruthFtsReport {
  truthRows: number;
  ftsRows: number;
  staleFtsRows: number;
  missingFtsRows: number;
  duplicateFtsExtraRows: number;
  healthy: boolean;
}

const WORD_RE = /[a-zA-Z0-9]{2,}|[\u4e00-\u9fff]{2,}/g;
const MAX_LIST_LIMIT = 10_000;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function queryTokens(text: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const match of (text || "").toLowerCase().matchAll(WORD_RE)) {
    const token = match[0];
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function buildFtsQuery(tokens: string[]): string {
  return tokens
    .filter(Boolean)
    .slice(0, 12)
    .map((token) => `"${token.replace(/"/g, " ")}"`)
    .join(" OR ");
}

function metadataSearchText(metadata: string): string {
  if (!metadata) return "";
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return [
      parsed.l0_abstract,
      parsed.l1_overview,
      parsed.l2_content,
      parsed.keywords,
      parsed.entities,
      parsed.tags,
      parsed.category,
      parsed.tier,
    ]
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n");
  } catch {
    return metadata;
  }
}

function scoreLexicalHit(query: string, text: string, metadataText: string): number {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return 0;

  const haystack = `${text}\n${metadataText}`.toLowerCase();
  const queryTokenSet = new Set(queryTokens(query));
  const docTokenSet = new Set(queryTokens(haystack));
  let overlap = 0;
  for (const token of queryTokenSet) {
    if (docTokenSet.has(token)) overlap++;
  }
  const overlapScore = queryTokenSet.size > 0 ? overlap / queryTokenSet.size : 0;
  const phraseBonus = haystack.includes(normalizedQuery) ? 0.35 : 0;
  return Math.max(0, Math.min(1, overlapScore * 0.68 + phraseBonus));
}

function normalizeBm25(rawScores: Map<string, number>): Map<string, number> {
  if (rawScores.size === 0) return new Map();
  const values = [...rawScores.values()].filter(Number.isFinite);
  if (values.length === 0) return new Map();
  const best = Math.min(...values);
  const worst = Math.max(...values);
  if (best === worst) {
    return new Map([...rawScores.keys()].map((id) => [id, 1]));
  }
  const span = worst - best;
  return new Map(
    [...rawScores.entries()].map(([id, value]) => [
      id,
      Math.max(0, Math.min(1, (worst - value) / span)),
    ]),
  );
}

function toMemoryEntry(row: SqlRow): MemoryEntry {
  return {
    id: row.id,
    text: row.text,
    vector: [],
    category: row.category,
    scope: row.scope || "global",
    importance: Number(row.importance),
    timestamp: Number(row.timestamp),
    metadata: row.metadata || "{}",
  };
}

export class SqlTruthStore {
  private db: DatabaseSync | null = null;

  constructor(private readonly sqlitePath: string) {}

  get path(): string {
    return this.sqlitePath;
  }

  open(): void {
    if (this.db) return;
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
    mkdirSync(dirname(this.sqlitePath), { recursive: true });
    this.db = new DatabaseSync(this.sqlitePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.ensureSchema();
  }

  close(): void {
    try {
      this.db?.close?.();
    } finally {
      this.db = null;
    }
  }

  upsert(entry: MemoryEntry): void {
    const db = this.requireDb();
    const metadata = entry.metadata || "{}";
    const metadataText = metadataSearchText(metadata);
    db.prepare(
      `
      INSERT INTO memory_truth (
        id, text, category, scope, importance, timestamp, metadata, metadata_text, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        category = excluded.category,
        scope = excluded.scope,
        importance = excluded.importance,
        timestamp = excluded.timestamp,
        metadata = excluded.metadata,
        metadata_text = excluded.metadata_text,
        updated_at = excluded.updated_at
      `,
    ).run(
      entry.id,
      entry.text || "",
      entry.category || "other",
      entry.scope || "global",
      Number(entry.importance) || 0,
      Number(entry.timestamp) || Date.now(),
      metadata,
      metadataText,
      Date.now(),
    );
    this.replaceFts(entry.id, entry.text || "", metadataText);
  }

  delete(id: string): void {
    const db = this.requireDb();
    db.prepare("DELETE FROM memory_truth_fts WHERE memory_id = ?").run(id);
    db.prepare("DELETE FROM memory_truth WHERE id = ?").run(id);
  }

  getById(id: string, scopeFilter?: string[]): MemoryEntry | null {
    const db = this.requireDb();
    const scope = this.scopeClause("memory_truth", scopeFilter);
    const row = db.prepare(
      `
      SELECT *
      FROM memory_truth
      WHERE id = ? AND ${scope.sql}
      LIMIT 1
      `,
    ).get(id, ...scope.params) as SqlRow | undefined;
    return row ? toMemoryEntry(row) : null;
  }

  findByPrefix(prefix: string, scopeFilter?: string[]): MemoryEntry[] {
    const db = this.requireDb();
    const scope = this.scopeClause("memory_truth", scopeFilter);
    const rows = db.prepare(
      `
      SELECT *
      FROM memory_truth
      WHERE id LIKE ? AND ${scope.sql}
      ORDER BY timestamp DESC
      LIMIT 50
      `,
    ).all(`${prefix}%`, ...scope.params) as SqlRow[];
    return rows.map(toMemoryEntry);
  }

  list(
    scopeFilter?: string[],
    category?: string,
    limit = 20,
    offset = 0,
  ): MemoryEntry[] {
    const db = this.requireDb();
    const scope = this.scopeClause("m", scopeFilter);
    const clauses = [scope.sql];
    const params = [...scope.params];
    if (category) {
      clauses.push("m.category = ?");
      params.push(category);
    }
    const safeLimit = clampInt(limit, 1, MAX_LIST_LIMIT);
    const safeOffset = clampInt(offset, 0, 1000000);
    const rows = db.prepare(
      `
      SELECT m.*
      FROM memory_truth m
      WHERE ${clauses.join(" AND ")}
      ORDER BY m.timestamp DESC
      LIMIT ? OFFSET ?
      `,
    ).all(...params, safeLimit, safeOffset) as SqlRow[];
    return rows.map(toMemoryEntry);
  }

  stats(scopeFilter?: string[]): SqlTruthStats {
    const db = this.requireDb();
    const scope = this.scopeClause("m", scopeFilter);
    const total = db.prepare(
      `SELECT COUNT(*) AS count FROM memory_truth m WHERE ${scope.sql}`,
    ).get(...scope.params) as { count: number };
    const scopeRows = db.prepare(
      `
      SELECT COALESCE(m.scope, 'global') AS scope, COUNT(*) AS count
      FROM memory_truth m
      WHERE ${scope.sql}
      GROUP BY COALESCE(m.scope, 'global')
      `,
    ).all(...scope.params) as Array<{ scope: string; count: number }>;
    const categoryRows = db.prepare(
      `
      SELECT m.category AS category, COUNT(*) AS count
      FROM memory_truth m
      WHERE ${scope.sql}
      GROUP BY m.category
      `,
    ).all(...scope.params) as Array<{ category: string; count: number }>;

    return {
      totalCount: Number(total?.count || 0),
      scopeCounts: Object.fromEntries(scopeRows.map((row) => [row.scope, Number(row.count)])),
      categoryCounts: Object.fromEntries(categoryRows.map((row) => [row.category, Number(row.count)])),
    };
  }

  bulkDelete(scopeFilter: string[], beforeTimestamp?: number): string[] {
    const db = this.requireDb();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (scopeFilter.length > 0) {
      const scope = this.scopeClause("m", scopeFilter);
      clauses.push(scope.sql);
      params.push(...scope.params);
    }
    if (beforeTimestamp) {
      clauses.push("m.timestamp < ?");
      params.push(beforeTimestamp);
    }
    if (clauses.length === 0) {
      throw new Error("SQL truth bulk delete requires at least scope or timestamp filter");
    }
    const rows = db.prepare(
      `SELECT m.id FROM memory_truth m WHERE ${clauses.join(" AND ")}`,
    ).all(...params) as Array<{ id: string }>;
    for (const row of rows) {
      this.delete(row.id);
    }
    return rows.map((row) => row.id);
  }

  reconcile(
    entries: MemoryEntry[],
    options: { deleteMissing?: boolean } = {},
  ): { upserted: number; deleted: number } {
    const db = this.requireDb();
    let upserted = 0;
    let deleted = 0;
    const deleteMissing = options.deleteMissing === true;
    db.exec("BEGIN IMMEDIATE");
    try {
      const wanted = new Set(entries.map((entry) => entry.id).filter(Boolean));
      for (const entry of entries) {
        if (!entry.id) continue;
        this.upsert(entry);
        upserted++;
      }
      if (deleteMissing) {
        const rows = db.prepare("SELECT id FROM memory_truth").all() as Array<{ id: string }>;
        for (const row of rows) {
          if (wanted.has(row.id)) continue;
          this.delete(row.id);
          deleted++;
        }
      }
      db.exec("COMMIT");
      return { upserted, deleted };
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch {}
      throw err;
    }
  }

  search(
    query: string,
    limit: number,
    scopeFilter?: string[],
    options?: { excludeInactive?: boolean },
  ): MemorySearchResult[] {
    const db = this.requireDb();
    const trimmed = query.trim();
    if (!trimmed) return [];

    const safeLimit = clampInt(limit, 1, 20);
    const candidatePool = Math.min(Math.max(safeLimit * 4, safeLimit), 120);
    const tokens = queryTokens(trimmed);
    const ftsQuery = buildFtsQuery(tokens);
    const rowsById = new Map<string, SqlRow>();
    const rawBm25 = new Map<string, number>();
    const scope = this.scopeClause("m", scopeFilter);

    if (ftsQuery) {
      const rows = db.prepare(
        `
        SELECT m.*, bm25(memory_truth_fts) AS raw_bm25
        FROM memory_truth_fts
        JOIN memory_truth m ON m.id = memory_truth_fts.memory_id
        WHERE memory_truth_fts MATCH ? AND ${scope.sql}
        ORDER BY bm25(memory_truth_fts) ASC, m.timestamp DESC
        LIMIT ?
        `,
      ).all(ftsQuery, ...scope.params, candidatePool) as SqlRow[];
      for (const row of rows) {
        rowsById.set(row.id, row);
        if (Number.isFinite(Number(row.raw_bm25))) {
          rawBm25.set(row.id, Number(row.raw_bm25));
        }
      }
    }

    for (const term of tokens.slice(0, 6)) {
      const likeScope = this.scopeClause("m", scopeFilter);
      const rows = db.prepare(
        `
        SELECT m.*, NULL AS raw_bm25
        FROM memory_truth m
        WHERE (m.text LIKE ? OR m.metadata_text LIKE ?) AND ${likeScope.sql}
        ORDER BY m.timestamp DESC
        LIMIT ?
        `,
      ).all(`%${term}%`, `%${term}%`, ...likeScope.params, candidatePool) as SqlRow[];
      for (const row of rows) {
        if (!rowsById.has(row.id)) rowsById.set(row.id, row);
      }
    }

    const bm25Scores = normalizeBm25(rawBm25);
    const results: MemorySearchResult[] = [];
    for (const row of rowsById.values()) {
      const entry = toMemoryEntry(row);
      if (options?.excludeInactive && !isMemoryActiveAt(parseSmartMetadata(entry.metadata, entry))) {
        continue;
      }
      const lexical = scoreLexicalHit(trimmed, row.text || "", row.metadata_text || "");
      const bm25 = bm25Scores.get(row.id) ?? 0;
      const score = Math.max(lexical, bm25 * 0.96);
      if (score <= 0) continue;
      results.push({ entry, score });
    }

    return results
      .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
      .slice(0, safeLimit);
  }

  count(): number {
    return Number(this.requireDb().prepare("SELECT COUNT(*) AS count FROM memory_truth").get()?.count || 0);
  }

  private ensureSchema(): void {
    const db = this.requireDb();
    db.exec(
      `
      CREATE TABLE IF NOT EXISTS memory_truth (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        category TEXT NOT NULL,
        scope TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0,
        timestamp REAL NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}',
        metadata_text TEXT NOT NULL DEFAULT '',
        updated_at REAL NOT NULL DEFAULT 0
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_truth_fts USING fts5(
        memory_id UNINDEXED,
        text,
        metadata_text
      );
      CREATE INDEX IF NOT EXISTS idx_memory_truth_scope_timestamp
        ON memory_truth(scope, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_truth_category_timestamp
        ON memory_truth(category, timestamp DESC);
      `,
    );
    this.reconcileFts();
  }

  ftsIntegrityReport(): SqlTruthFtsReport {
    const db = this.requireDb();
    const counts = db.prepare(
      `
      SELECT
        (SELECT COUNT(*) FROM memory_truth) AS truth_rows,
        (SELECT COUNT(*) FROM memory_truth_fts) AS fts_rows,
        (
          SELECT COUNT(*)
          FROM memory_truth_fts AS f
          LEFT JOIN memory_truth AS m ON m.id = f.memory_id
          WHERE m.id IS NULL
        ) AS stale_fts_rows,
        (
          SELECT COUNT(*)
          FROM memory_truth AS m
          LEFT JOIN memory_truth_fts AS f ON f.memory_id = m.id
          WHERE f.memory_id IS NULL
        ) AS missing_fts_rows,
        (
          SELECT COALESCE(SUM(extra), 0)
          FROM (
            SELECT COUNT(*) - 1 AS extra
            FROM memory_truth_fts
            GROUP BY memory_id
            HAVING COUNT(*) > 1
          )
        ) AS duplicate_fts_extra_rows
      `,
    ).get() as {
      truth_rows: number;
      fts_rows: number;
      stale_fts_rows: number;
      missing_fts_rows: number;
      duplicate_fts_extra_rows: number;
    };
    const report = {
      truthRows: Number(counts.truth_rows || 0),
      ftsRows: Number(counts.fts_rows || 0),
      staleFtsRows: Number(counts.stale_fts_rows || 0),
      missingFtsRows: Number(counts.missing_fts_rows || 0),
      duplicateFtsExtraRows: Number(counts.duplicate_fts_extra_rows || 0),
      healthy: false,
    };
    report.healthy =
      report.truthRows === report.ftsRows &&
      report.staleFtsRows === 0 &&
      report.missingFtsRows === 0 &&
      report.duplicateFtsExtraRows === 0;
    return report;
  }

  private reconcileFts(): void {
    const db = this.requireDb();
    if (this.ftsIntegrityReport().healthy) return;
    db.exec("DELETE FROM memory_truth_fts");
    db.exec("INSERT INTO memory_truth_fts(memory_id, text, metadata_text) SELECT id, text, metadata_text FROM memory_truth");
  }

  private replaceFts(id: string, text: string, metadataText: string): void {
    const db = this.requireDb();
    db.prepare("DELETE FROM memory_truth_fts WHERE memory_id = ?").run(id);
    db.prepare("INSERT INTO memory_truth_fts(memory_id, text, metadata_text) VALUES (?, ?, ?)").run(id, text, metadataText);
  }

  private scopeClause(alias: string, scopeFilter?: string[]): ScopeClause {
    if (!scopeFilter || scopeFilter.length === 0) {
      return { sql: "1 = 1", params: [] };
    }
    const scopes = scopeFilter.filter(Boolean);
    if (scopes.length === 0) {
      return { sql: "0 = 1", params: [] };
    }
    const placeholders = scopes.map(() => "?").join(", ");
    return {
      sql: `(${alias}.scope IN (${placeholders}) OR ${alias}.scope IS NULL)`,
      params: scopes,
    };
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error(`SQL truth store is not open: ${join(this.sqlitePath)}`);
    }
    return this.db;
  }
}
