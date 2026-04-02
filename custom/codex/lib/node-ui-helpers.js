"use strict";

function truncate(value, maxLength = 120) {
	const text = String(value || "");
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}...`;
}

function formatUsage(usage) {
	if (!usage || typeof usage !== "object") return null;
	const parts = [];
	if (usage.input_tokens !== undefined) parts.push(`input ${usage.input_tokens}`);
	if (usage.output_tokens !== undefined) parts.push(`output ${usage.output_tokens}`);
	if (usage.cached_input_tokens !== undefined) {
		parts.push(`cached ${usage.cached_input_tokens}`);
	}
	return parts.length > 0 ? parts.join(", ") : null;
}

function buildEventLogKey(event) {
	if (!event || typeof event !== "object") return "unknown";
	if (event.type === "thread.started") return `thread:${event.thread_id || "unknown"}`;
	if (event.type === "turn.started") return "turn:started";
	if (event.type === "turn.completed") {
		return `turn:completed:${JSON.stringify(event.usage || {})}`;
	}
	if (event.type === "turn.failed") {
		return `turn:failed:${event.error?.message || "unknown"}`;
	}
	if (event.type === "error") return `error:${event.message || "unknown"}`;

	const item = event.item;
	if (!item || typeof item !== "object") return `${event.type}:unknown`;
	const state = item.status || event.type;
	return `${event.type}:${item.type}:${item.id || "unknown"}:${state}`;
}

function buildEventLogMessage(event) {
	if (!event || typeof event !== "object") return null;

	switch (event.type) {
		case "thread.started":
			return `Codex thread started: ${event.thread_id}`;
		case "turn.started":
			return "Codex turn started";
		case "turn.completed": {
			const usageText = formatUsage(event.usage);
			return usageText
				? `Codex turn completed (${usageText})`
				: "Codex turn completed";
		}
		case "turn.failed":
			return `Codex turn failed: ${event.error?.message || "Unknown error"}`;
		case "error":
			return `Codex error: ${event.message || "Unknown error"}`;
		default:
			break;
	}

	const item = event.item;
	if (!item || typeof item !== "object") return null;

	if (event.type === "item.updated" && item.type !== "agent_message") {
		return null;
	}

	if (item.type === "command_execution") {
		if (event.type === "item.started") {
			return `Command started: ${truncate(item.command, 160)}`;
		}
		if (event.type === "item.completed") {
			const exitInfo =
				item.exit_code !== undefined ? ` (exit ${item.exit_code})` : "";
			return `Command ${item.status || "completed"}: ${truncate(
				item.command,
				160,
			)}${exitInfo}`;
		}
	}

	if (item.type === "mcp_tool_call") {
		const label = `${item.server || "server"}.${item.tool || "tool"}`;
		if (event.type === "item.started") {
			return `MCP call started: ${label}`;
		}
		if (event.type === "item.completed") {
			if (item.error?.message) {
				return `MCP call failed: ${label} (${truncate(item.error.message, 160)})`;
			}
			return `MCP call ${item.status || "completed"}: ${label}`;
		}
	}

	if (item.type === "file_change" && event.type === "item.completed") {
		const count = Array.isArray(item.changes) ? item.changes.length : 0;
		return `File changes ${item.status || "completed"}: ${count} file(s)`;
	}

	if (item.type === "web_search" && event.type === "item.completed") {
		return `Web search completed: ${truncate(item.query, 160)}`;
	}

	if (item.type === "reasoning" && event.type === "item.completed") {
		return `Reasoning: ${truncate(item.text, 160)}`;
	}

	if (item.type === "agent_message" && event.type === "item.completed") {
		return "Codex response ready";
	}

	return null;
}

function extractAgentMessageDelta(event, messageState) {
	if (!event || typeof event !== "object") return "";
	if (event.type !== "item.updated" && event.type !== "item.completed") return "";
	if (event.item?.type !== "agent_message") return "";

	const itemId = event.item.id || "agent_message";
	const currentText = String(event.item.text || "");
	const previousText = messageState.get(itemId) || "";

	if (!currentText || currentText === previousText) return "";

	const delta = currentText.startsWith(previousText)
		? currentText.slice(previousText.length)
		: currentText;
	messageState.set(itemId, currentText);
	return delta;
}

function safeSendMessageToUi(context, message) {
	if (!message || typeof context?.sendMessageToUI !== "function") return;
	try {
		context.sendMessageToUI(message);
	} catch {}
}

function safeLogAiEvent(context, eventName, message) {
	if (!message || typeof context?.logAiEvent !== "function") return;
	try {
		context.logAiEvent(eventName, message);
	} catch {}
}

function resolveChatResponseMode(context) {
	if (typeof context?.getChatTrigger !== "function") return null;
	try {
		const chatTrigger = context.getChatTrigger();
		const responseMode = chatTrigger?.parameters?.options?.responseMode;
		return typeof responseMode === "string" ? responseMode : null;
	} catch {
		return null;
	}
}

function resolveLiveStreamingReason(context, options, liveStreamingEnabled) {
	if (!options?.streaming) {
		return "Streaming option is disabled in the node.";
	}

	if (liveStreamingEnabled) {
		return null;
	}

	if (typeof context?.isStreaming !== "function") {
		return "This n8n execution context does not expose live chunk streaming APIs to the node.";
	}

	const mode = typeof context?.getMode === "function" ? context.getMode() : null;
	const supportedModes = ["manual", "webhook", "integrated", "chat"];
	if (mode && !supportedModes.includes(mode)) {
		return `The current n8n execution mode "${mode}" does not support live chunk streaming.`;
	}

	if (mode === "chat") {
		const responseMode = resolveChatResponseMode(context);
		if (responseMode && responseMode !== "streaming") {
			return `The upstream "When chat message received" trigger is using Response Mode = ${responseMode}. n8n only attaches live sendChunk handlers for chat executions when Response Mode = Streaming.`;
		}
		return 'n8n did not attach active sendChunk handlers for this chat execution. In chat workflows this usually means the upstream "When chat message received" trigger is not using Response Mode = Streaming, so the SDK stream was collected internally and only the final result was rendered.';
	}

	return "n8n did not attach active sendChunk handlers for this execution, so the SDK stream was collected internally and only the final result was rendered.";
}

function createCodexUiHooks(context, itemIndex, options = {}) {
	const liveStreamingEnabled =
		Boolean(options.streaming) &&
		typeof context.isStreaming === "function" &&
		context.isStreaming();
	const chatResponseMode = resolveChatResponseMode(context);
	const liveStreamingReason = resolveLiveStreamingReason(
		context,
		options,
		liveStreamingEnabled,
	);
	const emittedLogs = new Set();
	const agentMessageState = new Map();

	return {
		liveStreamingEnabled,
		chatResponseMode,
		liveStreamingReason,
		hooks: {
			onStreamBegin: async () => {
				safeSendMessageToUi(context, "Codex streaming started");
				if (liveStreamingEnabled && typeof context.sendChunk === "function") {
					await context.sendChunk("begin", itemIndex);
				}
			},
			onEvent: async (event) => {
				const logKey = buildEventLogKey(event);
				const message = buildEventLogMessage(event);
				if (message && !emittedLogs.has(logKey)) {
					emittedLogs.add(logKey);
					safeSendMessageToUi(context, message);
				}

				if (
					event?.type === "item.completed" &&
					event.item?.type === "mcp_tool_call"
				) {
					const item = event.item;
					safeLogAiEvent(
						context,
						"ai-tool-called",
						JSON.stringify({
							tool: item.tool || "tool",
							server: item.server || "server",
							status: item.status || "unknown",
						}),
					);
				}

				if (liveStreamingEnabled && typeof context.sendChunk === "function") {
					const delta = extractAgentMessageDelta(event, agentMessageState);
					if (delta) {
						await context.sendChunk("item", itemIndex, delta);
					}
				}
			},
			onStreamEnd: async () => {
				safeSendMessageToUi(context, "Codex streaming finished");
				if (liveStreamingEnabled && typeof context.sendChunk === "function") {
					await context.sendChunk("end", itemIndex);
				}
			},
		},
	};
}

function emitCodexResultToUi(context, result) {
	if (typeof context?.sendMessageToUI !== "function" || !result) return;

	const summaryParts = [];
	if (result.eventTypes && typeof result.eventTypes === "object") {
		summaryParts.push(
			`events ${Object.keys(result.eventTypes).length > 0 ? JSON.stringify(result.eventTypes) : "{}"}`,
		);
	}
	if (Array.isArray(result.mcpCalls) && result.mcpCalls.length > 0) {
		summaryParts.push(`mcp ${result.mcpCalls.length}`);
	}
	if (Array.isArray(result.commands) && result.commands.length > 0) {
		summaryParts.push(`commands ${result.commands.length}`);
	}
	safeSendMessageToUi(
		context,
		`Codex completed${summaryParts.length > 0 ? ` (${summaryParts.join(", ")})` : ""}`,
	);

	for (const call of result.mcpCalls || []) {
		const state = call.ok ? "ok" : call.status || "unknown";
		safeSendMessageToUi(
			context,
			`MCP summary: ${call.server || "server"}.${call.tool || "tool"} -> ${state}`,
		);
	}

	for (const command of result.commands || []) {
		const exitInfo =
			command.exitCode !== null && command.exitCode !== undefined
				? ` (exit ${command.exitCode})`
				: "";
		safeSendMessageToUi(
			context,
			`Command summary: ${truncate(command.command, 160)} -> ${command.status || "unknown"}${exitInfo}`,
		);
	}

	if (result.contextPressure?.level && result.contextPressure.level !== "low") {
		safeSendMessageToUi(
			context,
			`Context pressure: ${result.contextPressure.level} (${result.contextPressure.inputTokens} input tokens)`,
		);
	}
}

function addCodexExecutionHints(context, options, result, liveStreamingEnabled) {
	if (typeof context?.addExecutionHints !== "function" || !result) return;

	const hints = [];

	if (options.streaming && !liveStreamingEnabled) {
		hints.push({
			message:
				'Streaming is enabled, but this execution context did not activate live UI chunks. The SDK stream was still collected internally and returned at the end.',
			type: "info",
			location: "outputPane",
		});
	}

	if (!options.includeEvents && result.storedEventCount > 0) {
		hints.push({
			message: `Codex stored ${result.storedEventCount} events for this run. Turn on "Include Events In Output" to inspect the raw SDK events in the Output panel.`,
			type: "info",
			location: "outputPane",
		});
	}

	if (Array.isArray(result.mcpCalls) && result.mcpCalls.length > 0) {
		const labels = result.mcpCalls
			.slice(0, 3)
			.map((entry) => `${entry.server || "server"}.${entry.tool || "tool"}`)
			.join(", ");
		hints.push({
			message: `Codex used MCP in this run: ${labels}`,
			type: "info",
			location: "outputPane",
		});
	}

	if (result.contextPressure?.level === "high" || result.contextPressure?.level === "critical") {
		hints.push({
			message: result.recommendedAction,
			type: "warning",
			location: "outputPane",
		});
	}

	if (
		(options.autoCompactTokenLimit || 0) === 0 &&
		(result.contextPressure?.level === "high" ||
			result.contextPressure?.level === "critical")
	) {
		hints.push({
			message:
				'Auto Compact Token Limit is currently 0. If you keep using Auto Resume on long-running sessions, consider setting a threshold such as 120000 so Codex can compact earlier.',
			type: "info",
			location: "outputPane",
		});
	}

	if (result.mcpConfigured?.serverCount > 0) {
		hints.push({
			message:
				"Codex MCP Toolset nodes provide configuration only. Runtime MCP calls and execution details appear on Codex Agent output.",
			type: "info",
			location: "outputPane",
		});
	}

	if (hints.length > 0) {
		context.addExecutionHints(...hints);
	}
}

module.exports = {
	addCodexExecutionHints,
	createCodexUiHooks,
	emitCodexResultToUi,
};
