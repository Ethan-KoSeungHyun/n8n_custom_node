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

function getLatestThreadItems(events) {
	const latestItems = new Map();

	for (const event of Array.isArray(events) ? events : []) {
		const item = event?.item;
		if (!item || typeof item !== "object" || !item.id || !item.type) continue;
		latestItems.set(`${item.type}:${item.id}`, item);
	}

	return [...latestItems.values()];
}

function truncateText(value, maxLength = 240) {
	const text = String(value ?? "");
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}...`;
}

function tryParseJsonText(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}

function summarizeJsonValue(value, maxItems = 5) {
	if (value === null || value === undefined) return value ?? null;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.slice(0, maxItems).map((entry) => summarizeJsonValue(entry, maxItems));
	}
	if (typeof value === "object") {
		const priorityKeys = [
			"name",
			"key",
			"id",
			"title",
			"summary",
			"displayName",
			"username",
			"status",
			"text",
			"message",
			"type",
		];
		const output = {};
		for (const key of priorityKeys) {
			if (key in value) output[key] = summarizeJsonValue(value[key], maxItems);
			if (Object.keys(output).length >= maxItems) return output;
		}
		for (const [key, entry] of Object.entries(value)) {
			if (key in output) continue;
			output[key] = summarizeJsonValue(entry, maxItems);
			if (Object.keys(output).length >= maxItems) break;
		}
		return output;
	}
	return String(value);
}

function summarizeContentBlocks(content, maxLength = 240) {
	if (!Array.isArray(content) || content.length === 0) return null;
	const firstTextBlock = content.find(
		(entry) => entry && typeof entry === "object" && entry.type === "text",
	);
	if (!firstTextBlock?.text) return null;

	const parsed = tryParseJsonText(firstTextBlock.text);
	if (parsed !== null) {
		return summarizeJsonValue(parsed);
	}

	return truncateText(firstTextBlock.text, maxLength);
}

function summarizeMcpResult(item, maxLength = 240) {
	if (!item || typeof item !== "object") return null;
	if (item.error?.message) {
		return truncateText(item.error.message, maxLength);
	}

	if (item.result?.structured_content !== undefined && item.result?.structured_content !== null) {
		return summarizeJsonValue(item.result.structured_content);
	}

	return summarizeContentBlocks(item.result?.content, maxLength);
}

function summarizeMcpArguments(item, maxLength = 240) {
	if (!item || typeof item !== "object") return null;
	const args = item.arguments;
	if (args === undefined || args === null) return null;
	if (typeof args === "string") return truncateText(args, maxLength);
	return summarizeJsonValue(args);
}

function summarizeCommandOutput(item, maxLength = 240) {
	if (!item || typeof item !== "object" || !item.aggregated_output) return null;
	return truncateText(item.aggregated_output, maxLength);
}

function createTimelineEntry(index, phase, label, extra = {}) {
	return {
		index,
		phase,
		label,
		...extra,
	};
}

function extractArtifactsFromEvents(events, workingDirectory) {
	const artifacts = [];
	for (const item of getLatestThreadItems(events)) {
		if (item.type === "command_execution") {
			artifacts.push({
				kind: "command",
				label: item.status || "command_execution",
				command: item.command || "",
				cwd: workingDirectory,
				exitCode: item.exit_code ?? null,
				payload: item,
			});
		}

		if (item.type === "file_change") {
			const filePaths = Array.isArray(item.changes)
				? item.changes.map((change) =>
						resolveArtifactPath(workingDirectory, change.path),
				  )
				: [];
			artifacts.push({
				kind: "file_change",
				label: item.status || "file_change",
				filePaths,
				payload: item,
			});
		}

		if (item.type === "mcp_tool_call") {
			artifacts.push({
				kind: "mcp_tool_call",
				label: `${item.server || "server"}:${item.tool || "tool"}`,
				payload: item,
			});
		}

		if (item.type === "web_search") {
			artifacts.push({
				kind: "web_search",
				label: item.query || "web_search",
				payload: item,
			});
		}
	}

	return artifacts;
}

function buildEventTypesSummary(events) {
	const summary = {};

	for (const event of Array.isArray(events) ? events : []) {
		const eventType = event?.type || "unknown";
		summary[eventType] = (summary[eventType] || 0) + 1;
	}

	return summary;
}

function summarizeCommands(events, limit = 10) {
	return getLatestThreadItems(events)
		.filter((item) => item.type === "command_execution")
		.slice(0, limit)
		.map((item) => ({
			command: item.command || "",
			status: item.status || "unknown",
			exitCode: item.exit_code ?? null,
			hasOutput: Boolean(item.aggregated_output),
			outputPreview: summarizeCommandOutput(item),
		}));
}

function summarizeMcpCalls(events, limit = 10, maxLength = 240) {
	return getLatestThreadItems(events)
		.filter((item) => item.type === "mcp_tool_call")
		.slice(0, limit)
		.map((item) => ({
			server: item.server || null,
			tool: item.tool || null,
			status: item.status || "unknown",
			ok: item.status === "completed" && !item.error,
			argumentsPreview: summarizeMcpArguments(item, maxLength),
			resultPreview: summarizeMcpResult(item, maxLength),
			errorMessage: item.error?.message || null,
			hasStructuredContent:
				item.result?.structured_content !== undefined &&
				item.result?.structured_content !== null,
		}));
}

function summarizeFileChanges(events, workingDirectory, limit = 25) {
	const filePaths = [];

	for (const item of getLatestThreadItems(events)) {
		if (item.type !== "file_change") continue;
		for (const change of item.changes || []) {
			const resolvedPath = resolveArtifactPath(workingDirectory, change?.path);
			if (!resolvedPath || filePaths.includes(resolvedPath)) continue;
			filePaths.push(resolvedPath);
			if (filePaths.length >= limit) return filePaths;
		}
	}

	return filePaths;
}

function buildProgressTimeline(events, options = {}) {
	const timeline = [];
	const maxLength = Number(options.eventContentMaxLength) || 240;
	const maxEntries = 50;

	for (const event of Array.isArray(events) ? events : []) {
		if (timeline.length >= maxEntries) break;
		const index = timeline.length + 1;
		if (event.type === "thread.started") {
			timeline.push(
				createTimelineEntry(index, "thread", "Thread started", {
					threadId: event.thread_id || null,
				}),
			);
			continue;
		}
		if (event.type === "turn.started") {
			timeline.push(createTimelineEntry(index, "turn", "Turn started"));
			continue;
		}
		if (event.type === "turn.completed") {
			timeline.push(
				createTimelineEntry(index, "turn", "Turn completed", {
					usage: event.usage || null,
				}),
			);
			continue;
		}

		const item = event.item;
		if (!item || typeof item !== "object") continue;

		if (item.type === "agent_message") {
			timeline.push(
				createTimelineEntry(index, "agent_message", "Agent message", {
					status: event.type === "item.started" ? "in_progress" : "completed",
					preview: truncateText(item.text, maxLength),
				}),
			);
			continue;
		}

		if (item.type === "mcp_tool_call") {
			timeline.push(
				createTimelineEntry(
					index,
					"mcp_tool_call",
					`${item.server || "server"}.${item.tool || "tool"}`,
					{
						status: item.status || "unknown",
						preview: summarizeMcpResult(item, maxLength),
					},
				),
			);
			continue;
		}

		if (item.type === "command_execution") {
			timeline.push(
				createTimelineEntry(index, "command_execution", item.command || "command", {
					status: item.status || "unknown",
					exitCode: item.exit_code ?? null,
					preview: summarizeCommandOutput(item, maxLength),
				}),
			);
			continue;
		}

		if (item.type === "file_change") {
			timeline.push(
				createTimelineEntry(index, "file_change", "File change", {
					status: item.status || "unknown",
					fileCount: Array.isArray(item.changes) ? item.changes.length : 0,
				}),
			);
			continue;
		}

		if (item.type === "reasoning") {
			timeline.push(
				createTimelineEntry(index, "reasoning", "Reasoning", {
					preview: truncateText(item.text, maxLength),
				}),
			);
			continue;
		}

		if (item.type === "web_search") {
			timeline.push(
				createTimelineEntry(index, "web_search", "Web search", {
					preview: truncateText(item.query, maxLength),
				}),
			);
			continue;
		}
	}

	return timeline;
}

function buildOutputEvents(events, options = {}) {
	const detail = options.eventPayloadDetail || "summary";
	if (detail === "full") {
		return Array.isArray(events) ? events : [];
	}

	const maxLength = Number(options.eventContentMaxLength) || 400;

	return (Array.isArray(events) ? events : []).map((event) => {
		if (event.type === "thread.started") {
			return {
				type: event.type,
				thread_id: event.thread_id || null,
			};
		}
		if (event.type === "turn.started") {
			return { type: event.type };
		}
		if (event.type === "turn.completed") {
			return {
				type: event.type,
				usage: event.usage || null,
			};
		}
		if (event.type === "turn.failed") {
			return {
				type: event.type,
				error: event.error || null,
			};
		}

		const item = event.item;
		if (!item || typeof item !== "object") {
			return { type: event.type || "unknown" };
		}

		const base = {
			type: event.type || "unknown",
			item: {
				id: item.id || null,
				type: item.type || null,
			},
		};

		if (item.status !== undefined) base.item.status = item.status;

		if (item.type === "agent_message" || item.type === "reasoning") {
			base.item.textPreview = truncateText(item.text, maxLength);
			return base;
		}

		if (item.type === "mcp_tool_call") {
			base.item.server = item.server || null;
			base.item.tool = item.tool || null;
			base.item.argumentsPreview = summarizeMcpArguments(item, maxLength);
			base.item.resultPreview = summarizeMcpResult(item, maxLength);
			base.item.errorMessage = item.error?.message || null;
			return base;
		}

		if (item.type === "command_execution") {
			base.item.command = item.command || "";
			base.item.exitCode = item.exit_code ?? null;
			base.item.outputPreview = summarizeCommandOutput(item, maxLength);
			return base;
		}

		if (item.type === "file_change") {
			base.item.changes = Array.isArray(item.changes)
				? item.changes.map((change) => ({
						path: change.path || null,
						kind: change.kind || null,
				  }))
				: [];
			return base;
		}

		if (item.type === "web_search") {
			base.item.query = truncateText(item.query, maxLength);
			return base;
		}

		if (item.type === "todo_list") {
			base.item.items = Array.isArray(item.items)
				? item.items.slice(0, 10).map((entry) => ({
						text: truncateText(entry.text, maxLength),
						completed: Boolean(entry.completed),
				  }))
				: [];
			return base;
		}

		if (item.type === "error") {
			base.item.message = truncateText(item.message, maxLength);
			return base;
		}

		return base;
	});
}

function buildContextPressure(usage, sessionStrategy, options = {}) {
	const inputTokens = Number(usage?.input_tokens || 0);
	const cachedInputTokens = Number(usage?.cached_input_tokens || 0);
	const outputTokens = Number(usage?.output_tokens || 0);
	const autoCompactTokenLimit = Number(options.autoCompactTokenLimit || 0);

	let level = "low";
	if (inputTokens >= 250000) {
		level = "critical";
	} else if (inputTokens >= 150000) {
		level = "high";
	} else if (inputTokens >= 80000) {
		level = "medium";
	}

	const thresholdExceeded =
		autoCompactTokenLimit > 0 && inputTokens >= autoCompactTokenLimit;

	let recommendedAction = "Current context size looks healthy.";
	if (level === "critical") {
		recommendedAction =
			sessionStrategy === "autoResume"
				? "This thread is carrying a very large context. Start a new thread soon or switch the next run to Always New."
				: "This run used a very large context. Consider shortening prompts, reducing retained history, or starting a fresh thread.";
	} else if (level === "high") {
		recommendedAction =
			"Context is getting large. Consider starting a fresh thread soon, especially if you keep using Auto Resume.";
	} else if (level === "medium") {
		recommendedAction =
			"Context growth is noticeable. Monitor token usage if this session continues for many turns.";
	}

	if (thresholdExceeded) {
		recommendedAction = `${recommendedAction} The configured auto-compact threshold was reached.`;
	}

	return {
		level,
		inputTokens,
		cachedInputTokens,
		outputTokens,
		cacheRatio:
			inputTokens > 0 ? Number((cachedInputTokens / inputTokens).toFixed(3)) : 0,
		autoCompactTokenLimit,
		thresholdExceeded,
		recommendedAction,
	};
}

function buildExecutionDetails(events, workingDirectory, options = {}) {
	return {
		eventTypes: buildEventTypesSummary(events),
		mcpCalls: summarizeMcpCalls(
			events,
			10,
			Number(options.eventContentMaxLength) || 240,
		),
		commands: summarizeCommands(events),
		fileChanges: summarizeFileChanges(events, workingDirectory),
		progressTimeline: buildProgressTimeline(events, options),
	};
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
		const isWindows = process.platform === "win32";
		const result = spawnSync("git", args, {
			cwd,
			encoding: "utf8",
			windowsHide: true,
			shell: isWindows,
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
	buildContextPressure,
	buildExecutionDetails,
	buildOutputEvents,
	captureGitArtifacts,
	extractArtifactsFromEvents,
	normalizeEvents,
};
