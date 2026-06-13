# scope-recall-openclaw

Scoped long-term memory for OpenClaw: SQLite truth, hybrid recall, conservative capture, and rebuildable vector indexes that can survive native dependency trouble.

## Core Guarantees

- Keeps SQLite as the durable source of truth.
- Treats vector indexes as rebuildable companions, never as the only copy.
- Retrieves through hybrid vector + BM25 search with optional reranking.
- Keeps capture conservative and rejects common secret-shaped text before persistence.
- Supports LanceDB for production vector retrieval and `sqlite-bruteforce` when native dependencies are unsafe.
- Supports hosted semantic embeddings and deterministic `local-hash` vectors for bootstrap, tests, and no-key availability.
- Exposes OpenClaw tools and operator commands through `openclaw scope-recall`.
- Keeps `openclaw memory-pro` as a compatibility alias for existing operators.

## Privacy Defaults

Public installs default to conservative behavior:

- `autoCapture` is off until an operator explicitly enables it.
- `smartExtraction` is off until an operator opts in to LLM-based extraction.
- `autoBackup` is off; daily JSONL memory exports are plaintext and should only be enabled deliberately.
- Hosted embeddings and reranking can send text to configured providers. Use `local-hash`, local endpoints, or disabled reranking for sensitive deployments.
- `memory_forget` requires `confirm: true` for deletion; query mode returns candidates first.

## Lineage

This plugin grew out of the earlier LanceDB Pro / `memory-lancedb-pro` memory work. That lineage is still visible in the rebuildable vector companion, SQL truth migration path, and the `openclaw memory-pro` compatibility alias.

It is no longer just a rename of that project. As OpenClaw's scoped-memory requirements matured, this package moved onto a different route: `scope-recall-openclaw` treats SQLite as the canonical truth layer, LanceDB as a disposable companion index, and OpenClaw hooks/tools as the primary runtime surface.

## Relationship to Hermes `scope-recall`

`scope-recall-openclaw` is the OpenClaw runtime port of the same storage philosophy used by the Hermes `scope-recall` plugin: SQLite truth first, rebuildable vector companion, hybrid retrieval, scoped recall, and conservative capture.

This package is not a one-for-one Hermes plugin copy. It is adapted to OpenClaw's plugin API, hooks, session model, and tool names. OpenClaw-specific capabilities include:

- OpenClaw dynamic tools: `memory_recall`, `memory_store`, `memory_forget`, and `memory_update`.
- Optional operator and inspection tools when enabled: `memory_stats`, `memory_debug`, `memory_list`, `memory_context`, `memory_inspect`, `memory_promote`, `memory_archive`, `memory_compact`, and `memory_explain_rank`.
- OpenClaw-native governance review with `memory_govern`, including conflict-review rows, legacy/working scratch rows, inactive lifecycle rows, archived rows, and low-confidence capture candidates.
- Dry-run-first SQLite hygiene migration via `scripts/migrate-legacy-hygiene.mjs` for archiving legacy scratch rows and normalizing missing durable metadata without deleting content.
- OpenClaw command aliases: `openclaw scope-recall` and compatibility alias `openclaw memory-pro`.
- OpenClaw session hooks for auto-recall, auto-capture, session memory, memory reflection, and self-improvement reminders; these high-impact paths are opt-in and should be enabled only for deployments that want durable memory-to-prompt behavior.

Hermes-only V1 surfaces such as entity probe/related/feedback tools, `scope_recall_benchmark`, nightly workflow digest, and Hermes-specific shared-durable/local-scratch scope semantics remain separate roadmap items until they have OpenClaw-native UX, tests, and operator documentation. Conflict handling now follows the Hermes 1.0.13 posture: contradictions are flagged for operator review and linked with `contradicts` metadata instead of automatically superseding older memories.

`memory_context`, `memory_inspect`, and `memory_govern` are OpenClaw-native inspection tools, not direct Hermes name copies. They are read-only management tools for checking accessible memory context, single-record lifecycle metadata, relations, source/state/layer filters, governance candidates, and scope boundaries before changing recall behavior.

## Storage Model

`memory.sqlite3` is the truth store. The default vector companion is LanceDB. Set `vectorBackend: "sqlite-bruteforce"` to use the native-free SQLite vector companion on hosts where LanceDB, PyArrow, or CPU-native dependencies are unsafe. Both vector backends are rebuildable from SQL truth with:

```bash
openclaw scope-recall repair-vectors --dry-run
openclaw scope-recall repair-vectors
```

Use `--limit <n>` for small test runs. When `--limit` is set, stale-vector pruning is disabled so partial repairs cannot delete unrelated vector rows.

Hosted embedding providers remain the recommended production path. If `embedding.provider` is `local-hash`, or if no hosted API key is configured, the plugin can generate deterministic local vectors with `hash-v1`. This keeps bootstrap, tests, and no-key availability working, but it is not a semantic-quality replacement for a real embedding model.

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

The release gate checks package/manifest version consistency, schema/UI config exposure for known runtime fields, compiled dist output, the vector repair smoke test, and the public npm pack file list.

## Public Release Staging

This plugin is usually developed inside a larger OpenClaw state directory. Do not publish from that root. Stage a clean release tree containing only public plugin files, then scan the staged tree before creating tags or pushing to GitHub.

## License

MIT
