# OpenClaw And Hermes Parity Roadmap

`scope-recall-openclaw` and Hermes `scope-recall` share the same memory philosophy, but they live in different runtimes. This document prevents accidental over-claiming and gives maintainers a concrete parity map.

## Current OpenClaw Strengths

- OpenClaw dynamic memory tools.
- OpenClaw CLI commands with `scope-recall` and `memory-pro` aliases.
- SQLite truth plus FTS diagnostics.
- Rebuildable LanceDB vector companion.
- Capture safety for common secret patterns.
- Auto-recall, auto-capture, session reflection, and self-improvement hooks for OpenClaw sessions.
- Release gate for manifest/package consistency and package hygiene.

## Hermes-Only Surfaces Not Yet Claimed

These are roadmap candidates, not current OpenClaw guarantees:

- `scope_recall_context`.
- Entity probe, related entity, and feedback tools.
- `scope_recall_inspect`, `scope_recall_explain`, and `scope_recall_benchmark`.
- Nightly workflow digest.
- Hermes-specific shared durable versus local scratch scope semantics.
- Hermes memory-provider packaging through `pyproject.toml` and `plugin.yaml`.

## Promotion Criteria

Before claiming first-class parity with Hermes `scope-recall`, the OpenClaw package should have:

- User-facing docs for every supported tool and command.
- Tests for package metadata, capture safety, CLI registration, vector repair, and migration.
- CI that runs tests and release gate on every push and pull request.
- A signed-off package tarball inspection showing no `node_modules`, databases, logs, backups, or credentials.
- Live doctor output showing SQL truth, FTS, and vector companion are healthy on at least one OpenClaw instance.

## Non-Goals

- Do not copy Hermes implementation files directly into OpenClaw.
- Do not preserve API names that do not map cleanly to OpenClaw.
- Do not trade current runtime stability for superficial file-count parity.
