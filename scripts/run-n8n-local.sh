#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/n8n-env.sh"

load_n8n_local_env

if ! command -v n8n >/dev/null 2>&1; then
	echo "n8n not found on PATH. Install n8n 2.13.4 first, then retry." >&2
	exit 1
fi

echo "Starting n8n from $REPO_ROOT"
echo "N8N_CUSTOM_EXTENSIONS=$N8N_CUSTOM_EXTENSIONS"
echo "N8N_USER_FOLDER=$N8N_USER_FOLDER"
echo "N8N_EDITOR_BASE_URL=$N8N_EDITOR_BASE_URL"

exec n8n start "$@"

