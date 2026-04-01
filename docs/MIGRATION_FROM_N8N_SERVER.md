# Migration From `N8N_SERVER/custom`

This guide moves a Windows runtime from a local `D:\Project\N8N_SERVER\custom` folder to the shared repository at `D:\Project\n8n_server_github\custom`.

## Goal

After migration:

- custom node source is edited only in `D:\Project\n8n_server_github`
- `D:\Project\N8N_SERVER` stays the local runtime folder
- `N8N_CUSTOM_EXTENSIONS` points to the shared repo

## Steps

1. Back up the local custom folder.

```powershell
Rename-Item D:\Project\N8N_SERVER\custom custom.bak
```

2. Update the local runtime `.env`:

```text
N8N_CUSTOM_EXTENSIONS=D:\Project\n8n_server_github\custom
```

3. Keep local runtime files local:

- `.env`
- `.npmrc`
- `package.json`
- `package-lock.json`
- `node_modules/`
- `data/`
- `tmp/`
- `workflow/`

4. Install or update shared custom dependencies:

```powershell
cd D:\Project\n8n_server_github\custom\codex
npm install
```

5. Verify from the local runtime folder:

```powershell
cd D:\Project\N8N_SERVER
npm run check:codex-node
npm run export:codex-nodes
```

## Notes

- `Saved CLI Auth` does not migrate automatically across hosts; log in on each host.
- `CODEX_HOME` stays host-local.
- If something goes wrong, restore the local folder from `custom.bak` and point `N8N_CUSTOM_EXTENSIONS` back to the local path temporarily.
