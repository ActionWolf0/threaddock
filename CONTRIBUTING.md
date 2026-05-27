# Contributing

## Scope

ThreadDock is intended to stay local-first, non-destructive by default, and explicit about which operations are exact versus derived. Changes should preserve those constraints.

## Setup

```bash
cd apps/desktop
npm install
npm run build
npm audit --audit-level=moderate
cd src-tauri
cargo test --locked
cargo check --locked
cargo clippy --locked --all-targets --all-features -- -D warnings
```

## Pull requests

- Keep UI changes consistent with the ThreadDock visual language already in the app.
- Prefer small, reviewable PRs instead of large mixed refactors.
- Add or update tests for backend parsing, archive, backup, or integrity logic when behavior changes.
- Do not introduce raw rollout mutation paths outside explicit safe workflows.

## Suggested labels

- `bug`
- `enhancement`
- `good first issue`
- `help wanted`
- `documentation`
- `backend`
- `frontend`
- `backup`
- `health`
- `release`
