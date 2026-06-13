import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const {
  buildGovernanceReviewCandidates,
  isReviewConflict,
  semanticSimilarity,
} = jiti("../src/conflict-governance.ts");
const {
  buildSmartMetadata,
  isMemoryActiveAt,
  stringifySmartMetadata,
} = jiti("../src/smart-metadata.ts");

test("true deploy-command contradictions are review relations, not automatic supersession", () => {
  const existing = "Project Phoenix deploy command is uv run deploy.";
  const candidate = "Project Phoenix deploy command is not uv run deploy.";

  assert.ok(semanticSimilarity(existing, candidate) >= 0.35);
  assert.equal(isReviewConflict(existing, candidate), true);
});

test("negated same-topic different attribute is not a conflict", () => {
  const existing = "Project Phoenix deploy command is uv run deploy.";
  const candidate = "Project Phoenix deploy command is not documented in README.";

  assert.ok(semanticSimilarity(existing, candidate) >= 0.35);
  assert.equal(isReviewConflict(existing, candidate), false);
});

test("archived and inactive lifecycle rows are suppressed by default recall activity check", () => {
  assert.equal(isMemoryActiveAt({ valid_from: 1, state: "archived" }, Date.now()), false);
  const rejected = buildSmartMetadata({ text: "Rejected memory." }, { state: "rejected" });
  assert.equal(rejected.state, "rejected");
  assert.equal(isMemoryActiveAt(rejected, Date.now()), false);
  assert.equal(isMemoryActiveAt({ valid_from: 1, memory_layer: "archive" }, Date.now()), false);
  assert.equal(isMemoryActiveAt({ valid_from: 1, lifecycle: "rejected" }, Date.now()), false);
  assert.equal(isMemoryActiveAt({ valid_from: 1, lifecycle: "superseded" }, Date.now()), false);
  assert.equal(isMemoryActiveAt({ valid_from: 1, state: "confirmed", memory_layer: "durable" }, Date.now()), true);
});

test("governance scanner reports conflict, legacy, scratch, archived, and low-confidence candidates", () => {
  const now = Date.now();
  const entries = [
    {
      id: "conflict-id",
      text: "Project Phoenix deploy command is not uv run deploy.",
      vector: [],
      category: "fact",
      scope: "agent:main",
      importance: 0.7,
      timestamp: now,
      metadata: stringifySmartMetadata(buildSmartMetadata({ text: "x" }, {
        needs_conflict_review: true,
        conflict_review_ids: ["older-id"],
        relations: [{ type: "contradicts", targetId: "older-id" }],
      })),
    },
    {
      id: "legacy-id",
      text: "Legacy imported memory.",
      vector: [],
      category: "other",
      scope: "agent:main",
      importance: 0.3,
      timestamp: now,
      metadata: stringifySmartMetadata(buildSmartMetadata({ text: "x" }, {
        source: "legacy",
        confidence: 0.4,
      })),
    },
    {
      id: "archived-id",
      text: "Archived memory.",
      vector: [],
      category: "fact",
      scope: "agent:main",
      importance: 0.3,
      timestamp: now,
      metadata: stringifySmartMetadata(buildSmartMetadata({ text: "x" }, {
        state: "archived",
        memory_layer: "archive",
      })),
    },
  ];

  const candidates = buildGovernanceReviewCandidates(entries, { limit: 10 });
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  assert.ok(byId.get("conflict-id").reasons.includes("conflict_review"));
  assert.ok(byId.get("legacy-id").reasons.includes("legacy_metadata_review"));
  assert.ok(byId.get("legacy-id").reasons.includes("low_confidence"));
  assert.ok(byId.get("archived-id").reasons.includes("archive_review"));
});
