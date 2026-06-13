import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { registerAllMemoryTools } = jiti("../src/tools.ts");
const { buildSecretIndex } = jiti("../src/secret-index.ts");

function fail(message) {
  throw new Error(message);
}

function createToolMap(toolCtx = {}) {
  const tools = new Map();
  const api = {
    registerTool(factory, meta) {
      tools.set(meta.name, factory(toolCtx));
    },
  };
  const context = {
    retriever: { retrieve: () => fail("retriever should not run without agent context") },
    store: {
      getById: () => fail("store should not run without agent context"),
      list: () => fail("store should not run without agent context"),
      patchMetadata: () => fail("store should not run without agent context"),
      store: () => fail("store should not run without agent context"),
      update: () => fail("store should not run without agent context"),
      vectorSearch: () => fail("store should not run without agent context"),
    },
    scopeManager: {
      getDefaultScope: () => fail("scope default should not run without agent context"),
      getScopeFilter: () => fail("scope filter should not run without agent context"),
      isAccessible: () => fail("scope access should not run without agent context"),
    },
    embedder: { embedPassage: () => fail("embedder should not run without agent context") },
  };
  registerAllMemoryTools(api, context, {
    enableManagementTools: true,
    enableSelfImprovementTools: false,
  });
  return tools;
}

test("core memory tools fail closed when OpenClaw agent context is missing", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const tools = createToolMap();
    const calls = [
      ["memory_recall", { query: "anything" }],
      ["memory_store", { text: "remember this" }],
      ["memory_store_secret_index", { label: "deploy credential", vaultRef: "op://infra/deploy/password" }],
      ["memory_forget", { query: "anything" }],
      ["memory_update", { memoryId: "memory-id", importance: 0.5 }],
    ];

    for (const [name, params] of calls) {
      const result = await tools.get(name).execute("test-call", params);
      assert.equal(result.details.error, "missing_agent_context", name);
    }
  } finally {
    console.warn = originalWarn;
  }
});

test("secret index rejects plaintext secrets in free-text metadata fields", () => {
  assert.throws(
    () => buildSecretIndex({
      label: "prod api key",
      vaultRef: "op://infra/prod-api-key/password",
      notes: "temporary value sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
    }),
    /secret index field 'notes' rejected/,
  );

  const safe = buildSecretIndex({
    label: "prod api key",
    vaultRef: "op://infra/prod-api-key/password",
    notes: "Stored in external vault only.",
    secretValue: "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
  });
  assert.match(safe.content, /Plaintext secret value: \[not stored/);
  assert.doesNotMatch(safe.content, /sk-proj-/);
});

test("operator schemas include rejected memory state", () => {
  const tools = createToolMap({ agentId: "audit-agent" });
  for (const name of ["memory_context", "memory_promote"]) {
    const stateSchema = tools.get(name).parameters.properties.state;
    const values = stateSchema.anyOf.map((item) => item.const);
    assert.ok(values.includes("rejected"), name);
  }
});

test("manifest declares all owned tools and marks management tools with config availability", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  assert.ok(manifest.contracts.tools.includes("memory_recall"));
  assert.ok(manifest.contracts.tools.includes("memory_govern"));
  assert.ok(manifest.contracts.tools.includes("self_improvement_review"));

  const governSignal = manifest.toolMetadata.memory_govern.configSignals[0];
  assert.equal(governSignal.rootPath, "plugins.entries.scope-recall-openclaw.config");
  assert.equal(governSignal.mode.path, "enableManagementTools");
  assert.deepEqual(governSignal.mode.allowed, ["true"]);
});
