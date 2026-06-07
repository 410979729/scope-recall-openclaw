import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { MemoryStore } = jiti("../src/store.ts");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const dbPath = await mkdtemp(join(tmpdir(), "scope-recall-vector-repair-"));

try {
  const store = new MemoryStore({ dbPath, vectorDim: 4 });
  const fakeEmbedder = {
    async embedPassage(text) {
      return [text.length, 1, 0, 0];
    },
    async embedBatchPassage(texts) {
      return texts.map((text) => [text.length, 1, 0, 0]);
    },
  };

  await store.importEntry({
    id: "00000000-0000-4000-8000-000000000001",
    text: "alpha memory",
    vector: [1, 0, 0, 0],
    category: "fact",
    scope: "agent:test",
    importance: 0.8,
    timestamp: 1,
    metadata: "{}",
  });
  await store.importEntry({
    id: "00000000-0000-4000-8000-000000000002",
    text: "beta memory",
    vector: [0, 1, 0, 0],
    category: "decision",
    scope: "agent:test",
    importance: 0.7,
    timestamp: 2,
    metadata: "{}",
  });

  const dry = await store.rebuildVectorCompanion(fakeEmbedder, {
    dryRun: true,
    batchSize: 1,
  });
  assert(dry.dryRun === true, "dry run flag was not preserved");
  assert(dry.processed === 2, `dry run processed ${dry.processed}, expected 2`);
  assert(dry.rebuilt === 2, `dry run rebuild count ${dry.rebuilt}, expected 2`);
  assert(dry.errors.length === 0, `dry run errors: ${dry.errors.join("; ")}`);

  const result = await store.rebuildVectorCompanion(fakeEmbedder, {
    batchSize: 1,
  });
  assert(result.processed === 2, `processed ${result.processed}, expected 2`);
  assert(result.rebuilt === 2, `rebuilt ${result.rebuilt}, expected 2`);
  assert(result.skipped === 0, `skipped ${result.skipped}, expected 0`);
  assert(result.errors.length === 0, `repair errors: ${result.errors.join("; ")}`);

  const stats = await store.stats(["agent:test"]);
  assert(stats.totalCount === 2, `SQL truth count ${stats.totalCount}, expected 2`);

  const diagnostics = store.getDiagnostics();
  assert(diagnostics.sqlTruth.available === true, "SQL truth diagnostics unavailable");
  assert(diagnostics.sqlTruth.fts?.healthy === true, "SQL truth FTS is not healthy");
  assert(diagnostics.vectorCompanion.needsRepair === false, "vector companion still needs repair");

  console.log("smoke:vector-repair ok");
} finally {
  await rm(dbPath, { recursive: true, force: true });
}
