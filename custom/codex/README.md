# Codex Custom Nodes

This folder is the Git-shared part of the setup.

## What is shared

- `custom/codex/*.node.js`
- `custom/codex/*.credentials.js`
- `custom/codex/lib/**`
- `custom/codex/runtime/**`
- `custom/codex/store/**`
- `custom/codex/observability/**`
- `custom/codex/scripts/**`
- `custom/codex/package.json`

## What is intentionally not shared

Each machine keeps its own n8n server/runtime files outside Git, for example:

- `.env.local`
- root `package.json`
- root `package-lock.json`
- root `scripts/`
- `local/`
- `logs/`
- `data/`
- workspace `.codex/` state

## Per-machine setup

1. Pull this repository.
2. Install the shared custom-node dependencies:

```bash
cd custom/codex
npm install
```

3. Point n8n at the repo's `custom` directory:

```bash
N8N_CUSTOM_EXTENSIONS=/absolute/path/to/this/repo/custom
```

4. In the `Codex CLI` credential, set `Codex Executable Path` if `codex` is not already on `PATH`.

## Local MCP smoke test

This folder includes a minimal stdio MCP server for validating Codex MCP wiring.

- Command: `node`
- Arguments JSON: `["/absolute/path/to/this/repo/custom/codex/scripts/mcp-smoke-stdio-server.mjs"]`

Recommended first prompt:

```text
If MCP tools are available, call the ping tool with text "hello" and then reply with the exact word ok.
```

If that works, the Codex MCP wiring is healthy and any remaining problem is specific to the remote MCP server you are testing.
