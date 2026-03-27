"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

function safeJsonClone(value) {
	if (value === undefined) return {};
	return JSON.parse(JSON.stringify(value));
}

function normalizeEvents(events, fallbackThreadId = null) {
	return (Array.isArray(events) ? events : []).map((event, index) => ({
		seq: index + 1,
		threadId:
			event?.thread_id ||
			event?.threadId ||
			event?.item?.thread_id ||
			fallbackThreadId ||
			null,
		eventType: event?.type || "unknown",
		ts:
			event?.ts ||
			event?.timestamp ||
			event?.created_at ||
			new Date().toISOString(),
		payloadJson: safeJsonClone(event),
	}));
}

function resolveArtifactPath(workingDirectory, rawPath) {
	if (!rawPath || typeof rawPath !== "string") return rawPath || "";
	return path.isAbsolute(rawPath)
		? rawPath
		: path.resolve(workingDirectory || process.cwd(), rawPath);
}

function extractArtifactsFromEvents(events, workingDirectory) {
	const artifacts = [];
	const seen = new Set();

	for (const event of Array.isArray(events) ? events : []) {
		const item = event?.item;
		if (!item || typeof item !== "object") continue;

		if (item.type === "command_execution") {
			const key = `command:${item.id}:${item.command}`;
			if (!seen.has(key)) {
				artifacts.push({
					kind: "command",
					label: item.status || "command_execution",
					command: item.command || "",
					cwd: workingDirectory,
					exitCode: item.exit_code ?? null,
					payload: item,
				});
				seen.add(key);
			}
		}

		if (item.type === "file_change") {
			const filePaths = Array.isArray(item.changes)
				? item.changes.map((change) =>
						resolveArtifactPath(workingDirectory, change.path),
				  )
				: [];
			const key = `file_change:${item.id}:${filePaths.join("|")}`;
			if (!seen.has(key)) {
				artifacts.push({
					kind: "file_change",
					label: item.status || "file_change",
					filePaths,
					payload: item,
				});
				seen.add(key);
			}
		}

		if (item.type === "mcp_tool_call") {
			const key = `mcp:${item.id}:${item.server}:${item.tool}`;
			if (!seen.has(key)) {
				artifacts.push({
					kind: "mcp_tool_call",
					label: `${item.server || "server"}:${item.tool || "tool"}`,
					payload: item,
				});
				seen.add(key);
			}
		}

		if (item.type === "web_search") {
			const key = `web:${item.id}:${item.query}`;
			if (!seen.has(key)) {
				artifacts.push({
					kind: "web_search",
					label: item.query || "web_search",
					payload: item,
				});
				seen.add(key);
			}
		}
	}

	return artifacts;
}

function captureGitArtifacts(workingDirectory) {
	if (!workingDirectory) return [];

	const status = runGitCommand(workingDirectory, ["status", "--short"]);
	if (!status.ok) return [];

	const artifacts = [];
	const changedFiles = status.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.replace(/^[A-Z? ]+/, "").trim())
		.filter(Boolean)
		.map((filePath) => resolveArtifactPath(workingDirectory, filePath));

	if (changedFiles.length > 0) {
		artifacts.push({
			kind: "git_status",
			label: "git status --short",
			filePaths: changedFiles,
			payload: {
				output: status.stdout,
			},
		});
	}

	const diffNames = runGitCommand(workingDirectory, [
		"diff",
		"--no-ext-diff",
		"--name-only",
	]);
	if (diffNames.ok && diffNames.stdout.trim()) {
		artifacts.push({
			kind: "git_diff",
			label: "git diff --name-only",
			filePaths: diffNames.stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean)
				.map((filePath) => resolveArtifactPath(workingDirectory, filePath)),
			payload: {
				output: diffNames.stdout,
			},
		});
	}

	const diffStat = runGitCommand(workingDirectory, ["diff", "--no-ext-diff", "--stat"]);
	if (diffStat.ok && diffStat.stdout.trim()) {
		artifacts.push({
			kind: "git_diff_stat",
			label: "git diff --stat",
			payload: {
				output: diffStat.stdout,
			},
		});
	}

	return artifacts;
}

function runGitCommand(cwd, args) {
	try {
		const result = spawnSync("git", args, {
			cwd,
			encoding: "utf8",
			windowsHide: true,
			timeout: 15000,
		});

		if (result.error || result.status !== 0) {
			return {
				ok: false,
				stdout: result.stdout || "",
				stderr: result.stderr || result.error?.message || "",
			};
		}

		return {
			ok: true,
			stdout: result.stdout || "",
			stderr: result.stderr || "",
		};
	} catch (error) {
		return {
			ok: false,
			stdout: "",
			stderr: error.message,
		};
	}
}

function buildArtifactsSummary(artifacts) {
	const summary = {
		total: 0,
		kinds: {},
		commands: [],
		filePaths: [],
	};

	for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
		summary.total += 1;
		summary.kinds[artifact.kind] = (summary.kinds[artifact.kind] || 0) + 1;

		if (artifact.command && summary.commands.length < 10) {
			summary.commands.push(artifact.command);
		}

		for (const filePath of artifact.filePaths || []) {
			if (summary.filePaths.length >= 25) break;
			if (!summary.filePaths.includes(filePath)) {
				summary.filePaths.push(filePath);
			}
		}
	}

	return summary;
}

module.exports = {
	buildArtifactsSummary,
	captureGitArtifacts,
	extractArtifactsFromEvents,
	normalizeEvents,
};
