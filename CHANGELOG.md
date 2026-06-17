# Changelog

## 1.0.21

- Fixed smart-extractor and reflection-store to sanitize attachment markers before persisting to store
- Previously these paths called `evaluateCaptureSafety()` for safety check but stored the original unsanitized text
- Now all ingestion paths (auto-capture, memory_store, smart-extractor, reflection-store) consistently sanitize before storage

## 1.0.20

- Added `sanitizeCaptureText()` to strip gateway image attachment markers and local `image_cache/img_*` paths before journal/capture storage, preventing local cache paths from leaking into durable memories.
- Added `isTrivial()` filter so short acknowledgements like "Understood.", "Noted.", "好的", "收到" are rejected before entering the journal, matching Hermes scope-recall v1.1.1 behavior.
- `evaluateCaptureSafety()` now sanitizes attachment markers and checks triviality before other safety gates.
- `normalizeAutoCaptureText()` and `memory_store` now persist sanitized text, ensuring attachment markers never reach SQLite/vector storage.
- Added regression tests for attachment sanitization, trivial ACK filtering, and end-to-end capture safety with markers.

- Added `sanitizeCaptureText()` to strip gateway image attachment markers and local `image_cache/img_*` paths before journal/capture storage, preventing local cache paths from leaking into durable memories.
- Added `isTrivial()` filter so short acknowledgements like "Understood.", "Noted.", "好的", "收到" are rejected before entering the journal, matching Hermes scope-recall v1.1.1 behavior.
- `evaluateCaptureSafety()` now sanitizes attachment markers and checks triviality before other safety gates.
- `normalizeAutoCaptureText()` and `memory_store` now persist sanitized text, ensuring attachment markers never reach SQLite/vector storage.
- Added regression tests for attachment sanitization, trivial ACK filtering, and end-to-end capture safety with markers.

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
