# Windows Host Setup

This guide connects a Windows n8n runtime such as `D:\Project\N8N_SERVER` to the shared custom node repository at `D:\Project\N8N_SERVER\n8n_custom_node`.

## 1. Install shared custom-node dependencies

```powershell
cd D:\Project\N8N_SERVER\n8n_custom_node
npm install
```

## 2. Point the local n8n runtime at the shared repo

Set this in the Windows host's local `.env`:

```text
N8N_CUSTOM_EXTENSIONS=D:/Project/N8N_SERVER/n8n_custom_node/custom
```

Keep the rest of the runtime-specific settings in the local runtime folder, not in this shared repo.
Run `npm install` only in `D:\Project\N8N_SERVER\n8n_custom_node`, never in `custom\codex`.

By default, the Codex nodes use the host runtime folder as their working directory because that is where n8n starts.
If a workflow should operate on the shared repo itself, set the node's `Working Directory` explicitly to `D:\Project\N8N_SERVER\n8n_custom_node`.

## 3. Keep host-local state local

Do not commit these from the Windows host:

- `.env`
- `.npmrc`
- `data/`
- `tmp/`
- `workflow/`
- local certificates

## 4. Codex authentication

n8n Credentials에서 **Codex ChatGPT Account** credential을 생성하고 Connect를 눌러 로그인하세요. 인증 상태는 `data/codex-profiles/{profileKey}/codex-home`에 계정별로 격리되어 저장됩니다.

`codex`가 PATH에 없으면 credential의 `Codex Executable Path`에 직접 경로를 입력하거나 `CODEX_CLI_PATH` 환경변수를 지정하세요.

## 5. Verification

Run these from the Windows n8n runtime folder:

```powershell
cd D:\Project\N8N_SERVER
npm run check:codex-node
npm run export:codex-nodes
```

The export should include:

- `CUSTOM.codexAgent`
- `CUSTOM.codexAgentTool`
- `CUSTOM.codexMemory`
- `CUSTOM.codexMcpToolset`

## 6. Recommended runtime split

- `D:\Project\N8N_SERVER`: n8n runtime, DB, logs, local scripts, local state
- `D:\Project\N8N_SERVER\n8n_custom_node`: shared custom node source, shared dependencies, and docs

Make changes to custom nodes only in the shared repo.
