#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/n8n-env.sh"

load_n8n_local_env

RUN_DIR="$REPO_ROOT/local/run"
LOG_DIR="$REPO_ROOT/logs"
N8N_LOG_FILE="$LOG_DIR/n8n.log"
CLOUDFLARED_LOG_FILE="$LOG_DIR/cloudflared.log"
START_TUNNEL="true"
N8N_PID=""
CLOUDFLARED_PID=""

mkdir -p "$RUN_DIR" "$LOG_DIR"

if [[ "${1:-}" == "--no-tunnel" ]]; then
	START_TUNNEL="false"
fi

cleanup() {
	if [[ -n "$CLOUDFLARED_PID" ]] && kill -0 "$CLOUDFLARED_PID" >/dev/null 2>&1; then
		kill "$CLOUDFLARED_PID" >/dev/null 2>&1 || true
	fi

	if [[ -n "$N8N_PID" ]] && kill -0 "$N8N_PID" >/dev/null 2>&1; then
		kill "$N8N_PID" >/dev/null 2>&1 || true
	fi
}

trap cleanup EXIT INT TERM

wait_for_n8n() {
	local attempts=30
	local url="http://${N8N_LISTEN_ADDRESS}:${N8N_PORT}/healthz"

	while (( attempts > 0 )); do
		if curl -fsS "$url" >/dev/null 2>&1; then
			echo "n8n is healthy at $url"
			return 0
		fi

		if [[ -z "$N8N_PID" ]] || ! kill -0 "$N8N_PID" >/dev/null 2>&1; then
			echo "n8n stopped during startup. Check $N8N_LOG_FILE" >&2
			return 1
		fi

		sleep 1
		attempts=$((attempts - 1))
	done

	echo "Timed out waiting for n8n health endpoint. Check $N8N_LOG_FILE" >&2
	return 1
}

if [[ "$START_TUNNEL" == "false" ]]; then
	exec bash "$SCRIPT_DIR/run-n8n-local.sh"
fi

: >"$N8N_LOG_FILE"
bash "$SCRIPT_DIR/run-n8n-local.sh" >>"$N8N_LOG_FILE" 2>&1 &
N8N_PID=$!
echo "Started n8n (PID $N8N_PID)"
wait_for_n8n

if command -v cloudflared >/dev/null 2>&1; then
	: >"$CLOUDFLARED_LOG_FILE"
	bash "$SCRIPT_DIR/run-cloudflared-local.sh" >>"$CLOUDFLARED_LOG_FILE" 2>&1 &
	CLOUDFLARED_PID=$!
	echo "Started cloudflared (PID $CLOUDFLARED_PID)"
else
	echo "cloudflared is not installed, skipping tunnel startup."
fi

echo
echo "Stack is running."
echo "n8n log: $N8N_LOG_FILE"
if [[ -n "$CLOUDFLARED_PID" ]]; then
	echo "cloudflared log: $CLOUDFLARED_LOG_FILE"
fi
echo "Local editor: http://${N8N_LISTEN_ADDRESS}:${N8N_PORT}"
echo "Public editor: $N8N_EDITOR_BASE_URL"
echo "Press Ctrl+C to stop."

wait "$N8N_PID"
