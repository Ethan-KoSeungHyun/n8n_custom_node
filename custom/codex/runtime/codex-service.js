"use strict";

const {
	buildArtifactsSummary,
	buildContextPressure,
	buildExecutionDetails,
	buildOutputEvents,
	captureGitArtifacts,
	extractArtifactsFromEvents,
	normalizeEvents,
} = require("../observability/codex-observability");
const { nowIso } = require("../store/codex-store-utils");
const {
	completeRun,
	createRun,
	insertRunArtifacts,
	insertRunEvents,
	listRecentTranscriptEntries,
	toBindingKey,
	upsertSessionBinding,
	getSessionBinding,
} = require("../store/codex-store");
const { runSdkAgent } = require("./sdk-runtime");
const { createMemory } = require("../store/codex-memory-store");
const { createLifecycleHooks } = require("../lib/codex-hooks");
const {
	buildSharedContext,
	buildDelegationContext,
	sendMessage,
} = require("../store/codex-agent-message-store");

function truncatePrompt(value, maxLength = 2000) {
	const text = String(value || "");
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}...`;
}

function shouldRecoverThread(error) {
	const message = String(error?.message || "").toLowerCase();
	return (
		((message.includes("thread") || message.includes("session")) &&
			(message.includes("not found") ||
				message.includes("invalid") ||
				message.includes("missing") ||
				message.includes("unknown"))) ||
		message.includes("no rollout found") ||
		message.includes("expired") ||
		(message.includes("does not exist") &&
			(message.includes("thread") || message.includes("session")))
	);
}

function resolveRuntime() {
	return "sdk";
}

function resolveInitialThreadId(request, binding) {
	if (request.sessionStrategy === "specificThreadId") {
		return request.threadId || null;
	}
	if (request.sessionStrategy === "lastThread") {
		return null;
	}
	if (request.sessionStrategy === "alwaysNew") {
		return null;
	}
	return binding?.threadId || null;
}

function deriveUsedMcpServers(mcpCalls) {
	return [...new Set((Array.isArray(mcpCalls) ? mcpCalls : []).map((entry) => entry.server).filter(Boolean))];
}

function deriveUnusedMcpServers(mcpConfigured, usedMcpServers) {
	const configuredServers = (mcpConfigured?.servers || [])
		.map((entry) => entry.serverName)
		.filter(Boolean);
	return configuredServers.filter((name) => !usedMcpServers.includes(name));
}

function buildRunResultPayload(request, result, artifacts, storedEventCount, sessionRecovered) {
	const executionDetails = buildExecutionDetails(
		result.events,
		request.workingDirectory,
		request.options,
	);
	const contextPressure = buildContextPressure(
		result.usage || null,
		request.sessionStrategy,
		request.options,
	);
	const mcpConfigured = request.mcpConfigured || {
		serverCount: 0,
		servers: [],
		toolsetNodesAreConfigurationOnly: true,
		runtimeEventsAppearOn: "Codex Agent",
	};
	const usedMcpServers = deriveUsedMcpServers(executionDetails.mcpCalls);
	const unusedMcpServers = deriveUnusedMcpServers(mcpConfigured, usedMcpServers);

	return {
		runId: request.runStart.id,
		runtime: request.runtime,
		threadId: result.threadId || null,
		sessionId: request.sessionId || null,
		profileKey: request.profileKey || null,
		resolvedCredentialId: request.resolvedCredentialId || null,
		authFingerprintAtRun: request.authFingerprintAtRun || null,
		finalResponse: result.finalResponse || "",
		parsedFinalResponse: result.parsedFinalResponse || null,
		usage: result.usage || null,
		contextPressure,
		recommendedAction: contextPressure.recommendedAction,
		stderr: result.stderr || "",
		eventPayloadDetail: request.options?.eventPayloadDetail || "summary",
		events: Boolean(request.options?.includeEvents)
			? buildOutputEvents(result.events, request.options)
			: undefined,
		storedEventCount,
		artifactsSummary: buildArtifactsSummary(artifacts),
		eventTypes: executionDetails.eventTypes,
		mcpCalls: executionDetails.mcpCalls,
		mcpConfigured,
		usedMcpServers,
		unusedMcpServers,
		commands: executionDetails.commands,
		fileChanges: executionDetails.fileChanges,
		progressTimeline: executionDetails.progressTimeline,
		sessionRecovered,
	};
}

async function executeRecoveredRun(request) {
	const recoveredResult = await executeWithRuntime({
		...request,
		threadId: null,
		transcriptEntries: [],
	});
	const normalizedEvents = normalizeEvents(
		recoveredResult.events,
		recoveredResult.threadId || null,
	);
	const artifacts = [
		...extractArtifactsFromEvents(recoveredResult.events, request.workingDirectory),
		...captureGitArtifacts(request.workingDirectory),
		{
			kind: "session_recovery",
			label: "Recovered from invalid thread",
			payload: {
				previousThreadId: request.binding.threadId,
				newThreadId: recoveredResult.threadId,
			},
		},
	];
	const storedEventCount = await insertRunEvents(request.runStart.id, normalizedEvents);
	await insertRunArtifacts(request.runStart.id, artifacts);
	const recoveredBinding = await upsertSessionBinding({
		id: request.binding.id,
		bindingKey: request.bindingKey,
		workflowId: request.workflowId,
		nodeId: request.nodeId,
		sessionId: request.sessionId,
		codexHome: request.codexHome,
		profileKey: request.profileKey || null,
		resolvedCredentialId: request.resolvedCredentialId || null,
		authFingerprint: request.authFingerprintAtRun || null,
		workingDirectory: request.workingDirectory,
		model: request.model || null,
		runtime: request.runtime,
		threadId: recoveredResult.threadId,
		lastRunId: request.runStart.id,
		status: "active",
		recoveryCount: (request.binding.recoveryCount || 0) + 1,
		createdAt: request.binding.createdAt,
	});
	const usage = recoveredResult.usage || {};
	const endedAt = nowIso();
	await completeRun(request.runStart.id, {
		status: "completed",
		threadId: recoveredResult.threadId || null,
		endedAt,
		durationMs:
			new Date(endedAt).getTime() -
			new Date(request.runStart.startedAt).getTime(),
		inputTokens: usage.input_tokens ?? null,
		cachedInputTokens: usage.cached_input_tokens ?? null,
		outputTokens: usage.output_tokens ?? null,
		stderr: recoveredResult.stderr || "",
		finalResponse: recoveredResult.finalResponse || "",
			metadata: {
				sessionBindingId: recoveredBinding?.id || null,
				artifactsSummary: buildArtifactsSummary(artifacts),
				executionDetails: buildExecutionDetails(
					recoveredResult.events,
					request.workingDirectory,
					request.options,
				),
				contextPressure: buildContextPressure(
					recoveredResult.usage || null,
					request.sessionStrategy,
					request.options,
				),
				storedEventCount,
				recoveredFromThread: request.binding.threadId,
			},
	});
	return buildRunResultPayload(
		request,
		recoveredResult,
		artifacts,
		storedEventCount,
		true,
	);
}

async function executeWithRuntime(request) {
	return await runSdkAgent(request);
}

async function executeAgentRun(request) {
	const runtime = resolveRuntime();
	const bindingKey =
		request.sessionStrategy === "autoResume" && request.sessionId
			? toBindingKey({
					workflowId: request.workflowId || null,
					nodeId: request.nodeId || null,
					sessionId: request.sessionId,
					profileKey: request.profileKey || null,
					codexHome: request.codexHome || null,
					workingDirectory: request.workingDirectory,
			  })
			: null;

	let binding = bindingKey ? await getSessionBinding(bindingKey) : null;
	let transcriptEntries = [];
	if (!binding && request.memory?.mirrorTranscript && request.sessionId) {
		transcriptEntries = await listRecentTranscriptEntries({
			workflowId: request.workflowId,
			nodeId: request.nodeId,
			sessionId: request.sessionId,
			profileKey: request.profileKey || null,
			limit: request.memory.contextWindowLength || 5,
		});
	}

	const effectiveThreadId = resolveInitialThreadId(request, binding);
	const runStart = await createRun({
		workflowId: request.workflowId,
		nodeId: request.nodeId,
		executionId: request.executionId,
		resource: request.resource || "agent",
		operation: request.operation || "exec",
		runtime,
		status: "in_progress",
		sessionId: request.sessionId || null,
		threadId: effectiveThreadId,
		promptPreview: truncatePrompt(request.prompt),
		model: request.model || null,
		codexHome: request.codexHome || null,
		profileKey: request.profileKey || null,
		resolvedCredentialId: request.resolvedCredentialId || null,
		authFingerprintAtRun: request.authFingerprintAtRun || null,
		workingDirectory: request.workingDirectory,
		metadata: {
			sessionStrategy: request.sessionStrategy,
			streaming: Boolean(request.options?.streaming),
			credentialType: request.credentialType || null,
		},
	});

	const lifecycle = createLifecycleHooks(request.nodeHooks);

	try {
		await lifecycle.preAgentStart(request);

		// Inject persistent memory into system instructions if available
		let effectiveSystemInstructions = request.systemInstructions || "";
		if (request.memory?.enablePersistentMemory && request.memory?.memoryPromptSection) {
			effectiveSystemInstructions += request.memory.memoryPromptSection;
		}

		// Inject orchestration context if this is a delegated sub-agent
		if (request.orchestrationId && request.agentKey) {
			try {
				const delegationCtx = await buildDelegationContext(
					request.orchestrationId,
					request.agentKey,
				);
				const sharedCtx = await buildSharedContext(
					request.orchestrationId,
					request.agentKey,
				);
				effectiveSystemInstructions += delegationCtx + sharedCtx;
			} catch (e) {
				console.warn("[codex-service] Orchestration context 로드 실패 (실행은 계속):", e.message);
			}
		}

		const result = await executeWithRuntime({
			...request,
			systemInstructions: effectiveSystemInstructions,
			runtime,
			threadId: effectiveThreadId,
			transcriptEntries,
			lifecycleHooks: lifecycle,
		});

		const normalizedEvents = normalizeEvents(result.events, result.threadId || null);
		const artifacts = [
			...extractArtifactsFromEvents(result.events, request.workingDirectory),
			...captureGitArtifacts(request.workingDirectory),
		];
		const storedEventCount = await insertRunEvents(runStart.id, normalizedEvents);
		await insertRunArtifacts(runStart.id, artifacts);

		if (
			bindingKey &&
			request.sessionStrategy === "autoResume" &&
			request.sessionId &&
			result.threadId
		) {
			binding = await upsertSessionBinding({
				id: binding?.id,
				bindingKey,
				workflowId: request.workflowId,
				nodeId: request.nodeId,
				sessionId: request.sessionId,
				codexHome: request.codexHome,
				profileKey: request.profileKey || null,
				resolvedCredentialId: request.resolvedCredentialId || null,
				authFingerprint: request.authFingerprintAtRun || null,
				workingDirectory: request.workingDirectory,
				model: request.model || null,
				runtime,
				threadId: result.threadId,
				lastRunId: runStart.id,
				status: "active",
				recoveryCount: binding?.recoveryCount || 0,
				createdAt: binding?.createdAt,
			});
		}

		const usage = result.usage || {};
		const endedAt = nowIso();
		await completeRun(runStart.id, {
			status: "completed",
			threadId: result.threadId || null,
			endedAt,
			durationMs:
				new Date(endedAt).getTime() - new Date(runStart.startedAt).getTime(),
			inputTokens: usage.input_tokens ?? null,
			cachedInputTokens: usage.cached_input_tokens ?? null,
			outputTokens: usage.output_tokens ?? null,
			stderr: result.stderr || "",
			finalResponse: result.finalResponse || "",
			metadata: {
				sessionBindingId: binding?.id || null,
				artifactsSummary: buildArtifactsSummary(artifacts),
				executionDetails: buildExecutionDetails(
					result.events,
					request.workingDirectory,
					request.options,
				),
				contextPressure: buildContextPressure(
					result.usage || null,
					request.sessionStrategy,
					request.options,
				),
				storedEventCount,
			},
		});

		// Auto-save memory if enabled
		if (
			request.memory?.autoSaveMemories &&
			result.finalResponse
		) {
			try {
				await autoExtractAndSaveMemories(request, result);
			} catch (e) {
				console.warn("[codex-service] 메모리 자동 저장 실패 (실행은 계속):", e.message);
			}
		}

		// Post-completion lifecycle hook
		try {
			await lifecycle.postAgentComplete(request, result);
		} catch (e) {
			console.warn("[codex-service] postAgentComplete hook 실패 (실행은 계속):", e.message);
		}

		// Send result message if part of an orchestration
		if (request.orchestrationId && request.agentKey) {
			try {
				await sendMessage({
					orchestrationId: request.orchestrationId,
					fromAgent: request.agentKey,
					toAgent: request.orchestratorKey || "orchestrator",
					messageType: "result",
					content: result.finalResponse || "",
					metadata: {
						threadId: result.threadId,
						runId: runStart.id,
						usage: result.usage,
					},
					status: "pending",
				});
			} catch (e) {
				console.warn("[codex-service] 오케스트레이션 메시지 전송 실패 (실행은 계속):", e.message);
			}
		}

		return buildRunResultPayload(
			{ ...request, runStart, runtime },
			result,
			artifacts,
			storedEventCount,
			false,
		);
	} catch (error) {
		if (
			binding &&
			request.sessionStrategy === "autoResume" &&
			shouldRecoverThread(error)
		) {
			return await executeRecoveredRun({
				...request,
				runtime,
				runStart,
				binding,
				bindingKey,
			});
		}

		try {
			await lifecycle.onError(request, error);
		} catch (e) {
			console.warn("[codex-service] onError hook 실패:", e.message);
		}

		const endedAt = nowIso();
		await completeRun(runStart.id, {
			status: "failed",
			threadId: effectiveThreadId || error?.details?.threadId || null,
			endedAt,
			durationMs:
				new Date(endedAt).getTime() - new Date(runStart.startedAt).getTime(),
			stderr: error?.details?.stderr || "",
			errorMessage: error.message,
			metadata: error?.details
				? { turnFailureDetails: error.details }
				: undefined,
		});
		throw error;
	}
}

const MEMORY_MARKERS = [
	/\[MEMORY_SAVE\]\s*(.*)/gi,
	/\[REMEMBER\]\s*(.*)/gi,
	/\[메모리 저장\]\s*(.*)/gi,
];

async function autoExtractAndSaveMemories(request, result) {
	const response = result.finalResponse || "";
	const extracted = [];

	for (const pattern of MEMORY_MARKERS) {
		let match;
		pattern.lastIndex = 0;
		while ((match = pattern.exec(response)) !== null) {
			const content = match[1].trim();
			if (content) extracted.push(content);
		}
	}

	// Also save a context memory for each completed session turn
	if (extracted.length === 0 && request.prompt) {
		const preview =
			response.length > 200 ? response.slice(0, 200) + "..." : response;
		extracted.push(
			`Q: ${truncatePrompt(request.prompt, 100)} → A: ${preview}`,
		);
	}

	for (const content of extracted) {
		await createMemory({
			scope: request.memory?.memoryScope || request.memory?.scope || "session",
			agentKey: request.nodeId || null,
			sessionId: request.sessionId || null,
			profileKey: request.profileKey || null,
			category: "context",
			content,
			tags: [],
			relevanceScore: 0.7,
		});
	}
}

module.exports = {
	executeAgentRun,
	resolveRuntime,
};
