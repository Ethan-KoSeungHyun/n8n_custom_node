# Linux Host Setup

This guide connects a Linux n8n runtime to the shared custom node repository clone.

## 1. Clone the shared repository

Example:

```bash
git clone <your-remote-url> /srv/n8n_server_github
```

## 2. Install shared custom-node dependencies

```bash
cd /srv/n8n_server_github/custom/codex
npm install
```

## 3. Point the Linux n8n runtime at the shared repo

Set this in the Linux host's local `.env` or service environment:

```text
N8N_CUSTOM_EXTENSIONS=/srv/n8n_server_github/custom
```

Keep the n8n runtime, DB, logs, and service-manager files outside the shared repo.

## 4. Host-local Codex state

Recommended host-local values:

```text
CODEX_HOME=/var/lib/n8n/codex-home
```

`Saved CLI Auth` is per host, so run `codex login` on the Linux host separately from Windows.

If `codex` is not on `PATH`, either set the credential's `Codex Executable Path` or define a host-local `CODEX_CLI_PATH`.

## 5. Permissions

Make sure the Linux service user can read:

- the shared repo clone
- the configured `CODEX_HOME`
- any CA bundle path or skills path you reference

And can write:

- host-local `CODEX_HOME`
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
- Linux host: local runtime, `.env`, process manager, DB, logs, certs, and `CODEX_HOME`

Do not store host-specific runtime files in this shared repo.
