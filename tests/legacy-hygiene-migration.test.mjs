import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

function createTruthDb(dir) {
  const dbPath = join(dir, "memory.sqlite3");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE memory_truth (
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
    CREATE VIRTUAL TABLE memory_truth_fts USING fts5(
      memory_id UNINDEXED,
      text,
      metadata_text
    );
  `);
  const insert = db.prepare(`
    INSERT INTO memory_truth (id, text, category, scope, importance, timestamp, metadata, metadata_text, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run("scratch-1", "Raw temporary turn scratch.", "other", "agent:test", 0.2, 1, "{}", "", 1);
  insert.run("durable-1", "Project Phoenix uses uv run deploy.", "fact", "agent:test", 0.8, 2, "{}", "", 2);
  insert.run(
    "active-1",
    "Confirmed durable row.",
    "fact",
    "agent:test",
    0.9,
    3,
    JSON.stringify({
      l0_abstract: "Confirmed durable row.",
      l1_overview: "- Confirmed durable row.",
      l2_content: "Confirmed durable row.",
      memory_category: "cases",
      state: "confirmed",
      source: "manual",
      memory_layer: "durable",
      tier: "working",
      access_count: 0,
      confidence: 0.8,
      last_accessed_at: 3,
      valid_from: 3,
      injected_count: 0,
      bad_recall_count: 0,
      suppressed_until_turn: 0,
    }),
    "Confirmed durable row.",
    3,
  );
  db.close();
  return dbPath;
}

function runMigration(dbPath, args = []) {
  const result = spawnSync(
    process.execPath,
    ["scripts/migrate-legacy-hygiene.mjs", "--db", dbPath, ...args],
    {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("legacy hygiene migration is dry-run first and backup-backed on apply", () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-recall-openclaw-hygiene-"));
  const dbPath = createTruthDb(dir);

  try {
    const dry = runMigration(dbPath);
    assert.equal(dry.dry_run, true);
    assert.equal(dry.planned_archive_legacy_scratch, 1);
    assert.equal(dry.planned_normalize_durable_metadata, 1);

    let db = new DatabaseSync(dbPath);
    assert.equal(JSON.parse(db.prepare("SELECT metadata FROM memory_truth WHERE id = ?").get("scratch-1").metadata).state, undefined);
    db.close();

    const applied = runMigration(dbPath, ["--apply"]);
    assert.equal(applied.dry_run, false);
    assert.equal(applied.applied_archive_legacy_scratch, 1);
    assert.equal(applied.applied_normalize_durable_metadata, 1);
    assert.ok(applied.backup.endsWith(".sqlite3"));
    assert.equal(existsSync(applied.backup), true);

    db = new DatabaseSync(dbPath);
    const scratch = JSON.parse(db.prepare("SELECT metadata FROM memory_truth WHERE id = ?").get("scratch-1").metadata);
    const durable = JSON.parse(db.prepare("SELECT metadata FROM memory_truth WHERE id = ?").get("durable-1").metadata);
    const ftsRows = db.prepare("SELECT COUNT(*) AS count FROM memory_truth_fts").get().count;
    db.close();

    assert.equal(scratch.state, "archived");
    assert.equal(scratch.memory_layer, "archive");
    assert.equal(scratch.lifecycle, "archived");
    assert.equal(scratch.legacy_hygiene.action, "archive_legacy_scratch");
    assert.equal(durable.state, "confirmed");
    assert.equal(typeof durable.memory_layer, "string");
    assert.notEqual(durable.memory_layer.length, 0);
    assert.equal(durable.legacy_hygiene.action, "normalize_durable_metadata");
    assert.equal(ftsRows, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
