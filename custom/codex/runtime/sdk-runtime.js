"use strict";

const path = require("node:path");
const { parseJsonOutput } = require("../lib/codex-cli");
const {
	buildCodexConfig,
	buildPrompt,
	resolveAdditionalDirectories,
	resolveSkillDirectories,
	shouldSkipGitRepoCheck,
} = require("./codex-runtime-utils");

function resolveSdkCodexPath(codexExecutable) {
	if (!codexExecutable) return undefined;
	const extension = path.extname(codexExecutable).toLowerCase();
	if (extension === ".cmd" || extension === ".bat") return undefined;
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
		const streamed = await thread.runStreamed(prompt, {
			outputSchema:
				request.options.outputSchema &&
				Object.keys(request.options.outputSchema).length > 0
					? request.options.outputSchema
					: undefined,
		});
		const events = [];
		for await (const event of streamed.events) {
			events.push(event);
		}

		let finalResponse = "";
		let usage = null;
		for (const event of events) {
			if (event.type === "item.completed" && event.item?.type === "agent_message") {
				finalResponse = event.item.text;
			}
			if (event.type === "turn.completed") {
				usage = event.usage;
			}
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
