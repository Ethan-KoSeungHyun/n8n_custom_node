"use strict";

function truncate(value, maxLength = 120) {
	const text = String(value || "");
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}...`;
}

function formatUsage(usage) {
	if (!usage || typeof usage !== "object") return null;
	const parts = [];
	if (usage.input_tokens !== undefined) parts.push(`입력 ${usage.input_tokens}`);
	if (usage.output_tokens !== undefined) parts.push(`출력 ${usage.output_tokens}`);
	if (usage.cached_input_tokens !== undefined) {
		parts.push(`캐시 ${usage.cached_input_tokens}`);
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
			return `Codex 스레드 시작: ${event.thread_id}`;
		case "turn.started":
			return "Codex 턴 시작";
		case "turn.completed": {
			const usageText = formatUsage(event.usage);
			return usageText
				? `Codex 턴 완료 (${usageText})`
				: "Codex 턴 완료";
		}
		case "turn.failed":
			return `Codex 턴 실패: ${event.error?.message || "알 수 없는 오류"}`;
		case "error":
			return `Codex 오류: ${event.message || "알 수 없는 오류"}`;
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
			return `명령 시작: ${truncate(item.command, 160)}`;
		}
		if (event.type === "item.completed") {
			const exitInfo =
				item.exit_code !== undefined ? ` (exit ${item.exit_code})` : "";
			return `명령 ${item.status || "완료"}: ${truncate(
				item.command,
				160,
			)}${exitInfo}`;
		}
	}

	if (item.type === "mcp_tool_call") {
		const label = `${item.server || "server"}.${item.tool || "tool"}`;
		if (event.type === "item.started") {
			return `MCP 호출 시작: ${label}`;
		}
		if (event.type === "item.completed") {
			if (item.error?.message) {
				return `MCP 호출 실패: ${label} (${truncate(item.error.message, 160)})`;
			}
			return `MCP 호출 ${item.status || "완료"}: ${label}`;
		}
	}

	if (item.type === "file_change" && event.type === "item.completed") {
		const count = Array.isArray(item.changes) ? item.changes.length : 0;
		return `파일 변경 ${item.status || "완료"}: ${count}개 파일`;
	}

	if (item.type === "web_search" && event.type === "item.completed") {
		return `웹 검색 완료: ${truncate(item.query, 160)}`;
	}

	if (item.type === "reasoning" && event.type === "item.completed") {
		return `추론: ${truncate(item.text, 160)}`;
	}

	if (item.type === "agent_message" && event.type === "item.completed") {
		return "Codex 응답 준비 완료";
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
		return "노드에서 스트리밍 옵션이 비활성화되어 있습니다.";
	}

	if (liveStreamingEnabled) {
		return null;
	}

	if (typeof context?.isStreaming !== "function") {
		return "이 n8n 실행 컨텍스트는 노드에 라이브 청크 스트리밍 API를 제공하지 않습니다.";
	}

	const mode = typeof context?.getMode === "function" ? context.getMode() : null;
	const supportedModes = ["manual", "webhook", "integrated", "chat"];
	if (mode && !supportedModes.includes(mode)) {
		return `현재 n8n 실행 모드 "${mode}"는 라이브 청크 스트리밍을 지원하지 않습니다.`;
	}

	if (mode === "chat") {
		const responseMode = resolveChatResponseMode(context);
		if (responseMode && responseMode !== "streaming") {
			return `상위 "When chat message received" 트리거의 Response Mode가 ${responseMode}입니다. n8n은 Response Mode = Streaming일 때만 라이브 sendChunk 핸들러를 연결합니다.`;
		}
		return '이 채팅 실행에 n8n이 활성 sendChunk 핸들러를 연결하지 않았습니다. 채팅 워크플로에서는 일반적으로 상위 "When chat message received" 트리거의 Response Mode가 Streaming이 아니기 때문입니다. SDK 스트림은 내부에서 수집되어 최종 결과만 렌더링됩니다.';
	}

	return "이 실행에 n8n이 활성 sendChunk 핸들러를 연결하지 않아 SDK 스트림이 내부에서 수집되었으며, 최종 결과만 렌더링됩니다.";
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
				safeSendMessageToUi(context, "Codex 스트리밍 시작");
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
				safeSendMessageToUi(context, "Codex 스트리밍 완료");
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
			`이벤트 ${Object.keys(result.eventTypes).length > 0 ? JSON.stringify(result.eventTypes) : "{}"}`,
		);
	}
	if (Array.isArray(result.mcpCalls) && result.mcpCalls.length > 0) {
		summaryParts.push(`MCP ${result.mcpCalls.length}건`);
	}
	if (Array.isArray(result.commands) && result.commands.length > 0) {
		summaryParts.push(`명령 ${result.commands.length}건`);
	}
	safeSendMessageToUi(
		context,
		`Codex 완료${summaryParts.length > 0 ? ` (${summaryParts.join(", ")})` : ""}`,
	);

	for (const call of result.mcpCalls || []) {
		const state = call.ok ? "성공" : call.status || "알 수 없음";
		safeSendMessageToUi(
			context,
			`MCP 요약: ${call.server || "server"}.${call.tool || "tool"} → ${state}`,
		);
	}

	for (const command of result.commands || []) {
		const exitInfo =
			command.exitCode !== null && command.exitCode !== undefined
				? ` (exit ${command.exitCode})`
				: "";
		safeSendMessageToUi(
			context,
			`명령 요약: ${truncate(command.command, 160)} → ${command.status || "알 수 없음"}${exitInfo}`,
		);
	}

	if (result.contextPressure?.level && result.contextPressure.level !== "low") {
		safeSendMessageToUi(
			context,
			`컨텍스트 부하: ${result.contextPressure.level} (입력 토큰 ${result.contextPressure.inputTokens}개)`,
		);
	}
}

function addCodexExecutionHints(context, options, result, liveStreamingEnabled) {
	if (typeof context?.addExecutionHints !== "function" || !result) return;

	const hints = [];

	if (options.streaming && !liveStreamingEnabled) {
		hints.push({
			message:
				'스트리밍이 활성화되어 있지만 이 실행 컨텍스트에서 라이브 UI 청크가 활성화되지 않았습니다. SDK 스트림은 내부에서 수집되어 최종 결과로 반환되었습니다.',
			type: "info",
			location: "outputPane",
		});
	}

	if (!options.includeEvents && result.storedEventCount > 0) {
		hints.push({
			message: `이 실행에서 Codex가 ${result.storedEventCount}개의 이벤트를 저장했습니다. Output 패널에서 원시 SDK 이벤트를 확인하려면 "Include Events In Output" 옵션을 켜세요.`,
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
			message: `이 실행에서 Codex가 MCP를 사용했습니다: ${labels}`,
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
				'Auto Compact Token Limit이 현재 0입니다. 장시간 세션에서 Auto Resume을 계속 사용할 경우, Codex가 더 빨리 압축할 수 있도록 120000 같은 임계값을 설정하는 것을 권장합니다.',
			type: "info",
			location: "outputPane",
		});
	}

	if (result.mcpConfigured?.serverCount > 0) {
		hints.push({
			message:
				"Codex MCP Toolset 노드는 설정만 제공합니다. 런타임 MCP 호출 및 실행 상세는 Codex Agent 출력에 표시됩니다.",
			type: "info",
			location: "outputPane",
		});
	}

	if (hints.length > 0) {
		context.addExecutionHints(...hints);
	}
}

// ── Logs 트리 브릿지 포맷터 ─────────────────────────────────
// Memory 노드의 loggingBridge를 통해 n8n Logs 트리에 기록할 때
// 각 SDK 이벤트 종류별로 INPUT/OUTPUT 데이터를 정형화합니다.

function formatBridgeInput(event) {
	const item = event.item;
	if (!item || typeof item !== "object") return { 이벤트: event.type || "알 수 없음" };

	const base = {};
	if (item.id) base.id = item.id;

	switch (item.type) {
		case "command_execution":
			return { ...base, 종류: "명령 실행", 명령어: item.command || "(없음)" };
		case "mcp_tool_call":
			return {
				...base,
				종류: "MCP 도구 호출",
				서버: item.server || "(알 수 없음)",
				도구: item.tool || "(알 수 없음)",
				...(item.arguments ? { 인자: item.arguments } : {}),
			};
		case "file_change":
			return {
				...base,
				종류: "파일 변경",
				...(Array.isArray(item.changes)
					? { 파일: item.changes.map((c) => c.path || c.file).filter(Boolean) }
					: {}),
			};
		case "web_search":
			return { ...base, 종류: "웹 검색", 검색어: item.query || "(없음)" };
		case "reasoning":
			return { ...base, 종류: "추론" };
		default:
			return { ...base, 종류: item.type || "알 수 없음" };
	}
}

function formatBridgeOutput(event) {
	const item = event.item;
	if (!item || typeof item !== "object") return { 이벤트: event.type || "알 수 없음" };

	const base = {};
	if (item.id) base.id = item.id;
	base.상태 = item.status || "완료";

	switch (item.type) {
		case "command_execution":
			return {
				...base,
				종류: "명령 실행",
				종료코드: item.exit_code,
				출력: truncate(item.aggregated_output || item.output || "", 500),
			};
		case "mcp_tool_call": {
			const r = { ...base, 종류: "MCP 도구 호출" };
			if (item.error?.message) r.오류 = truncate(item.error.message, 300);
			else if (item.result != null) r.결과 = truncate(String(item.result), 500);
			return r;
		}
		case "file_change":
			return {
				...base,
				종류: "파일 변경",
				변경수: Array.isArray(item.changes) ? item.changes.length : 0,
			};
		case "web_search":
			return {
				...base,
				종류: "웹 검색",
				결과수: Array.isArray(item.results) ? item.results.length : 0,
			};
		case "reasoning":
			return {
				...base,
				종류: "추론",
				내용: truncate(item.text || "", 300),
			};
		default:
			return { ...base, 종류: item.type || "알 수 없음" };
	}
}

/**
 * SDK 이벤트를 Memory 노드의 loggingBridge를 통해 n8n Logs 트리에
 * 기록하는 래핑된 hooks 객체를 반환합니다.
 *
 * bridge가 null이면 원본 hooks를 그대로 반환합니다.
 * 비스트리밍 모드에서는 SDK가 hooks를 호출하지 않으므로 Logs 항목이
 * 생성되지 않습니다 — 이는 의도된 동작입니다.
 *
 * @param {object|null} hooks  기존 UI hooks (onStreamBegin, onEvent, onStreamEnd)
 * @param {object|null} bridge CodexMemory.supplyData()가 생성한 loggingBridge
 * @returns {object} 래핑된 hooks
 */
function wrapHooksWithBridge(hooks, bridge) {
	if (!bridge) return hooks;

	const LOGGABLE_ITEM_TYPES = new Set([
		"command_execution",
		"mcp_tool_call",
		"file_change",
		"web_search",
		"reasoning",
	]);

	const bridgeRunMap = new Map();
	let bridgeSeq = 0;
	let lastAgentMessage = "";

	return {
		...(hooks || {}),
		onEvent: async (event) => {
			await hooks?.onEvent?.(event);

			try {
				// ── 에이전트 응답 텍스트 추적 (턴 요약에 포함) ──
				if (
					(event.type === "item.updated" ||
						event.type === "item.completed") &&
					event.item?.type === "agent_message" &&
					event.item?.text
				) {
					lastAgentMessage = event.item.text;
				}

				// ── 턴 요약: 도구 사용 여부와 관계없이 항상 기록 ──
				// n8n 빌트인 AI Agent의 LLM 모델 로그와 동일한 역할
				if (event.type === "turn.completed") {
					const usage = event.usage || {};
					const turnInput = { 종류: "Codex 턴" };
					const turnOutput = {
						종류: "Codex 턴",
						상태: "완료",
						...(lastAgentMessage
							? { 응답: truncate(lastAgentMessage, 300) }
							: {}),
						입력토큰: usage.input_tokens || 0,
						출력토큰: usage.output_tokens || 0,
						...(usage.cached_input_tokens
							? { 캐시토큰: usage.cached_input_tokens }
							: {}),
					};
					const idx = bridge.logToolStart(turnInput);
					if (idx >= 0) bridge.logToolEnd(idx, turnOutput);
					return;
				}

				// ── 도구 호출 이벤트 ──
				const itemType = event?.item?.type;
				if (!itemType || !LOGGABLE_ITEM_TYPES.has(itemType)) return;

				if (event.type === "item.started") {
					const itemId = event.item.id || `__bridge_${++bridgeSeq}`;
					const runIndex = bridge.logToolStart(formatBridgeInput(event));
					if (runIndex >= 0) {
						bridgeRunMap.set(itemId, runIndex);
					}
				} else if (event.type === "item.completed") {
					const itemId = event.item.id;
					const runIndex =
						itemId != null ? bridgeRunMap.get(itemId) : undefined;
					if (runIndex !== undefined) {
						bridge.logToolEnd(runIndex, formatBridgeOutput(event));
						bridgeRunMap.delete(itemId);
					} else {
						// 매칭되는 item.started가 없는 경우 (비스트리밍 모드 등)
						const idx = bridge.logToolStart(formatBridgeInput(event));
						if (idx >= 0) {
							bridge.logToolEnd(idx, formatBridgeOutput(event));
						}
					}
				}
			} catch (_e) {
				// Bridge 오류가 메인 실행을 차단하면 안 됨
			}
		},
	};
}

module.exports = {
	addCodexExecutionHints,
	createCodexUiHooks,
	emitCodexResultToUi,
	wrapHooksWithBridge,
};
