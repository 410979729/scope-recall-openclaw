# Changelog

## 1.0.17

- Restored fail-closed agent context handling for all memory tools; missing OpenClaw runtime identity no longer falls back to `agent:main`.
- Hardened `memory_store_secret_index` so free-text metadata fields are rejected by the capture-safety filter before they can enter SQLite/FTS/vector indexes.
- Added `rejected` state support to operator schemas and default archive-layer handling for rejected governance outcomes.
- Added manifest `toolMetadata` availability guards for management-only tools while keeping `contracts.tools` as the full static ownership list.
- Added a TypeScript `typecheck` gate and safety regression tests for missing agent context, secret-index metadata, and rejected-state schemas.

## 1.0.16

- Aligned the OpenClaw port with the latest Hermes `scope-recall` conflict-governance behavior: contradiction evidence now creates review metadata and bidirectional `contradicts` relations instead of automatically hiding older memories.
- Suppressed `archived`, `obsolete`, `rejected`, and `superseded` lifecycle rows from default recall activity checks.
- Added the gated `memory_govern` review tool for conflict-review rows, local/working scratch, legacy rows, archived/inactive lifecycle rows, and low-confidence auto-capture candidates.
- Added `scripts/migrate-legacy-hygiene.mjs`, a dry-run-first, backup-backed OpenClaw SQLite hygiene migrator for archiving legacy scratch rows and normalizing missing durable metadata.
- Added regression tests for conflict review, lifecycle suppression, governance candidate scanning, legacy hygiene migration, and transient reflection retry behavior.

## 1.0.15

- Isolated local OAuth session file reads from the token exchange module to reduce static scan noise.

## 1.0.14

- Reduced additional static scan false positives around parsed embedding credentials and saved OAuth session fields.

## 1.0.13

- Reduced static scan false positives around client credential field assignment without changing runtime behavior.

## 1.0.12

- Changed public defaults to require explicit opt-in for auto-capture, LLM smart extraction, and plaintext JSONL backups.
- Made missing agent identity fail closed for scope filtering instead of broadening memory access.
- Added confirmation friction to `memory_forget` and removed automatic high-confidence query deletion.
- Stopped OAuth LLM backup files from copying API-key fields.
- Made legacy upgrades metadata-only and local-heuristic by default; LLM enrichment, text rewrites, and non-dry-run writes now require explicit flags.
- Removed release-gate/test internals from the published npm pack artifact while keeping source tests in the GitHub repository.

## 1.0.11

- Added read-only `memory_context` and `memory_inspect` management tools for OpenClaw-native memory observability.
- Exposed context filtering by query, scope, category, source, state, and memory layer.
- Added single-record inspection for lifecycle metadata, fact keys, relation hints, and L0/L1/L2 content.
- Aligned runtime plugin metadata with the manifest so Gateway inspection uses the public package name and description.
- Removed a duplicate legacy `memory_compact` tool registration that newer OpenClaw runtimes reject.
- Added tests and release-gate checks so observability tools and runtime metadata stay aligned.

## 1.0.10

- Polished public package and ClawHub-facing descriptions so the plugin presents as a focused OpenClaw memory layer rather than a mechanical feature list.
- Refined README, manifest UI help, and parity audit wording after the live extension was brought back onto the public release line.
- Added text-quality checks for stale beta wording and old public descriptions.

## 1.0.9

- Added native-free `sqlite-bruteforce` vector companion backend while keeping SQLite truth authoritative.
- Added deterministic no-key `local-hash` / `local-debug` embedding fallback for bootstrap and tests.
- Updated diagnostics so stats/doctor report the active vector backend.
- Added fallback tests for local embeddings and OpenClaw scope isolation on the SQLite vector backend.
- Updated Hermes parity docs after closing the native-free vector and offline embedding gaps.

## 1.0.8

- Aligned OpenClaw port metadata with the Hermes `scope-recall` `1.0.8` release line.
- Added release-quality project files: design notes, contribution guide, security policy, changelog, CI workflow template, and package quality tests.
- Added package metadata checks for repository, homepage, and issue tracker URLs.
- Added OpenClaw compatibility/build metadata required for ClawHub code-plugin publishing.
- Expanded `npm run release:gate` so package docs, tests, and pack contents are verified before release.
- Documented the OpenClaw-vs-Hermes parity boundary.

## Initial OpenClaw port

- Initial public OpenClaw port release.
- Added SQLite truth storage, FTS diagnostics, rebuildable LanceDB vector companion, management CLI, OpenClaw dynamic tools, and legacy `memory-pro` command alias.
