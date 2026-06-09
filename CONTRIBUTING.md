# Contributing

Thank you for improving `scope-recall-openclaw`.

## Development Rules

- Keep SQLite as the source of truth. LanceDB is a rebuildable companion index.
- Do not add a second memory truth store.
- Do not capture or log secrets.
- Keep OpenClaw-specific behavior in this repository instead of copying Hermes APIs wholesale.
- Keep release artifacts free of runtime state, backups, local credentials, and `node_modules`.

## Local Checks

Run the focused checks before opening a pull request:

```bash
npm install
npm test
npm run smoke:vector-repair
npm run release:gate
```

For live OpenClaw validation, use the target instance's own OpenClaw binary and home directory:

```bash
OPENCLAW_HOME=/path/to/state /path/to/openclaw scope-recall doctor --json --quiet
```

## Pull Request Checklist

- Package and manifest versions match.
- `npm test` passes.
- `npm run release:gate` passes.
- `npm pack --dry-run --json` contains only public plugin files.
- New capture, recall, repair, or migration behavior has a focused test or smoke check.
- Documentation is updated when behavior or operator commands change.
