#!/usr/bin/env bash

set -euo pipefail

n8n_repo_root() {
	local script_dir
	script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	cd "$script_dir/../.." && pwd
}

path_prepend_once() {
	local candidate="$1"
	if [[ -z "$candidate" || ! -d "$candidate" ]]; then
		return 0
	fi

	case ":${PATH}:" in
		*":${candidate}:"*) ;;
		*) PATH="${candidate}:${PATH}" ;;
	esac
}

load_n8n_local_env() {
	local repo_root env_file global_npm_prefix global_npm_root
	repo_root="${REPO_ROOT:-$(n8n_repo_root)}"
	env_file="${N8N_ENV_FILE:-$repo_root/.env.local}"

	export REPO_ROOT="$repo_root"

	if [[ -f "$env_file" ]]; then
		set -a
		# shellcheck disable=SC1090
		source "$env_file"
		set +a
	fi

	global_npm_prefix="${GLOBAL_NPM_PREFIX:-$(npm prefix -g 2>/dev/null || true)}"
	global_npm_root="${GLOBAL_NPM_ROOT:-$(npm root -g 2>/dev/null || true)}"

	export GLOBAL_NPM_PREFIX="$global_npm_prefix"
	export GLOBAL_NPM_ROOT="$global_npm_root"

	path_prepend_once "/opt/homebrew/bin"
	path_prepend_once "/opt/homebrew/sbin"
	if [[ -n "$global_npm_prefix" ]]; then
		path_prepend_once "${global_npm_prefix}/bin"
	fi
	export PATH

	export NODE_PATH="$repo_root/node_modules${global_npm_root:+:${global_npm_root}}${NODE_PATH:+:${NODE_PATH}}"

	export N8N_HOST="${N8N_HOST:-n8n.seunghyun.space}"
	export N8N_PROTOCOL="${N8N_PROTOCOL:-https}"
	export N8N_EDITOR_BASE_URL="${N8N_EDITOR_BASE_URL:-https://n8n.seunghyun.space}"
	export WEBHOOK_URL="${WEBHOOK_URL:-https://n8n.seunghyun.space/}"
	export N8N_PROXY_HOPS="${N8N_PROXY_HOPS:-1}"
	export N8N_PORT="${N8N_PORT:-5678}"
	export N8N_LISTEN_ADDRESS="${N8N_LISTEN_ADDRESS:-127.0.0.1}"
	export N8N_CUSTOM_EXTENSIONS="${N8N_CUSTOM_EXTENSIONS:-$repo_root/custom}"
	export N8N_USER_FOLDER="${N8N_USER_FOLDER:-$repo_root/local/n8n-user}"
	export NODES_EXCLUDE="${NODES_EXCLUDE:-[\"n8n-nodes-base.localFileTrigger\"]}"
	export TZ="${TZ:-Asia/Seoul}"
	export GENERIC_TIMEZONE="${GENERIC_TIMEZONE:-Asia/Seoul}"
	export N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS="${N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS:-true}"
	export DB_TYPE="${DB_TYPE:-sqlite}"
	export CODEX_CLI_PATH="${CODEX_CLI_PATH:-/opt/homebrew/bin/codex}"
	export CLOUDFLARED_CONFIG_FILE="${CLOUDFLARED_CONFIG_FILE:-$HOME/.cloudflared/config.yml}"
	export CLOUDFLARED_TUNNEL_NAME="${CLOUDFLARED_TUNNEL_NAME:-}"

	mkdir -p "$N8N_USER_FOLDER" "$repo_root/local" "$repo_root/logs" "$repo_root/data"
}
