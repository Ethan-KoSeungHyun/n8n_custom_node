#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/n8n-env.sh"

load_n8n_local_env

node_support_status="$(
	node <<'EOF'
const [major, minor] = process.versions.node.split('.').map(Number);
const supported =
	(major === 20 && minor >= 19) ||
	major === 21 ||
	major === 22 ||
	major === 23 ||
	major === 24;
if (!supported) {
	process.stderr.write(`Unsupported Node.js version for n8n npm runtime: ${process.versions.node}\n`);
	process.exit(1);
}
process.stdout.write(`Node.js ${process.versions.node} is within the supported n8n npm range.\n`);
EOF
)"

echo "$node_support_status"
echo "Repo root: $REPO_ROOT"
echo "Env file: ${N8N_ENV_FILE:-$REPO_ROOT/.env.local}"
echo "N8N_CUSTOM_EXTENSIONS: $N8N_CUSTOM_EXTENSIONS"
echo "N8N_USER_FOLDER: $N8N_USER_FOLDER"
echo "Resolved n8n data dir: $N8N_USER_FOLDER/.n8n"
echo "NODE_PATH: $NODE_PATH"
echo "Global npm root: ${GLOBAL_NPM_ROOT:-<empty>}"

for command_name in node npm bash jq codex; do
	if command -v "$command_name" >/dev/null 2>&1; then
		echo "$command_name: $(command -v "$command_name")"
	else
		echo "$command_name: MISSING"
	fi
done

if command -v n8n >/dev/null 2>&1; then
	echo "n8n version: $(n8n --version)"
else
	echo "n8n version: MISSING"
fi

if [[ -d "$REPO_ROOT/.codex/skills" ]]; then
	echo "Workspace skills: present at $REPO_ROOT/.codex/skills"
else
	echo "Workspace skills: not present (optional)"
fi

if [[ -f "$REPO_ROOT/node_modules/@openai/codex-sdk/package.json" ]]; then
	echo "Local Codex SDK: present"
else
	echo "Local Codex SDK: missing"
fi
