# ThreadDock

ThreadDock is a local-first desktop control room for Codex threads. It is built to manage large Codex histories across Windows, macOS, and Linux without forcing users to work directly in raw rollout files.

## Current v1 scope

- Active thread library with search, pagination, workspace/date filters, and sorting
- Archived thread vault with the same filtering and bulk workflows
- Subagent family view with parent-aware grouping, family archive/unarchive, and family backup export
- Exact rollout-size reporting per thread and aggregated family storage
- Health view for largest threads/families, malformed rollouts, missing rollouts, orphaned families, and App Server status
- Portable backup artifacts as either `.threaddock-backup.zip` bundles or plain-folder exports with manifest metadata and SHA-256 verification
- Backup history library with artifact inspection, verified preview, and guarded restore/import
- Secure Handoff `.threaddock-handoff` files for private computer-to-computer migration without LAN listeners or cloud services
- Backup Health Score for last-backup age, verified artifacts, warnings, and largest unbacked threads
- Restore Wizard preview for OS differences and Windows/macOS/Linux path remapping before import
- Update Center for the installed version, latest GitHub release, changelog, and safe update instructions
- 30-day guarded trash for thread deletion with restore and permanent purge controls
- Persistent activity log for archive, restore, import, trash, purge, and backup operations
- Settings surface for detected Codex home, custom Codex-home overrides, read-only external archive paths, default backup directory, export format, and release repository

## Stack

- Tauri 2
- React 19 + TypeScript + Vite
- Rust backend for Codex indexing, App Server integration, backup packaging, a rebuildable SQLite cache, and OS file reveal actions

## Development

Requirements:

- Node.js 20+
- Rust toolchain
- Codex CLI available on `PATH`

Run the desktop app:

```bash
cd apps/desktop
npm install
npm run tauri dev
```

Run the browser-preview development surface:

```bash
cd apps/desktop
npm run dev
```

Build and verify:

```bash
cd apps/desktop
npm run build
npm audit --audit-level=moderate
cd src-tauri
cargo test --locked
cargo check --locked
cargo clippy --locked --all-targets --all-features -- -D warnings
```

## Repository notes

- GitHub repository: [ActionWolf0/threaddock](https://github.com/ActionWolf0/threaddock)
- Architecture notes: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- Backup artifact format: [docs/BACKUP_FORMAT.md](./docs/BACKUP_FORMAT.md)
- Contribution guide: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Security policy: [SECURITY.md](./SECURITY.md)
- Changelog: [CHANGELOG.md](./CHANGELOG.md)

## Status

The app is implemented as a real local Tauri project and already operates against a live Codex home. Restore/import is implemented with preview, checksum validation, collision handling, and staged writes. Direct LAN transfer has been replaced by encrypted file-based Secure Handoff for a simpler private migration path.
