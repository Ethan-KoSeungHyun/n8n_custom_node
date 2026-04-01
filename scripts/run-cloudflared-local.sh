#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/n8n-env.sh"

load_n8n_local_env

if ! command -v cloudflared >/dev/null 2>&1; then
	echo "cloudflared not found on PATH." >&2
	exit 1
fi

if [[ -f "$CLOUDFLARED_CONFIG_FILE" ]]; then
	if [[ -n "$CLOUDFLARED_TUNNEL_NAME" ]]; then
		exec cloudflared tunnel --config "$CLOUDFLARED_CONFIG_FILE" run "$CLOUDFLARED_TUNNEL_NAME"
	fi

	exec cloudflared tunnel --config "$CLOUDFLARED_CONFIG_FILE" run
fi

exec cloudflared tunnel --url "http://${N8N_LISTEN_ADDRESS}:${N8N_PORT}"
