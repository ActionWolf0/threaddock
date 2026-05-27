# Security Policy

ThreadDock is a local-first desktop application for managing Codex thread files. It should not require cloud storage, telemetry, or network listeners for core thread management.

## Supported versions

Security fixes target the latest published release and the `main` branch.

## Reporting a vulnerability

Use GitHub private vulnerability reporting or GitHub Security Advisories for the repository when available:

https://github.com/ActionWolf0/threaddock/security/advisories

If private reporting is not available yet, open a minimal public issue that says a vulnerability report is available, but do not include exploit details, secrets, recovery phrases, private rollout files, or backup artifacts.

## Sensitive data rules

- Do not include Codex rollout files, backup artifacts, handoff files, `.env` files, API keys, GitHub tokens, signing keys, or recovery phrases in issues or pull requests.
- Prefer dummy fixtures for tests and screenshots.
- Treat any token pasted into a chat, terminal, log, or issue as compromised and rotate it immediately.

## Security design expectations

- Destructive actions must remain explicit and guarded.
- Backup import must keep manifest and checksum verification before writes.
- Secure Handoff must stay file-based and encrypted; no LAN listener should be introduced without a separate threat model.
- Path handling must reject traversal and avoid writing outside the intended Codex home, archive, backup, handoff, or trash directories.
