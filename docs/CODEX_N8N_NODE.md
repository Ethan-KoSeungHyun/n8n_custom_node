# Codex n8n Custom Nodes

This repository ships a Codex-focused custom node stack for n8n under `custom/codex`.

## Included nodes

- `Codex CLI`
  - management and fallback node
  - handles `Auth`, `MCP`, `Review`, and direct legacy `Agent` execution
- `Codex Agent`
  - root AI-agent-style node
  - supports runtime selection, session binding, transcript warm start, and Codex MCP toolsets
- `Codex Memory`
  - `AiMemory` sub-node
  - stores `sessionId -> threadId` bindings and transcript mirror preferences
- `Codex MCP Toolset`
  - `AiTool` sub-node
  - supplies saved or inline MCP server configuration to `Codex Agent` and `Codex Agent Tool`
- `Codex Agent Tool`
  - `AiTool` node for standard n8n `AI Agent`
  - lets a parent agent call Codex as a sub-agent

## Repository contract

- This repo owns only the shared custom node source, its shared dependencies, and shared docs.
- Each host keeps its own n8n runtime, `.env`, DB, logs, and process manager.
- `Saved CLI Auth` is per host. Run `codex login` separately on Windows and Linux.
- `CODEX_HOME` is host-local state and must not be committed.

## Runtime architecture

The implementation is split into four layers:

- `runtime`
  - `cli-runtime.js`
  - `sdk-runtime.js`
  - `codex-service.js`
- `store`
  - `codex-store.js`
  - bootstraps `codex_*` tables in the active n8n database
- `observability`
  - `codex-observability.js`
  - normalizes events and extracts artifacts
- node wrappers
  - `CodexCli.node.js`
  - `CodexAgent.node.js`
  - `CodexAgentTool.node.js`
  - `CodexMemory.node.js`
  - `CodexMcpToolset.node.js`

## Runtime selection

`Codex Agent` and `Codex Agent Tool` support:

- `auto`
- `cli`
- `sdk`

Current defaults:

- `Codex CLI` legacy node: `auto -> cli`
- `Codex Agent`: `auto -> cli`
- `Codex Agent Tool`: `auto -> cli`

The SDK runtime uses `@openai/codex-sdk@0.117.0`.

## Session model

`Auto Resume` stores a stable binding key based on:

- `workflowId`
- `nodeId`
- `sessionId`
- `codexHome`
- `workingDirectory`

On first run:

- a new Codex thread is created
- the binding is stored in `codex_session_bindings`

On later runs with the same key:

- the saved `threadId` is resumed automatically

If the stored thread is invalid:

- a new thread is created
- the binding is updated
- a recovery artifact is written to the run log

## Database tables

The active n8n database gets these tables on first use:

- `codex_session_bindings`
- `codex_runs`
- `codex_run_events`
- `codex_run_artifacts`

They store session bindings, per-run metadata, raw event payloads, and extracted artifacts.

## Observability

Events are always eligible for internal storage. `Include Events In Output` only controls whether they are also returned in the node output.

Artifacts can include:

- shell command executions
- file changes
- MCP tool calls
- web search usage
- best-effort Git status and diff snapshots when the working directory is a Git repository

## Dashboard template

Import this workflow template to get starter queries:

- `docs/workflows/codex-observability-query-pack.workflow.json`

It contains starter branches for:

- usage by session
- tokens by model
- failed runs
- recent changed files
- recent shell commands

## Recommended defaults

Direct chat workflow:

- `When chat message received`
- `Codex Agent`
- optional `Codex Memory`
- optional `Codex MCP Toolset`

Recommended field defaults:

- `Session Strategy`: `Auto Resume`
- `Session ID`: `={{ $json.sessionId }}`
- `State Scope`: `Workspace Scoped`
- `Include Events In Output`: `false`
- `Use Workspace Skills`: `true`

Sub-agent workflow:

- `AI Agent`
- `Codex Agent Tool`
- optional `Codex MCP Toolset`

Recommended field defaults:

- `Session Strategy`: `Always New`
- `Ephemeral`: `true`

## Verification

Install the shared custom-node dependencies from the shared repo root:

```powershell
cd /absolute/path/to/n8n_server_github
npm install
```

After wiring `N8N_CUSTOM_EXTENSIONS` to this repository's `custom` directory, verify from the host runtime folder:

```powershell
npm run check:codex-node
npm run export:codex-nodes
```

## Current limits

- `Codex Agent` officially understands `Codex MCP Toolset` inputs first; arbitrary LangChain tools are not yet fully supported there.
- `Auth`, `MCP`, and `Review` stay on the CLI path even when `Agent` execution uses the SDK runtime.
- The dashboard template is a query pack, not a finished chart UI.
