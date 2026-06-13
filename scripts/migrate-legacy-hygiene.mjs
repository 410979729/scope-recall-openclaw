#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const {
  buildSmartMetadata,
  stringifySmartMetadata,
} = jiti("../src/smart-metadata.ts");

const SCRIPT_VERSION = "openclaw-legacy-hygiene-v1";

function parseArgs(argv) {
  const args = {
    db: "",
    dbPath: "",
    apply: false,
    noBackup: false,
    limit: 12,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--no-backup") {
      args.noBackup = true;
    } else if (arg === "--db") {
      args.db = argv[++i] ?? "";
    } else if (arg === "--db-path") {
      args.dbPath = argv[++i] ?? "";
    } else if (arg === "--limit") {
      args.limit = Number(argv[++i] ?? "12");
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/migrate-legacy-hygiene.mjs --db <memory.sqlite3> [--apply]

Archive legacy scratch rows and normalize missing durable metadata in the
scope-recall-openclaw SQLite truth store.

Options:
  --db <file>       Explicit memory.sqlite3 path
  --db-path <dir>   Store directory containing memory.sqlite3
  --apply           Apply changes. Default is dry-run
  --no-backup       Skip VACUUM INTO backup when applying
  --limit <n>       Max samples per category in JSON output
`);
}

function resolveDbPath(args) {
  const explicit = args.db || (args.dbPath ? join(args.dbPath, "memory.sqlite3") : "");
  if (!explicit) {
    throw new Error("Provide --db <memory.sqlite3> or --db-path <store directory>.");
  }
  return resolve(explicit);
}

function loadMetadata(raw) {
  if (raw && typeof raw === "object") return { ...raw };
  try {
    const parsed = JSON.parse(String(raw || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...parsed }
      : { raw_metadata: String(raw || "") };
  } catch {
    return { raw_metadata: String(raw || "") };
  }
}

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

function compactText(text, maxLen = 180) {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 3)}...`;
}

function metadataSearchText(metadata) {
  const values = [
    metadata.l0_abstract,
    metadata.l1_overview,
    metadata.l2_content,
    metadata.keywords,
    metadata.entities,
    metadata.tags,
    metadata.category,
    metadata.memory_category,
    metadata.tier,
    metadata.state,
    metadata.memory_layer,
  ];
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");
}

function isInactive(metadata) {
  return (
    lower(metadata.state) === "archived" ||
    lower(metadata.state) === "rejected" ||
    lower(metadata.memory_layer) === "archive" ||
    ["archived", "obsolete", "rejected", "superseded"].includes(lower(metadata.lifecycle))
  );
}

function isLegacyScratch(row, metadata) {
  if (isInactive(metadata)) return false;
  const category = lower(row.category);
  const source = lower(metadata.source);
  const layer = lower(metadata.memory_layer);
  const memoryCategory = lower(metadata.memory_category);

  if (category !== "other") return false;
  if (!metadata.memory_category || !metadata.state || !metadata.memory_layer) return true;
  return (
    layer === "working" &&
    (source === "legacy" || source === "auto-capture" || memoryCategory === "patterns")
  );
}

function missingDurableMetadata(row, metadata) {
  if (isLegacyScratch(row, metadata) || isInactive(metadata)) return false;
  return (
    !String(metadata.memory_category || "").trim() ||
    !String(metadata.state || "").trim() ||
    !String(metadata.memory_layer || "").trim() ||
    !String(metadata.l0_abstract || "").trim()
  );
}

function rowEntry(row, metadata) {
  return {
    id: row.id,
    text: row.text,
    category: row.category,
    scope: row.scope,
    importance: Number(row.importance) || 0,
    timestamp: Number(row.timestamp) || Date.now(),
    metadata: JSON.stringify(metadata),
  };
}

function sample(row) {
  return {
    id: row.id,
    category: row.category,
    scope: row.scope,
    preview: compactText(row.text),
  };
}

function buildArchiveMetadata(row, metadata, migratedAt) {
  const original = {};
  for (const key of ["memory_category", "state", "memory_layer", "source", "tier", "lifecycle"]) {
    if (metadata[key] !== undefined) original[key] = metadata[key];
  }
  return buildSmartMetadata(rowEntry(row, metadata), {
    ...metadata,
    state: "archived",
    memory_layer: "archive",
    lifecycle: "archived",
    source: metadata.source ?? "legacy",
    archive_reason: "legacy_hygiene",
    archived_at: Date.now(),
    legacy_hygiene: {
      action: "archive_legacy_scratch",
      version: SCRIPT_VERSION,
      migrated_at: migratedAt,
      original,
    },
  });
}

function buildNormalizeMetadata(row, metadata, migratedAt) {
  const original = {};
  for (const key of ["memory_category", "state", "memory_layer", "source", "tier", "lifecycle"]) {
    if (metadata[key] !== undefined) original[key] = metadata[key];
  }
  return buildSmartMetadata(rowEntry(row, metadata), {
    ...metadata,
    source: metadata.source ?? "legacy",
    legacy_hygiene: {
      action: "normalize_durable_metadata",
      version: SCRIPT_VERSION,
      migrated_at: migratedAt,
      original,
    },
  });
}

function plannedUpdates(rows, migratedAt) {
  const archive = [];
  const normalize = [];
  const archiveSamples = [];
  const normalizeSamples = [];

  for (const row of rows) {
    const metadata = loadMetadata(row.metadata);
    if (isLegacyScratch(row, metadata)) {
      const next = buildArchiveMetadata(row, metadata, migratedAt);
      archive.push({ id: row.id, metadata: next, text: row.text });
      archiveSamples.push(sample(row));
      continue;
    }
    if (missingDurableMetadata(row, metadata)) {
      const next = buildNormalizeMetadata(row, metadata, migratedAt);
      normalize.push({ id: row.id, metadata: next, text: row.text });
      normalizeSamples.push(sample(row));
    }
  }

  return { archive, normalize, archiveSamples, normalizeSamples };
}

function countRows(rows) {
  let legacyScratchRemaining = 0;
  let durableMissingMetadata = 0;
  let archivedRows = 0;
  for (const row of rows) {
    const metadata = loadMetadata(row.metadata);
    if (isLegacyScratch(row, metadata)) legacyScratchRemaining += 1;
    if (missingDurableMetadata(row, metadata)) durableMissingMetadata += 1;
    if (isInactive(metadata)) archivedRows += 1;
  }
  return {
    legacy_scratch_remaining: legacyScratchRemaining,
    durable_missing_metadata: durableMissingMetadata,
    archived_rows: archivedRows,
  };
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function backupSqlite(db, dbPath) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const backupDir = join(dirname(dbPath), "backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `memory.sqlite3.pre-legacy-hygiene.${stamp}.sqlite3`);
  db.exec(`VACUUM INTO ${sqlQuote(backupPath)}`);
  return backupPath;
}

function applyUpdates(db, updates) {
  const hasFts = Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_truth_fts'").get(),
  );
  const updateTruth = db.prepare(
    "UPDATE memory_truth SET metadata = ?, metadata_text = ?, updated_at = ? WHERE id = ?",
  );
  const deleteFts = hasFts
    ? db.prepare("DELETE FROM memory_truth_fts WHERE memory_id = ?")
    : null;
  const insertFts = hasFts
    ? db.prepare("INSERT INTO memory_truth_fts(memory_id, text, metadata_text) SELECT id, text, metadata_text FROM memory_truth WHERE id = ?")
    : null;

  const applyOne = (item) => {
    const metadataText = metadataSearchText(item.metadata);
    updateTruth.run(
      stringifySmartMetadata(item.metadata),
      metadataText,
      Date.now(),
      item.id,
    );
    deleteFts?.run(item.id);
    insertFts?.run(item.id);
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of updates.archive) applyOne(item);
    for (const item of updates.normalize) applyOne(item);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function loadRows(db) {
  return db.prepare(
    `
    SELECT id, text, category, scope, importance, timestamp, metadata, updated_at
    FROM memory_truth
    ORDER BY updated_at ASC, id ASC
    `,
  ).all();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = resolveDbPath(args);
  if (!existsSync(dbPath)) {
    throw new Error(`SQLite truth DB not found: ${dbPath}`);
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 30000");
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_truth'").get();
    if (!table) throw new Error(`memory_truth table not found in ${dbPath}`);

    const migratedAt = new Date().toISOString();
    const beforeRows = loadRows(db);
    const before = countRows(beforeRows);
    const updates = plannedUpdates(beforeRows, migratedAt);
    let backup = "";

    if (args.apply && (updates.archive.length || updates.normalize.length)) {
      if (!args.noBackup) backup = backupSqlite(db, dbPath);
      applyUpdates(db, updates);
    }

    const after = countRows(loadRows(db));
    const limit = Math.max(0, Math.floor(Number(args.limit) || 0));
    console.log(JSON.stringify({
      ok: true,
      dry_run: !args.apply,
      db: dbPath,
      backup,
      planned_archive_legacy_scratch: updates.archive.length,
      planned_normalize_durable_metadata: updates.normalize.length,
      applied_archive_legacy_scratch: args.apply ? updates.archive.length : 0,
      applied_normalize_durable_metadata: args.apply ? updates.normalize.length : 0,
      before,
      after,
      archive_samples: updates.archiveSamples.slice(0, limit),
      normalize_samples: updates.normalizeSamples.slice(0, limit),
    }, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
});
