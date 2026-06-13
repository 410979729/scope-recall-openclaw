# OpenClaw And Hermes Parity Roadmap

`scope-recall-openclaw` and Hermes `scope-recall` share the same memory philosophy, but they live in different runtimes. This document prevents accidental over-claiming and gives maintainers a concrete parity map.

## Current OpenClaw Strengths

- OpenClaw dynamic memory tools.
- OpenClaw CLI commands with `scope-recall` and `memory-pro` aliases.
- SQLite truth plus FTS diagnostics.
- Rebuildable LanceDB vector companion.
- Native-free `sqlite-bruteforce` vector companion fallback.
- Degraded no-key `local-hash` embedding fallback.
- Read-only OpenClaw inspection tools: `memory_context` and `memory_inspect`.
- OpenClaw-native `memory_govern` review candidates for conflict-review rows,
  local/working scratch, legacy rows, inactive lifecycle rows, archived rows,
  and low-confidence auto-capture candidates.
- Dry-run-first `scripts/migrate-legacy-hygiene.mjs` for backup-backed SQLite
  hygiene migration of legacy scratch and missing durable metadata.
- Hermes 1.0.13-style conflict posture: contradiction evidence is linked for
  review and does not automatically hide older memories.
- Capture safety for common secret patterns.
- Auto-recall, auto-capture, session reflection, and self-improvement hooks for OpenClaw sessions.
- Release gate for manifest/package consistency and package hygiene.

## Hermes-Only Surfaces Not Yet Claimed

These are roadmap candidates, not current OpenClaw guarantees:

- Entity probe, related entity, and feedback tools.
- Benchmark-style recall checks and broader export flows.
- Nightly workflow digest.
- Hermes-specific shared durable versus local scratch scope semantics.
- Hermes memory-provider packaging through `pyproject.toml` and `plugin.yaml`.

For the current gap analysis against Yuheng's Hermes `scope-recall` `1.0.9`,
see [`hermes-parity-audit-2026-06-09.md`](hermes-parity-audit-2026-06-09.md).

## Promotion Criteria

Before claiming first-class parity with Hermes `scope-recall`, the OpenClaw package should have:

- User-facing docs for every supported tool and command.
- Tests for package metadata, capture safety, CLI registration, vector repair, and migration.
- CI that runs tests and release gate on every push and pull request.
- A signed-off package tarball inspection showing no `node_modules`, databases, logs, backups, or credentials.
- Live doctor output showing SQL truth, FTS, and vector companion are healthy on at least one OpenClaw instance.
- Native-free vector fallback tests for hosts where LanceDB cannot load safely.
- Documented degraded/offline embedding fallback tests.
- Scope-isolation tests that prove local scratch rows do not bleed between OpenClaw chats, threads, users, or agent identities.

## Non-Goals

- Do not copy Hermes implementation files directly into OpenClaw.
- Do not preserve API names that do not map cleanly to OpenClaw.
- Do not trade current runtime stability for superficial file-count parity.
