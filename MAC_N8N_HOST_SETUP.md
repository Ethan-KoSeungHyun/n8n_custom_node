# Mac Host Runtime for n8n

This workspace is set up to run `n8n` directly on macOS instead of inside Docker.

## Why this layout

- `custom/codex` expects to work against the host workspace, Git repository, `data/codex-home`, and optional `.codex/skills`.
- The existing `Execute Command` wrapper expects `bash` and `jq` to be available where n8n runs.
- Running n8n on the host makes the Mac setup closer to the already-working Windows npm setup.

## Files added for the Mac host flow

- `.env.local.example`
  - copy to `.env.local` and adjust only if you want to override defaults
- `scripts/run-n8n-local.sh`
  - starts n8n with the local env file and shared defaults
- `scripts/run-cloudflared-local.sh`
  - starts `cloudflared` against the same local listener
- `scripts/doctor-n8n-local.sh`
  - checks Node, n8n, Codex, and runtime paths

## Expected runtime behavior

- `N8N_CUSTOM_EXTENSIONS` points at this repo's `custom` directory
- `N8N_USER_FOLDER` is the parent folder whose `.n8n` child contains the actual n8n data
- workspace-local Codex state stays under `data/codex-home`
- `.codex/skills` remains optional and local-only
- `Execute Command` is enabled by overriding `NODES_EXCLUDE` so it no longer blocks `n8n-nodes-base.executeCommand`

## Reusing an old Docker-mounted n8n folder

If you previously mounted `/home/node/.n8n` from Docker onto a host folder, that host folder already is the real n8n data directory.
Important: `N8N_USER_FOLDER` must point to that folder's parent, because n8n resolves the active directory as `"$N8N_USER_FOLDER/.n8n"`.

Example:

```bash
mkdir -p /Users/seunghyun.ko/Documents/n8n-data-home
ln -s /Users/seunghyun.ko/Documents/n8n-data /Users/seunghyun.ko/Documents/n8n-data-home/.n8n
N8N_USER_FOLDER=/Users/seunghyun.ko/Documents/n8n-data-home
```

That keeps the existing:

- `database.sqlite`
- `config` / encryption key
- `nodes/` community packages
- event logs and other persisted n8n state

## Manual run flow

1. Make sure a supported Node.js version is active for n8n.
   - n8n npm docs currently require Node.js `20.19` through `24.x`.
2. Copy `.env.local.example` to `.env.local` if you want a local override file.
3. Simplest start command:

```bash
npm run start:local
```

This starts `n8n`, waits for the local health check, and then starts `cloudflared`.
Keep that terminal open while you use n8n.
If `~/.cloudflared/config.yml` exists, the script prefers your named tunnel configuration automatically.

4. Stop everything:

Press `Ctrl+C` in the same terminal.

5. Run the doctor only when you need to troubleshoot setup issues:

```bash
bash ./scripts/doctor-n8n-local.sh
```

6. If you want to run only n8n without the tunnel:

```bash
npm run start:local:no-tunnel
```

7. If you prefer fully manual foreground processes:

```bash
bash ./scripts/run-n8n-local.sh
bash ./scripts/run-cloudflared-local.sh
```

## Codex credentials

For the `Codex CLI` credential in n8n, use:

- `Codex Executable Path`: `/opt/homebrew/bin/codex`

Leaving it blank also works if `codex` is already on `PATH`, but the absolute path is the least ambiguous option on macOS.

## Execute Command wrapper

The existing wrapper contract stays the same. It should return JSON in both success and failure cases and always finish with `exit 0`.

```bash
bash -lc 'OUTPUT=$( <command> 2>&1 ); EXIT_CODE=$?; if [ $EXIT_CODE -eq 0 ]; then echo "{\"ok\":true,\"exitCode\":0,\"output\":$(printf "%s" "$OUTPUT" | jq -Rs .)}"; else echo "{\"ok\":false,\"exitCode\":$EXIT_CODE,\"error\":$(printf "%s" "$OUTPUT" | jq -Rs .)}"; fi; exit 0'
```

## Future service upgrade

- `pm2`: easiest when you want restart management and log commands
- `launchd`: best fit when you want native macOS background startup

Both can reuse `scripts/run-n8n-local.sh` as the common entrypoint later.
