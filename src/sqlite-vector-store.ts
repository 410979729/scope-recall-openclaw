import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryEntry, MemorySearchResult } from "./store.js";

const require = createRequire(import.meta.url);

type DatabaseSync = any;

interface VectorRow {
  id: string;
  text: string;
  category: MemoryEntry["category"];
  scope: string;
  importance: number;
  timestamp: number;
  metadata: string;
  vector_json: string;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function cosineDistance(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    const l = Number(left[i]) || 0;
    const r = Number(right[i]) || 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 1;
  const similarity = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  return Math.max(0, Math.min(2, 1 - similarity));
}

function rowToEntry(row: VectorRow, includeVector: boolean): MemoryEntry {
  return {
    id: row.id,
    text: row.text,
    vector: includeVector ? JSON.parse(row.vector_json) as number[] : [],
    category: row.category,
    scope: row.scope || "global",
    importance: Number(row.importance),
    timestamp: Number(row.timestamp),
    metadata: row.metadata || "{}",
  };
}

export class SqliteBruteForceVectorStore {
  private db: DatabaseSync | null = null;
  private readonly sqlitePath: string;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
  ) {
    this.sqlitePath = join(dbPath, "vector.sqlite3");
  }

  get path(): string {
    return this.sqlitePath;
  }

  get backend(): "sqlite-bruteforce" {
    return "sqlite-bruteforce";
  }

  open(): void {
    if (this.db) return;
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
    mkdirSync(dirname(this.sqlitePath), { recursive: true });
    this.db = new DatabaseSync(this.sqlitePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.ensureSchema();
    this.resetOnDimensionChange();
  }

  close(): void {
    try {
      this.db?.close?.();
    } finally {
      this.db = null;
    }
  }

  upsert(entry: MemoryEntry): void {
    const vector = this.coerceVector(entry.vector);
    this.requireDb().prepare(
      `
      INSERT INTO vector_records (
        id, text, category, scope, importance, timestamp, metadata, vector_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        category = excluded.category,
        scope = excluded.scope,
        importance = excluded.importance,
        timestamp = excluded.timestamp,
        metadata = excluded.metadata,
        vector_json = excluded.vector_json,
        updated_at = excluded.updated_at
      `,
    ).run(
      entry.id,
      entry.text || "",
      entry.category || "other",
      entry.scope || "global",
      Number(entry.importance) || 0,
      Number(entry.timestamp) || Date.now(),
      entry.metadata || "{}",
      JSON.stringify(vector),
      Date.now(),
    );
  }

  delete(id: string): void {
    this.requireDb().prepare("DELETE FROM vector_records WHERE id = ?").run(id);
  }

  getById(id: string): MemoryEntry | null {
    const row = this.requireDb()
      .prepare("SELECT * FROM vector_records WHERE id = ? LIMIT 1")
      .get(id) as VectorRow | undefined;
    return row ? rowToEntry(row, true) : null;
  }

  listIds(): string[] {
    const rows = this.requireDb()
      .prepare("SELECT id FROM vector_records ORDER BY id")
      .all() as Array<{ id: string }>;
    return rows.map((row) => row.id).filter(Boolean);
  }

  listEntriesWithVectors(): MemoryEntry[] {
    const rows = this.requireDb()
      .prepare("SELECT * FROM vector_records ORDER BY timestamp DESC")
      .all() as VectorRow[];
    return rows.map((row) => rowToEntry(row, true));
  }

  scopeCounts(): Record<string, number> {
    const rows = this.requireDb()
      .prepare("SELECT scope, COUNT(*) AS count FROM vector_records GROUP BY scope")
      .all() as Array<{ scope: string | null; count: number }>;
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.scope || "global"] = Number(row.count) || 0;
    }
    return counts;
  }

  search(
    vector: number[],
    limit = 5,
    minScore = 0.3,
    scopeFilter?: string[],
  ): MemorySearchResult[] {
    const safeLimit = clampInt(limit, 1, 20);
    const queryVector = this.coerceVector(vector);
    const rows = this.selectRows(scopeFilter);
    const results: MemorySearchResult[] = [];

    for (const row of rows) {
      let entry: MemoryEntry;
      try {
        entry = rowToEntry(row, true);
      } catch {
        continue;
      }
      const distance = cosineDistance(queryVector, entry.vector);
      const score = 1 / (1 + distance);
      if (score < minScore) continue;
      results.push({ entry, score });
    }

    return results
      .sort((left, right) => right.score - left.score || right.entry.timestamp - left.entry.timestamp)
      .slice(0, safeLimit);
  }

  private selectRows(scopeFilter?: string[]): VectorRow[] {
    if (Array.isArray(scopeFilter) && scopeFilter.length === 0) return [];
    if (scopeFilter && scopeFilter.length > 0) {
      const placeholders = scopeFilter.map(() => "?").join(", ");
      return this.requireDb()
        .prepare(`SELECT * FROM vector_records WHERE scope IN (${placeholders}) OR scope IS NULL`)
        .all(...scopeFilter) as VectorRow[];
    }
    return this.requireDb().prepare("SELECT * FROM vector_records").all() as VectorRow[];
  }

  private coerceVector(value: unknown): number[] {
    const raw = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(raw)) {
      throw new Error("vector must be an array");
    }
    const vector = raw.map((item) => Number(item));
    if (vector.length !== this.vectorDim) {
      throw new Error(`vector dimension mismatch: expected ${this.vectorDim}, got ${vector.length}`);
    }
    return vector;
  }

  private ensureSchema(): void {
    const db = this.requireDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS vector_records (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        category TEXT NOT NULL,
        scope TEXT NOT NULL,
        importance REAL NOT NULL,
        timestamp REAL NOT NULL,
        metadata TEXT NOT NULL,
        vector_json TEXT NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vector_records_scope ON vector_records(scope);
      CREATE INDEX IF NOT EXISTS idx_vector_records_timestamp ON vector_records(timestamp);
      CREATE TABLE IF NOT EXISTS vector_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private resetOnDimensionChange(): void {
    const db = this.requireDb();
    const row = db.prepare("SELECT value FROM vector_meta WHERE key = 'dimensions'").get() as { value?: string } | undefined;
    const previousDim = row?.value ? Number(row.value) : 0;
    if (previousDim && previousDim !== this.vectorDim) {
      db.prepare("DELETE FROM vector_records").run();
    }
    db.prepare(
      "INSERT INTO vector_meta(key, value) VALUES('dimensions', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(this.vectorDim));
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("sqlite-bruteforce vector store is not open");
    }
    return this.db;
  }
}
