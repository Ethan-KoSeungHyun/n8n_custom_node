# Codex Custom Nodes

This folder contains the Git-shared Codex custom node source for n8n.

## Shared in this folder

- `*.node.js`
- `*.credentials.js`
- `lib/**`
- `runtime/**`
- `store/**`
- `observability/**`
- `scripts/**`
- no package manifest lives here by design

## Install on each host

Install dependencies from the shared repository root:

```bash
cd ../../
npm install
```

The host n8n runtime should point `N8N_CUSTOM_EXTENSIONS` at the repository's `custom` directory.

## Docs

- repository overview: `../../README.md`
- shared node guide: `../../docs/CODEX_N8N_NODE.md`
- Windows host setup: `../../docs/HOST_SETUP_WINDOWS.md`
- Linux host setup: `../../docs/HOST_SETUP_LINUX.md`
- migration guide: `../../docs/MIGRATION_FROM_N8N_SERVER.md`

## Why there is no local node_modules here

Do not run `npm install` inside `custom/codex`.

If `custom/codex/node_modules` exists, n8n can accidentally scan dependency files while loading custom nodes and fail at startup. Keeping the dependency tree at the repository root avoids that collision.

## What stays outside this folder

Each host keeps its own:

- n8n runtime
- `.env` and `.npmrc`
- DB, logs, `data/`, `tmp/`, workflow exports
- `CODEX_HOME` and saved auth
- process-manager config and certificates
