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

const { MemoryStore } = jiti("../src/store.ts");
const { createScopeManager } = jiti("../src/scopes.ts");
const { registerAllMemoryTools } = jiti("../src/tools.ts");
const { buildSmartMetadata, stringifySmartMetadata } = jiti("../src/smart-metadata.ts");

function createMetadata(entry, patch) {
  return stringifySmartMetadata(buildSmartMetadata(entry, patch));
}

function createToolHarness(context) {
  const tools = new Map();
  const api = {
    registerTool(factory) {
      const tool = factory({ agentId: "main" });
      tools.set(tool.name, tool);
    },
  };

  registerAllMemoryTools(api, context, { enableManagementTools: true });
  return tools;
}

const inertRetriever = {
  async retrieve() {
    return [];
  },
  getConfig() {
    return { mode: "hybrid" };
  },
  getStatsCollector() {
    return null;
  },
};

const inertEmbedder = {
  async embedPassage() {
    return [1, 0, 0, 0];
  },
};

test("memory_context and memory_inspect expose read-only observability", async () => {
  const dbPath = await mkdtemp(path.join(tmpdir(), "scope-recall-observe-"));
  try {
    const store = new MemoryStore({
      dbPath,
      vectorDim: 4,
      vectorBackend: "sqlite-bruteforce",
    });
    const first = {
      id: "00000000-0000-4000-8000-000000000111",
      text: "Tianquan canary must pass before Scope Recall release pushes",
      vector: [1, 0, 0, 0],
      category: "decision",
      scope: "agent:main",
      importance: 0.95,
      timestamp: 111,
      metadata: createMetadata(
        {
          text: "Tianquan canary must pass before Scope Recall release pushes",
          category: "decision",
          importance: 0.95,
          timestamp: 111,
        },
        {
          l0_abstract: "Tianquan canary before release push",
          l1_overview: "- Test Scope Recall on Tianquan before pushing a release.",
          l2_content: "Tianquan canary must pass before Scope Recall release pushes.",
          source: "manual",
          state: "confirmed",
          memory_layer: "durable",
          tier: "core",
          fact_key: "events:tianquan-canary-release-gate",
        },
      ),
    };
    const second = {
      id: "00000000-0000-4000-8000-000000000222",
      text: "Scratch observation that should stay out of durable filtered context",
      vector: [0, 1, 0, 0],
      category: "other",
      scope: "agent:main",
      importance: 0.3,
      timestamp: 222,
      metadata: createMetadata(
        {
          text: "Scratch observation that should stay out of durable filtered context",
          category: "other",
          importance: 0.3,
          timestamp: 222,
        },
        {
          l0_abstract: "Scratch observation",
          source: "auto-capture",
          state: "pending",
          memory_layer: "working",
          tier: "working",
        },
      ),
    };

    await store.importEntry(first);
    await store.importEntry(second);

    const tools = createToolHarness({
      store,
      retriever: inertRetriever,
      scopeManager: createScopeManager(),
      embedder: inertEmbedder,
      agentId: "main",
    });

    assert.ok(tools.has("memory_context"), "memory_context must be registered");
    assert.ok(tools.has("memory_inspect"), "memory_inspect must be registered");

    const contextResult = await tools.get("memory_context").execute(
      "test-context",
      { source: "manual", layer: "durable", limit: 5 },
      undefined,
      undefined,
      { agentId: "main" },
    );
    assert.equal(contextResult.details.count, 1);
    assert.equal(contextResult.details.memories[0].id, first.id);
    assert.equal(contextResult.details.memories[0].factKey, "events:tianquan-canary-release-gate");
    assert.match(contextResult.content[0].text, /Tianquan canary before release push/);

    const inspectResult = await tools.get("memory_inspect").execute(
      "test-inspect",
      { memoryId: first.id, includeFullText: true },
      undefined,
      undefined,
      { agentId: "main" },
    );
    assert.equal(inspectResult.details.memory.id, first.id);
    assert.equal(inspectResult.details.memory.layer, "durable");
    assert.equal(inspectResult.details.memory.source, "manual");
    assert.match(inspectResult.content[0].text, /factKey=events:tianquan-canary-release-gate/);

    const denied = await tools.get("memory_context").execute(
      "test-deny",
      { scope: "agent:other" },
      undefined,
      undefined,
      { agentId: "main" },
    );
    assert.equal(denied.details.error, "scope_access_denied");
  } finally {
    await rm(dbPath, { recursive: true, force: true });
  }
});
