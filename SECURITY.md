# Security Policy

## Supported Versions

The active beta line is `1.1.x`. Security fixes should target the latest beta unless a maintainer explicitly opens a backport branch.

## Reporting A Vulnerability

Please report vulnerabilities through GitHub issues only when the report does not contain secrets, live credentials, private logs, or exploitable payloads. For sensitive reports, contact the maintainer privately and provide a redacted reproduction first.

Do not paste API keys, bearer tokens, OpenClaw gateway tokens, database passwords, private logs, or complete `.env` files into public issues.

## Secret Handling Expectations

`scope-recall-openclaw` must not persist credential-like content as memory. Capture safety blocks common token, bearer, password, and credentialed URL patterns before storage. If you find a secret pattern that is not blocked, treat it as a security bug.

Release packages must not contain:

- `.env` files
- SQLite databases
- LanceDB vector stores
- logs
- `node_modules/`
- backups or temporary state

Run this before publishing:

```bash
npm test
npm run release:gate
npm pack --dry-run --json
```
