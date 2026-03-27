# Codex n8n Stack

This workspace now includes a small Codex-focused node stack for n8n under `custom/codex`.

## Included nodes

- `Codex CLI`
  - Legacy operations and fallback node
  - Handles `Auth`, `MCP`, `Review`, and direct `Agent` execution
- `Codex Agent`
  - Root AI agent style node
  - Supports session binding, transcript warm starts, runtime selection, and Codex MCP toolsets
- `Codex Memory`
  - `AiMemory` sub-node
  - Mirrors `sessionId -> threadId` behavior and transcript warm-start preferences
- `Codex MCP Toolset`
  - `AiTool` sub-node
  - Supplies saved or inline MCP server configuration to `Codex Agent` or `Codex Agent Tool`
- `Codex Agent Tool`
  - `AiTool` node for standard n8n `AI Agent`
  - Lets a parent agent call Codex as a sub-agent

## Runtime architecture

The implementation is split into four layers:

- `runtime`
  - `cli-runtime.js`
  - `sdk-runtime.js`
  - `codex-service.js`
- `store`
  - `codex-store.js`
  - Bootstraps `codex_*` tables in the active n8n database
- `observability`
  - `codex-observability.js`
  - Normalizes events and extracts artifacts
- `legacy / node wrappers`
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

Current default behavior:

- `Codex CLI` legacy node: `auto -> cli`
- `Codex Agent`: `auto -> cli`
- `Codex Agent Tool`: `auto -> cli`

The SDK runtime uses `@openai/codex-sdk@0.117.0` with dynamic `import()` because the package is ESM-only.

## Session and memory model

`Auto Resume` stores a stable binding key based on:

- `workflowId`
- `nodeId`
- `sessionId`
- `codexHome`
- `workingDirectory`

On first run:

- a new Codex thread is created
- the thread is stored in `codex_session_bindings`

On later runs with the same key:

- the saved `threadId` is resumed automatically

If the stored thread becomes invalid:

- the node creates a fresh thread
- the binding is updated
- a recovery artifact is written to the run log

`Codex Memory` can also mirror recent transcripts so a new thread can be warmed with prior turns if a saved thread is unavailable.

## Database tables

The active n8n database gets these tables on first use:

- `codex_session_bindings`
- `codex_runs`
- `codex_run_events`
- `codex_run_artifacts`

They store:

- session bindings
- per-run metadata
- raw event payloads
- extracted artifacts such as commands, file changes, MCP calls, and git snapshots

## Observability

Events are always eligible for internal storage. The `Include Events In Output` field only controls whether they are also returned in the node result payload.

Artifacts currently include:

- shell command executions
- file changes
- MCP tool calls
- web search usage
- best-effort git status / diff snapshots when the working directory is a Git repository

## Dashboard query template

Import this workflow template to get a ready-made query pack:

- `docs/workflows/codex-observability-query-pack.workflow.json`

It contains five starter branches for:

- usage by session
- tokens by model
- failed runs
- recent changed files
- recent shell commands

Each branch emits one SQL statement as data. The intended next step is to replace each `Code` node with your own database query node or SQL chart workflow.

## Recommended usage patterns

### 1. Direct Codex chat workflow

- `When chat message received`
- `Codex Agent`
- optional `Codex Memory`
- optional `Codex MCP Toolset`

Recommended defaults:

- `Session Strategy`: `Auto Resume`
- `Session ID`: `={{ $json.sessionId }}`
- `State Scope`: `Workspace Scoped`
- `Include Events In Output`: `false`
- `Use Workspace Skills`: `true`

### 2. Standard AI Agent with Codex as sub-agent

- `AI Agent`
- `Codex Agent Tool`
- optional `Codex MCP Toolset`
- optional `Codex Memory`

Recommended defaults:

- `Codex Agent Tool` `Session Strategy`: `Always New`
- `Ephemeral`: `true`

### 3. Operational management

Use `Codex CLI` for:

- `Auth > Status`
- `Auth > Logout`
- `MCP > List / Get / Add / Remove / Login / Logout`
- `Agent > Review Changes`

## Verification commands

Load-check all custom Codex nodes:

```powershell
npm run check:codex-node
```

Export nodes as n8n sees them:

```powershell
npm run export:codex-nodes
```

## Cross-platform notes

Most of the runtime logic is already portable because it relies on Node.js path handling and only branches on Windows where `.cmd` launching is required.

What is already portable:

- `custom/codex` runtime, store, and observability modules
- CLI execution on Windows and non-Windows via platform-aware spawn handling
- SDK execution through `@openai/codex-sdk`
- Database storage through the active n8n `DataSource`

What stays environment-specific:

- your local `CODEX_HOME`
- your local n8n `.env`
- any corporate CA bundle path
- the installed Codex CLI location if it is not on `PATH`

The npm scripts are now workspace-relative and cross-platform. They automatically set `N8N_CUSTOM_EXTENSIONS` to the local `custom` directory if you do not set it yourself.

## Notes and current limits

- `Codex Agent` currently treats connected non-Codex `AiTool` inputs as unsupported and reports their count as `ignoredToolCount`
- `Codex Agent Tool` returns a string result to the parent agent, and also logs structured run metadata in the tool output
- `Codex MCP Toolset` maps to Codex MCP config overrides, not generic LangChain tool wiring
- `Auth`, `MCP`, and `Review` stay on the CLI path even when `Agent` execution uses the SDK runtime
