# Scope Recall OpenClaw Design

`scope-recall-openclaw` is the OpenClaw runtime port of the scope-recall storage model. It keeps long-term memory auditable by separating the durable truth store from the semantic retrieval companion.

## Goals

- Keep SQLite as the canonical truth layer.
- Treat LanceDB as a rebuildable vector companion.
- Support OpenClaw dynamic tools and CLI commands without depending on Hermes plugin APIs.
- Fail open on recall and fail closed on unsafe capture.
- Keep release packages small, public, and free of runtime state.

## Runtime Shape

The plugin entrypoint is `dist/index.js`. That wrapper loads `index.ts` through `jiti`, so the published package can keep TypeScript source available while remaining loadable by OpenClaw's JavaScript plugin runtime.

OpenClaw integration surfaces:

- Dynamic tools: `memory_recall`, `memory_store`, `memory_forget`, `memory_update`.
- Optional management tools for stats, debug, listing, compaction, and rank explanation.
- CLI commands: `openclaw scope-recall` and legacy alias `openclaw memory-pro`.
- Session hooks for auto-recall, auto-capture, reflection, session recovery, and self-improvement review.

## Storage Layers

SQLite stores the authoritative memory rows, categories, metadata, FTS rows, and audit-friendly state. LanceDB stores vector rows derived from SQLite. If LanceDB is stale, missing, or dimension-mismatched, operators should rebuild it from SQL truth rather than treat it as a second source of truth.

The intended repair loop is:

```bash
openclaw scope-recall doctor --json --quiet
openclaw scope-recall repair-vectors --dry-run
openclaw scope-recall repair-vectors
openclaw scope-recall doctor --json --quiet
```

## Capture Safety

Capture is conservative. Secret-like text, credentialed URLs, bearer tokens, and password assignments are rejected before persistence. Recall failures should not block the main model response; unsafe write paths should stop before touching SQL truth.

## Package Boundary

The repository is a source and release package, not a live OpenClaw state dump. `npm pack` must include source, docs, manifest, scripts, tests, and the dist wrapper, but must exclude:

- `node_modules/`
- `.git/`
- databases and vector stores
- logs
- backups and temporary directories
- local `.env` files

`npm run release:gate` enforces the most important packaging and registration checks.

## Relationship To Hermes Scope Recall

This plugin shares the storage philosophy of Hermes `scope-recall`, but it is not a direct file copy. OpenClaw has different plugin APIs, command registration, dynamic tools, and session hooks. Hermes-only user-facing surfaces are tracked in `docs/parity-roadmap.md` instead of being claimed as complete parity.
