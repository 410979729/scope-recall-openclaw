# Changelog

## 1.0.9

- Added native-free `sqlite-bruteforce` vector companion backend while keeping SQLite truth authoritative.
- Added degraded no-key `local-hash` / `local-debug` embedding fallback for bootstrap and tests.
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
