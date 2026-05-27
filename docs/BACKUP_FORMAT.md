# Backup Format

ThreadDock v1 writes backup artifacts as either:

- `*.threaddock-backup.zip`
- `*.threaddock-backup/` plain folders for advanced users

## Archive layout

```text
manifest.json
threads/<thread-id>.jsonl
metadata/threads.json
metadata/families.json
```

## Manifest contents

- backup format version
- creation timestamp
- ThreadDock version
- source Codex home
- export mode (`threads` or `family`)
- exported thread ids
- exported family roots
- total rollout bytes
- per-file archive path, byte count, and SHA-256 checksum

## Verification

During export, ThreadDock:

1. reads each rollout file
2. computes a SHA-256 checksum
3. writes either the zip artifact or the plain-folder artifact
4. reopens or rereads the artifact and verifies every exported rollout entry against the manifest checksum

This means a backup is not reported as successful unless the written artifact passes checksum verification.

During preview/import, ThreadDock:

1. reads `manifest.json`
2. rejects unsupported versions, duplicate thread ids, unsafe archive paths, and malformed checksums
3. verifies `metadata/threads.json` matches the manifest thread set
4. reads each rollout payload through a safe artifact path
5. verifies byte count and SHA-256 before staging any restore bytes
6. stages restore bytes to temporary files before replacing existing rollouts
7. rolls back an existing rollout if a replacement commit fails
