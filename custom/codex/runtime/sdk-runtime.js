"use strict";

const path = require("node:path");
const { parseJsonOutput } = require("../lib/codex-utils");
const {
	buildCodexConfig,
	buildPrompt,
	resolveAdditionalDirectories,
	resolveSkillDirectories,
	shouldSkipGitRepoCheck,
} = require("./codex-runtime-utils");

const TOOL_EVENT_TYPES = new Set([
	"tool.started",
	"tool.completed",
	"tool_use",
	"item.completed",
]);

function isToolEvent(event) {
	if (TOOL_EVENT_TYPES.has(event?.type)) return true;
	if (event?.item?.type === "tool_use" || event?.item?.type === "tool_result") return true;
	return false;
}

function resolveSdkCodexPath(codexExecutable) {
	if (!codexExecutable) return undefined;
	const extension = path.extname(codexExecutable).toLowerCase();
	if (extension === ".cmd" || extension === ".bat") {
		// Windows .cmd/.bat wrappers are not directly supported by the SDK.
		// SDK will use its own path resolution instead.
		if (process.env.DEBUG || process.env.NODE_ENV === "development") {
			console.warn(
				`[codex-sdk] Ignoring .cmd/.bat codex path "${codexExecutable}" — SDK will resolve its own path.`,
			);
		}
		return undefined;
	}
	return codexExecutable;
}

async function getCodexSdk() {
	return await import("@openai/codex-sdk");
}

async function runSdkAgent(request) {
	const { Codex } = await getCodexSdk();
	const config = buildCodexConfig(
		request.credentials,
		request.options,
		request.model,
		request.codexConfig,
	);
	const additionalDirectories = resolveAdditionalDirectories(
		request.options,
		request.workingDirectory,
	);
	const skillDirectories = resolveSkillDirectories(
		request.options,
		request.workingDirectory,
	);
	for (const entry of skillDirectories) {
		if (!additionalDirectories.includes(entry)) additionalDirectories.push(entry);
	}

	const prompt = buildPrompt({
		prompt: request.prompt,
		systemInstructions: request.systemInstructions,
		transcriptEntries: request.transcriptEntries,
		skillDirectories,
	});
	const client = new Codex({
		codexPathOverride: resolveSdkCodexPath(request.credentials.codexExecutable),
		baseUrl: request.credentials.baseUrl || undefined,
		apiKey:
			request.credentials.authMode === "apiKey"
				? request.credentials.apiKey || undefined
				: undefined,
		env: request.env,
		config,
	});

	const threadOptions = {
		model: request.model || undefined,
		sandboxMode: request.options.sandbox || undefined,
		workingDirectory: request.workingDirectory,
		skipGitRepoCheck: shouldSkipGitRepoCheck(
			request.options,
			request.workingDirectory,
		),
		modelReasoningEffort: request.options.reasoningEffort || undefined,
		networkAccessEnabled:
			typeof request.options.networkAccessEnabled === "boolean"
				? request.options.networkAccessEnabled
				: undefined,
		webSearchMode: request.options.webSearch || undefined,
		approvalPolicy: request.options.approvalPolicy || undefined,
		additionalDirectories,
	};

	const thread = request.threadId
		? client.resumeThread(request.threadId, threadOptions)
		: client.startThread(threadOptions);

	if (request.options.streaming) {
		await request.hooks?.onStreamBegin?.();
		const events = [];
		try {
			const streamed = await thread.runStreamed(prompt, {
				outputSchema:
					request.options.outputSchema &&
					Object.keys(request.options.outputSchema).length > 0
						? request.options.outputSchema
						: undefined,
			});
			for await (const event of streamed.events) {
				if (isToolEvent(event)) {
					await request.lifecycleHooks?.preToolUse?.(event, request);
				}
				events.push(event);
				await request.hooks?.onEvent?.(event);
				if (isToolEvent(event)) {
					await request.lifecycleHooks?.postToolUse?.(event, request);
				}
			}
		} finally {
			await request.hooks?.onStreamEnd?.();
		}

		let finalResponse = "";
		let usage = null;
		let turnFailure = null;
		for (const event of events) {
			if (
				(event.type === "item.updated" || event.type === "item.completed") &&
				event.item?.type === "agent_message"
			) {
				finalResponse = event.item.text;
			}
			if (event.type === "turn.completed") {
				usage = event.usage;
			}
			if (event.type === "turn.failed") {
				turnFailure = event.error;
				break;
			}
		}

		if (turnFailure) {
			const err = new Error(turnFailure.message || "Codex turn failed");
			err.details = {
				code: turnFailure.code,
				type: turnFailure.type,
				threadId: thread?.id,
			};
			throw err;
		}

		return {
			runtime: "sdk",
			threadId: thread.id,
			finalResponse,
			usage,
			stderr: "",
			events,
			parsedFinalResponse:
				request.options.parseFinalResponseAsJson && finalResponse
					? parseJsonOutput(finalResponse, "Codex final response")
					: null,
		};
	}

	const turn = await thread.run(prompt, {
		outputSchema:
			request.options.outputSchema &&
			Object.keys(request.options.outputSchema).length > 0
				? request.options.outputSchema
				: undefined,
	});

	const events = [];
	if (thread.id) {
		events.push({
			type: "thread.started",
			thread_id: thread.id,
		});
	}
	for (const item of turn.items || []) {
		events.push({
			type: "item.completed",
			item,
		});
	}
	if (turn.usage) {
		events.push({
			type: "turn.completed",
			usage: turn.usage,
		});
	}

	return {
		runtime: "sdk",
		threadId: thread.id,
		finalResponse: turn.finalResponse || "",
		usage: turn.usage || null,
		stderr: "",
		events,
		parsedFinalResponse:
			request.options.parseFinalResponseAsJson && turn.finalResponse
				? parseJsonOutput(turn.finalResponse, "Codex final response")
				: null,
	};
}

module.exports = {
	runSdkAgent,
};
