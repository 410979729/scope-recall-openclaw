import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { createEmbedder, getVectorDimensions } = jiti("../src/embedder.ts");
const { parsePluginConfig } = jiti("../index.ts");
const { MemoryStore } = jiti("../src/store.ts");
const pluginEntry = (await import("../dist/index.js")).default;

test("local-hash embedder works without hosted API credentials", async () => {
  const parsed = parsePluginConfig({ embedding: {} });
  assert.equal(parsed.embedding.provider, "local-hash");
  assert.equal(parsed.embedding.model, "hash-v1");
  assert.equal(getVectorDimensions("hash-v1"), 256);

  const embedder = createEmbedder(parsed.embedding);
  const first = await embedder.embedPassage("Joy likes carefully verified plugin releases");
  const second = await embedder.embedPassage("Joy likes carefully verified plugin releases");

  assert.equal(first.length, 256);
  assert.deepEqual(first, second);
  assert.equal((await embedder.test()).success, true);
});

test("sqlite-bruteforce vector backend preserves scope isolation", async () => {
  const dbPath = await mkdtemp(path.join(tmpdir(), "scope-recall-sqlite-vector-"));
  try {
    const store = new MemoryStore({
      dbPath,
      vectorDim: 4,
      vectorBackend: "sqlite-bruteforce",
    });

    await store.importEntry({
      id: "00000000-0000-4000-8000-000000000101",
      text: "alpha chat A memory",
      vector: [1, 0, 0, 0],
      category: "fact",
      scope: "chat:a",
      importance: 0.8,
      timestamp: 101,
      metadata: "{}",
    });
    await store.importEntry({
      id: "00000000-0000-4000-8000-000000000202",
      text: "alpha chat B memory",
      vector: [1, 0, 0, 0],
      category: "fact",
      scope: "chat:b",
      importance: 0.8,
      timestamp: 202,
      metadata: "{}",
    });

    const scoped = await store.vectorSearch([1, 0, 0, 0], 5, 0.1, ["chat:a"]);
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].entry.scope, "chat:a");
    assert.equal(scoped[0].entry.id, "00000000-0000-4000-8000-000000000101");

    const denied = await store.vectorSearch([1, 0, 0, 0], 5, 0.1, []);
    assert.deepEqual(denied, []);

    const diagnostics = store.getDiagnostics();
    assert.equal(diagnostics.sqlTruth.available, true);
    assert.equal(diagnostics.vectorCompanion.backend, "sqlite-bruteforce");
    assert.equal(diagnostics.vectorCompanion.needsRepair, false);

    const drift = await store.getVectorCompanionDriftReport();
    assert.equal(drift.truthCount, 2);
    assert.equal(drift.vectorRows, 2);
    assert.equal(drift.missingVectorRows, 0);
    assert.equal(drift.staleVectorRows, 0);
  } finally {
    await rm(dbPath, { recursive: true, force: true });
  }
});

test("plugin registers with local-hash and sqlite-bruteforce fallback config", async () => {
  const dbPath = await mkdtemp(path.join(tmpdir(), "scope-recall-register-local-"));
  let registeredCli = false;
  try {
    pluginEntry.register({
      pluginConfig: {
        embedding: { provider: "local-hash" },
        vectorBackend: "sqlite-bruteforce",
        smartExtraction: false,
        dbPath,
      },
      registrationMode: "cli-metadata",
      resolvePath: (value) => value,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      registerCli(cli, options) {
        registeredCli =
          Boolean(cli) &&
          Array.isArray(options?.commands) &&
          options.commands.includes("scope-recall");
      },
    });
    assert.equal(registeredCli, true);
  } finally {
    await rm(dbPath, { recursive: true, force: true });
  }
});
