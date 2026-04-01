# n8n Codex Custom Nodes

This repository is the shared source of truth for the Codex custom nodes used by multiple n8n hosts.

## What lives here

- `custom/codex/**`
- shared custom-node dependency manifest in `package.json`
- shared docs under `docs/**`
- shared workflow templates under `docs/workflows/**`

## What does not live here

Each host keeps its own runtime and state outside Git:

- n8n runtime files and local `node_modules`
- host `.env`, `.npmrc`, process-manager config, and certificates
- n8n database, logs, `data/`, `tmp/`, and workflow exports
- host-local `CODEX_HOME` and saved Codex auth

## Host contract

Every host points n8n to this repository's `custom` directory:

```text
N8N_CUSTOM_EXTENSIONS=/absolute/path/to/this/repo/custom
```

Then install the shared custom-node dependencies once on that host:

```bash
cd /absolute/path/to/n8n_server_github
npm install
```

## Docs

- Shared node guide: `docs/CODEX_N8N_NODE.md`
- Windows host setup: `docs/HOST_SETUP_WINDOWS.md`
- Linux host setup: `docs/HOST_SETUP_LINUX.md`
- Migration from a local `N8N_SERVER/custom`: `docs/MIGRATION_FROM_N8N_SERVER.md`
- Host `.env` example: `docs/examples/.env.host.example`

## Repo layout

```text
custom/codex/    Shared node source, runtime, store, and observability modules
docs/            Shared operating docs
package.json     Shared custom-node dependency manifest
```

Keep runtime-specific scripts in each host repository or server, not here.
