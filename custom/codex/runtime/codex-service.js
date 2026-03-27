"use strict";

const {
	buildArtifactsSummary,
	captureGitArtifacts,
	extractArtifactsFromEvents,
	normalizeEvents,
} = require("../observability/codex-observability");
const {
	completeRun,
	createRun,
	insertRunArtifacts,
	insertRunEvents,
	listRecentTranscriptEntries,
	nowIso,
	toBindingKey,
	upsertSessionBinding,
	getSessionBinding,
} = require("../store/codex-store");
const { runCliAgent } = require("./cli-runtime");
const { runSdkAgent } = require("./sdk-runtime");

function truncatePrompt(value, maxLength = 2000) {
	const text = String(value || "");
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}...`;
}

function shouldRecoverThread(error) {
	const message = String(error?.message || "").toLowerCase();
	return (
		(message.includes("thread") || message.includes("session")) &&
		(message.includes("not found") ||
			message.includes("invalid") ||
			message.includes("missing") ||
			message.includes("unknown"))
	);
}

function resolveRuntime(mode, defaultRuntime = "cli") {
	if (!mode || mode === "auto") return defaultRuntime;
	return mode;
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
			storedEventCount,
			recoveredFromThread: request.binding.threadId,
		},
	});
	return {
		runId: request.runStart.id,
		runtime: request.runtime,
		threadId: recoveredResult.threadId || null,
		sessionId: request.sessionId || null,
		finalResponse: recoveredResult.finalResponse || "",
		parsedFinalResponse: recoveredResult.parsedFinalResponse || null,
		usage: recoveredResult.usage || null,
		stderr: recoveredResult.stderr || "",
		events: Boolean(request.options?.includeEvents)
			? recoveredResult.events
			: undefined,
		storedEventCount,
		artifactsSummary: buildArtifactsSummary(artifacts),
		sessionRecovered: true,
	};
}

async function executeWithRuntime(request) {
	if (request.runtime === "sdk") {
		return await runSdkAgent(request);
	}

	return await runCliAgent(request);
}

async function executeAgentRun(request) {
	const runtime = resolveRuntime(request.runtimeMode, request.defaultRuntime || "cli");
	const bindingKey =
		request.sessionStrategy === "autoResume" && request.sessionId
			? toBindingKey({
					workflowId: request.workflowId || null,
					nodeId: request.nodeId || null,
					sessionId: request.sessionId,
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
		workingDirectory: request.workingDirectory,
		metadata: {
			sessionStrategy: request.sessionStrategy,
			streaming: Boolean(request.options?.streaming),
		},
	});

	try {
		const result = await executeWithRuntime({
			...request,
			runtime,
			threadId: effectiveThreadId,
			transcriptEntries,
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
				storedEventCount,
			},
		});

		return {
			runId: runStart.id,
			runtime,
			threadId: result.threadId || null,
			sessionId: request.sessionId || null,
			finalResponse: result.finalResponse || "",
			parsedFinalResponse: result.parsedFinalResponse || null,
			usage: result.usage || null,
			stderr: result.stderr || "",
			events: Boolean(request.options?.includeEvents) ? result.events : undefined,
			storedEventCount,
			artifactsSummary: buildArtifactsSummary(artifacts),
			sessionRecovered: false,
		};
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

		const endedAt = nowIso();
		await completeRun(runStart.id, {
			status: "failed",
			threadId: effectiveThreadId || null,
			endedAt,
			durationMs:
				new Date(endedAt).getTime() - new Date(runStart.startedAt).getTime(),
			stderr: error?.details?.stderr || "",
			errorMessage: error.message,
		});
		throw error;
	}
}

module.exports = {
	executeAgentRun,
	resolveRuntime,
};
