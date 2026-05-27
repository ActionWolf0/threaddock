# Architecture

## Overview

ThreadDock uses a hybrid model:

- Codex App Server for supported lifecycle operations such as list, archive, and unarchive
- Direct filesystem inspection for exact rollout sizes, subagent relationship discovery, backup packaging, and integrity checks

## Desktop layers

### Frontend

- React renders the library, family, backup, health, and settings surfaces
- Filtering, sorting, pagination, and selection logic are handled client-side from the loaded snapshot
- Runtime settings include custom Codex-home overrides, read-only external archive paths, backup directory, and default export format
- Browser preview keeps lightweight local state for the same settings and activity log so localhost QA matches the native app closely

### Rust backend

- Discovers Codex home, including an optional user override
- Scans active and archived rollout files plus an optional read-only external archive path
- Merges filesystem data with Codex App Server thread data
- Tracks scan issues such as malformed rollouts and missing rollout paths
- Creates verified backup zip or plain-folder artifacts
- Previews and imports backup artifacts with manifest validation, checksum verification, staged writes, and rollback on replacement failure
- Creates and imports encrypted Secure Handoff files for offline computer-to-computer migration
- Maintains guarded trash metadata for restoreable thread deletion
- Persists a rebuildable SQLite cache for derived thread metadata, family aggregates, backup records, app settings, and recent activity
- Reveals files or folders with native OS shell commands

### Browser preview dev API

The Vite development server mirrors the same application capabilities in Node so the local browser surface can exercise realistic thread and backup flows without launching the native Tauri shell for every frontend change.

## Safety model

- ThreadDock never edits rollout contents directly
- Archive/unarchive flows use the official App Server
- Backup export is append-only and writes outside the Codex store
- Backup import requires preview in the UI and verifies checksums again in the backend before writing
- Existing rollouts are moved aside before replacement and restored if the commit fails
- Secure Handoff uses encrypted files instead of network listeners, LAN discovery, or unauthenticated local HTTP transfer
- Integrity issues are reported visibly instead of being silently ignored
