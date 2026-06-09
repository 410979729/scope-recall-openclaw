# Hermes Parity Audit - 2026-06-09

This audit compares the public OpenClaw package tree against Joy's current
Yuheng Hermes `scope-recall` plugin. It is a release-quality checklist, not a
claim that every Hermes surface should be copied into OpenClaw unchanged.

## Evidence Checked

- OpenClaw public package checkout: `scope-recall-openclaw` after the
  native-free vector and local embedding fallback implementation, package
  version `1.0.11` as the Tianquan canary candidate for read-only
  observability tools.
- OpenClaw live extension directory:
  `/home/a/openclaw-tianji/home/state/extensions/scope-recall-openclaw`, brought
  back onto the public release line after previously reporting a live-only beta
  version.
- Yuheng Hermes plugin:
  `/home/a/.hermes-yuheng/plugins/scope-recall`, plugin version `1.0.9`.
- OpenClaw live doctor on 2026-06-09: SQL truth `404/404`, FTS `404/404`,
  vector companion `404/404`, no missing or stale vector rows.

## Current OpenClaw Strengths

- SQLite truth store with FTS diagnostics.
- Rebuildable LanceDB vector companion.
- Hybrid vector plus BM25 retrieval.
- Dynamic OpenClaw memory tools:
  `memory_recall`, `memory_store`, `memory_forget`, and `memory_update`.
- Optional operator and inspection tools:
  `memory_stats`, `memory_debug`, `memory_list`, `memory_context`,
  `memory_inspect`, `memory_promote`, `memory_archive`, `memory_compact`,
  and `memory_explain_rank`.
- OpenClaw session hooks for auto recall, auto capture, memory reflection,
  session recovery, and self-improvement review.
- Release package hygiene: docs, security policy, contribution guide, package
  quality tests, `npm test`, `release:gate`, and npm pack inspection.

## High-Priority Gaps Before Release-Quality Parity

### P0 - Source And Release Alignment

This gap was closed before the 1.0.10 polish pass: the public package tree,
ClawHub artifact, and live extension are expected to stay on the same release
line. Any live-only experiment must use a clearly marked prerelease version and
must not be cited as public package evidence.

Release-quality rule:

- public release tree, ClawHub artifact, live extension, and docs must identify
  the same intended version line;
- local live-only experiments must not be mistaken for public release evidence;
- CLI and gateway version mismatch warnings must be recorded separately from
  plugin health.

### P0 - Native-Free Vector Fallback

Hermes `scope-recall` `1.0.9` added `sqlite-bruteforce`, a pure SQLite vector
companion for hosts where LanceDB/PyArrow/native CPU features are unsafe.

OpenClaw now ships an equivalent `sqlite-bruteforce` backend in the public
package tree. LanceDB remains the recommended production backend; the SQLite
backend is the native-free compatibility path.

Acceptance criteria:

- `configSchema` supports a vector backend choice, at least `lancedb` and
  `sqlite-bruteforce`.
- SQLite truth remains authoritative for both backends.
- doctor/stats report the active vector backend and repair status.
- release gate covers native-free startup and vector repair.

### P1 - Offline Embedding Fallback

Hermes has a deterministic `local-hash` fallback embedder for no-key bootstrap
and offline availability. OpenClaw now supports `local-hash` / `local-debug`
and no longer makes `embedding.apiKey` universally required.

Acceptance criteria:

- support a deterministic local fallback embedder for bootstrap and tests;
- clearly label it as an availability fallback, not a semantic-quality mode;
- keep hosted embedding as the recommended production path;
- expose fallback status in stats/doctor output.

### P1 - Tool Surface And Observability

Hermes V1 exposes these stable tools beyond OpenClaw's current memory tool set:

- context and entity tools:
  `scope_recall_context`, `scope_recall_probe`, `scope_recall_related`,
  `scope_recall_feedback`;
- operator/governance tools:
  `scope_recall_dedupe`, `scope_recall_merge`, `scope_recall_export`,
  `scope_recall_govern`, `scope_recall_hygiene`, `scope_recall_repair`;
- observability tools:
  `scope_recall_inspect`, `scope_recall_explain`, `scope_recall_benchmark`.

OpenClaw should not copy those names blindly. It should provide equivalent
OpenClaw-native surfaces where useful, with management operations gated and
documented.

OpenClaw now has the first read-only observability slice:

- `memory_context` lists accessible context with query/scope/category plus
  source/state/layer filters.
- `memory_inspect` inspects one memory by id, prefix, or query and returns
  lifecycle metadata, fact keys, relation hints, and L0/L1/L2 content when
  requested.

Remaining work in this P1 group: feedback tooling, entity graph lookup,
operator export/governance flows, and benchmark-style recall checks.

### P1 - Stable Shared-Durable / Local-Scratch Scope Contract

Hermes V1 has a documented split:

- durable `user`, `memory`, `project`, and `ops` rows are shared for the same
  platform plus workspace plus agent identity plus user id;
- raw `general` scratch rows stay inside the current chat/thread/session scope.

OpenClaw currently has agent/global/reflection/custom/project/user scope
primitives, and the live store only shows `agent:main` rows. Before claiming
Hermes-level scope parity, OpenClaw needs tests that prove no group/thread/user
scratch bleed occurs under its own runtime context model.

### P2 - Nightly Workflow Digest

Hermes includes `scripts/nightly-digest.py` for sanitized workflow extraction
from session history. OpenClaw has session reflection and self-improvement
tools, but does not yet ship the same daily digest pipeline.

This is not a runtime blocker, but it is a product-quality gap for long-lived
agents.

### P2 - Entity Graph And Feedback Quality

Hermes has SQLite graph tables and tests for entity extraction, related lookup,
feedback, trust priors, and contradiction relations. OpenClaw has relation
metadata in smart extraction, but not the same first-class entity/feedback
tooling or graph inspection path.

This should be implemented only after the scope contract is settled.

## Recommended Implementation Order

1. Reconcile public release tree versus live extension version and decide the
   next public version target.
2. Add native-free vector backend support and doctor/stats coverage.
3. Add explicit offline/degraded embedding fallback.
4. Add scope-isolation tests for OpenClaw's runtime context model.
5. Extend the OpenClaw-native context/inspect slice into probe, feedback,
   export/governance, and benchmark tooling.
6. Add nightly digest or an OpenClaw-native equivalent.

## Non-Goals

- Do not copy Hermes Python files into the OpenClaw plugin.
- Do not rename OpenClaw dynamic tools to Hermes tool names unless OpenClaw's
  tool UX actually benefits.
- Do not claim full parity while the vector backend, fallback embedder, scope
  contract, and observability tools are still incomplete.
