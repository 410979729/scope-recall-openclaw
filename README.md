# scope-recall-openclaw

OpenClaw scope recall memory layer backed by SQLite SQL truth, FTS, and a rebuildable vector companion.

## What It Does

- Stores long-term memories with scope isolation.
- Retrieves by hybrid vector + BM25 search.
- Keeps SQLite as the authoritative truth layer.
- Treats vectors as a rebuildable companion index.
- Supports a production LanceDB vector backend and a native-free `sqlite-bruteforce` fallback.
- Supports hosted semantic embeddings and a degraded no-key `local-hash` fallback.
- Provides management commands through `openclaw scope-recall`.
- Keeps `openclaw memory-pro` as a legacy command alias for existing operators.

## Lineage

This plugin grew out of the earlier LanceDB Pro / `memory-lancedb-pro` memory work. That lineage is still visible in the rebuildable LanceDB vector companion, SQL truth migration path, and the legacy `openclaw memory-pro` command alias.

It is no longer just a rename of that project. As OpenClaw's scoped-memory requirements matured, this package moved onto a different route: `scope-recall-openclaw` treats SQLite as the canonical truth layer, LanceDB as a disposable companion index, and OpenClaw hooks/tools as the primary runtime surface.

## Relationship to Hermes `scope-recall`

`scope-recall-openclaw` is the OpenClaw runtime port of the same storage philosophy used by the Hermes `scope-recall` plugin: SQLite truth first, rebuildable vector companion, hybrid retrieval, scoped recall, and conservative capture.

This package is not a one-for-one Hermes plugin copy. It is adapted to OpenClaw's plugin API, hooks, session model, and tool names. OpenClaw-specific capabilities include:

- OpenClaw dynamic tools: `memory_recall`, `memory_store`, `memory_forget`, and `memory_update`.
- Optional management/debug tools when enabled: `memory_stats`, `memory_debug`, `memory_list`, `memory_promote`, `memory_archive`, `memory_compact`, and `memory_explain_rank`.
- OpenClaw command aliases: `openclaw scope-recall` and legacy `openclaw memory-pro`.
- OpenClaw session hooks for auto-recall, auto-capture, session memory, memory reflection, and self-improvement reminders.

Hermes-only V1 surfaces such as `scope_recall_context`, entity probe/related/feedback tools, `scope_recall_inspect`, `scope_recall_explain`, `scope_recall_benchmark`, nightly workflow digest, and Hermes-specific shared-durable/local-scratch scope semantics are not claimed as complete parity in this OpenClaw package. They are separate roadmap items if OpenClaw needs the same user-facing surface later.

## Storage Model

`memory.sqlite3` is the truth store. The default vector companion is LanceDB. Set `vectorBackend: "sqlite-bruteforce"` to use the native-free SQLite vector companion on hosts where LanceDB, PyArrow, or CPU-native dependencies are unsafe. Both vector backends are rebuildable from SQL truth with:

```bash
openclaw scope-recall repair-vectors --dry-run
openclaw scope-recall repair-vectors
```

Use `--limit <n>` for small test runs. When `--limit` is set, stale-vector pruning is disabled so partial repairs cannot delete unrelated vector rows.

Hosted embedding providers remain the recommended production path. If `embedding.provider` is `local-hash`, or if no hosted API key is configured, the plugin can generate deterministic local vectors with `hash-v1`. This mode is meant for bootstrap, tests, and degraded offline availability; it is not a semantic-quality replacement for a real embedding model.

## Diagnostics

```bash
openclaw scope-recall stats
openclaw scope-recall stats --json
openclaw scope-recall stats --json --quiet
openclaw scope-recall doctor
openclaw scope-recall doctor --json
openclaw scope-recall doctor --json --quiet
```

The stats command reports SQL truth availability, SQLite row count, FTS integrity, and whether the vector companion needs repair. The doctor command is read-only and adds scope distribution checks, SQL-vs-vector scope comparison, configured vector dimensions, missing/stale vector row counts, and a repair hint. Use `--json --quiet` when automation needs JSON written directly to stdout through the OpenClaw CLI wrapper.

## Legacy Compatibility

This project was previously named `memory-lancedb-pro`. Existing databases can be reused by pointing `dbPath` at the old data directory. The old `openclaw memory-pro` command remains available as an alias while new docs and releases use `openclaw scope-recall`.

## Smoke Test

```bash
npm run smoke:vector-repair
npm run release:gate
```

The smoke test creates a temporary database, writes two SQL-truth memories, dry-runs vector repair, rebuilds the vector companion with a fake embedder, verifies diagnostics, and deletes the temp database.

The release gate checks package/manifest version consistency, schema/UI config exposure for known runtime fields, dist wrapper importability, the vector repair smoke test, and the public npm pack file list.

## Public Release Staging

This plugin is usually developed inside a larger OpenClaw state directory. Do not publish from that root. Stage a clean release tree containing only public plugin files, then scan the staged tree before creating tags or pushing to GitHub.

## License

MIT
