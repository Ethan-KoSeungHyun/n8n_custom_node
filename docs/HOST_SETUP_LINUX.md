# Linux Host Setup

This guide connects a Linux n8n runtime to the shared custom node repository clone.

## 1. Clone the shared repository

Example:

```bash
git clone <your-remote-url> /srv/N8N_SERVER/n8n_server_github
```

## 2. Install shared custom-node dependencies

```bash
cd /srv/N8N_SERVER/n8n_server_github
npm install
```

## 3. Point the Linux n8n runtime at the shared repo

Set this in the Linux host's local `.env` or service environment:

```text
N8N_CUSTOM_EXTENSIONS=/srv/N8N_SERVER/n8n_server_github/custom
```

Keep the n8n runtime, DB, logs, and service-manager files outside the shared repo.
Run `npm install` only in `/srv/N8N_SERVER/n8n_server_github`, never in `custom/codex`.

By default, the Codex nodes use the host runtime folder as their working directory because that is where n8n starts.
If a workflow should operate on the shared repo itself, set the node's `Working Directory` explicitly to `/srv/N8N_SERVER/n8n_server_github`.

## 4. Host-local Codex state

각 Codex 계정 인증은 n8n Credentials에서 **Codex ChatGPT Account** credential을 생성하고 Connect를 눌러 완료하세요. 인증 상태는 `data/codex-profiles/{profileKey}/codex-home`에 계정별로 격리되어 저장됩니다.

`codex`가 PATH에 없으면 credential의 `Codex Executable Path`에 직접 경로를 입력하거나 `CODEX_CLI_PATH` 환경변수를 지정하세요.

## 5. Permissions

Make sure the Linux service user can read:

- the shared repo clone
- any CA bundle path or skills path you reference

And can write:

- `data/codex-profiles/` (per-credential auth state)
- the n8n runtime DB/log/state directories

## 6. Verification

From the Linux n8n runtime folder, verify node loading and a simple agent run:

```bash
npm run check:codex-node
npm run export:codex-nodes
```

Then smoke-test:

- `Codex CLI > Auth > Status`
- `Codex Agent` with `Runtime=CLI`
- `Codex Agent` with `Runtime=SDK`
- `Auto Resume` over two turns
- `Codex MCP Toolset` with a saved server or the local stdio smoke server

## 7. Operating model

- shared repo: source for `custom/codex/**` and docs
- Linux host: local runtime, `.env`, process manager, DB, logs, certs, and `data/codex-profiles/`

Do not store host-specific runtime files in this shared repo.
