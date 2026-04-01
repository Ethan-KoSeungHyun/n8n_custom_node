# Windows Host Setup

This guide connects a Windows n8n runtime such as `D:\Project\N8N_SERVER` to the shared custom node repository at `D:\Project\n8n_server_github`.

## 1. Install shared custom-node dependencies

```powershell
cd D:\Project\n8n_server_github\custom\codex
npm install
```

## 2. Point the local n8n runtime at the shared repo

Set this in the Windows host's local `.env`:

```text
N8N_CUSTOM_EXTENSIONS=D:\Project\n8n_server_github\custom
```

Keep the rest of the runtime-specific settings in the local runtime folder, not in this shared repo.

## 3. Keep host-local state local

Do not commit these from the Windows host:

- `.env`
- `.npmrc`
- `data/`
- `tmp/`
- `workflow/`
- local certificates
- host `CODEX_HOME`

## 4. Codex authentication

If you use `Saved CLI Auth`, log in on the Windows host itself:

```powershell
$env:CODEX_HOME='D:\Project\N8N_SERVER\data\codex-home'
codex login
```

If `codex` is not on `PATH`, set the `Codex Executable Path` in the n8n credential or define a host-local `CODEX_CLI_PATH`.

## 5. Verification

Run these from the Windows n8n runtime folder:

```powershell
cd D:\Project\N8N_SERVER
npm run check:codex-node
npm run export:codex-nodes
```

The export should include:

- `CUSTOM.codexAgent`
- `CUSTOM.codexCli`
- `CUSTOM.codexAgentTool`
- `CUSTOM.codexMemory`
- `CUSTOM.codexMcpToolset`

## 6. Recommended runtime split

- `D:\Project\N8N_SERVER`: n8n runtime, DB, logs, local scripts, local state
- `D:\Project\n8n_server_github`: shared custom node source and docs only

Make changes to custom nodes only in the shared repo.
