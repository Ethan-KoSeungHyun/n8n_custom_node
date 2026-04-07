# macOS Host Setup

This guide connects a macOS n8n runtime such as `/Users/you/N8N_SERVER` to the shared custom node repository at `/Users/you/N8N_SERVER/n8n_server_github`.

## 1. Install shared custom-node dependencies

```bash
cd /Users/you/N8N_SERVER/n8n_server_github
npm install
```

Run `npm install` only at the shared repo root, never inside `custom/codex`.

## 2. Point the local n8n runtime at the shared repo

Set this in the macOS host's local `.env`:

```text
N8N_CUSTOM_EXTENSIONS=/Users/you/N8N_SERVER/n8n_server_github/custom
```

Keep runtime-specific files in the local runtime folder, not in the shared repo.

## 3. Working directory behavior

By default, the Codex nodes use the host runtime folder as their working directory because that is where n8n starts.

If a workflow should operate on the shared repo itself, set the node's `Working Directory` explicitly to:

```text
/Users/you/N8N_SERVER/n8n_server_github
```

## 4. Host-local Codex state

Recommended host-local values:

```text
CODEX_CLI_PATH=/opt/homebrew/bin/codex
```

각 Codex 계정 인증은 n8n Credentials에서 **Codex ChatGPT Account** credential을 생성하고 Connect를 눌러 완료하세요. 인증 상태는 `data/codex-profiles/{profileKey}/codex-home`에 계정별로 격리되어 저장됩니다.

## 5. Recommended runtime split

- `/Users/you/N8N_SERVER`: n8n runtime, DB, logs, local scripts, local state
- `/Users/you/N8N_SERVER/n8n_server_github`: shared custom node source, shared dependencies, and docs

Do not store host-specific runtime files in the shared repo.
