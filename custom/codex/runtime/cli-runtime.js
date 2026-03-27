"use strict";

const {
	extractExecSummary,
	parseJsonOutput,
	parseJsonLines,
	resolveCodexExecutable,
	runCodexCommand,
	serializeConfigOverrides,
} = require("../lib/codex-cli");
const {
	buildCodexConfig,
	buildPrompt,
	maybeWriteOutputSchema,
	resolveAdditionalDirectories,
	resolveSkillDirectories,
	shouldSkipGitRepoCheck,
} = require("./codex-runtime-utils");

function applyApiKeyEnv(env, credentials) {
	const nextEnv = { ...env };
	if (credentials.authMode === "apiKey" && credentials.apiKey) {
		nextEnv.CODEX_API_KEY = credentials.apiKey;
	} else {
		delete nextEnv.CODEX_API_KEY;
	}
	return nextEnv;
}

async function runCliAgent(request) {
	const executable = resolveCodexExecutable(request.credentials.codexExecutable);
	const env = applyApiKeyEnv(request.env, request.credentials);
	const config = buildCodexConfig(
		request.credentials,
		request.options,
		request.model,
		request.codexConfig,
	);
	const configArgs = [];
	for (const override of serializeConfigOverrides(config)) {
		configArgs.push("--config", override);
	}

	const additionalDirectories = resolveAdditionalDirectories(
		request.options,
		request.workingDirectory,
	);
	const skillDirectories = resolveSkillDirectories(
		request.options,
		request.workingDirectory,
	);
	const inputPrompt = buildPrompt({
		prompt: request.prompt,
		systemInstructions: request.systemInstructions,
		transcriptEntries: request.transcriptEntries,
		skillDirectories,
	});
	const { schemaPath, cleanup } = await maybeWriteOutputSchema(
		request.workingDirectory,
		request.options.outputSchema,
	);

	try {
		const args = ["exec", "--json", ...configArgs];

		if (request.operation === "review") {
			args[0] = "review";
			if (request.reviewTarget === "uncommitted") args.push("--uncommitted");
			if (request.reviewTarget === "base" && request.baseBranch) {
				args.push("--base", request.baseBranch);
			}
			if (request.reviewTarget === "commit" && request.commitSha) {
				args.push("--commit", request.commitSha);
			}
			if (request.reviewTitle) args.push("--title", request.reviewTitle);
		} else {
			if (request.threadId) {
				args.push("resume", request.threadId);
			}
			if (request.resumeLast) {
				args.push("resume", "--last");
			}
			if (request.model) args.push("--model", request.model);
			if (request.options.sandbox) args.push("--sandbox", request.options.sandbox);
			args.push("--cd", request.workingDirectory);
			for (const entry of additionalDirectories) args.push("--add-dir", entry);
			if (request.options.fullAuto) args.push("--full-auto");
			if (request.options.dangerBypass) {
				args.push("--dangerously-bypass-approvals-and-sandbox");
			}
			if (shouldSkipGitRepoCheck(request.options, request.workingDirectory)) {
				args.push("--skip-git-repo-check");
			}
			if (request.options.ephemeral) args.push("--ephemeral");
			if (schemaPath) args.push("--output-schema", schemaPath);
		}

		if (request.operation !== "review") {
			args.push("-");
		} else if (inputPrompt.trim()) {
			args.push("-");
		}

		const result = await runCodexCommand({
			executable,
			args,
			stdin:
				request.operation === "review"
					? inputPrompt.trim()
						? inputPrompt
						: undefined
					: inputPrompt,
			cwd: request.workingDirectory,
			env,
			allowedExitCodes: request.operation === "authStatus" ? [1] : [],
		});

		if (request.operation === "review") {
			return {
				runtime: "cli",
				threadId: request.threadId || null,
				finalResponse: result.stdout.trim(),
				usage: null,
				stderr: result.stderr.trim() || "",
				events: [],
				parsedFinalResponse: null,
				rawResult: result,
			};
		}

		const events = parseJsonLines(result.stdout);
		const summary = extractExecSummary(events);
		return {
			runtime: "cli",
			threadId: summary.threadId || request.threadId || null,
			finalResponse: summary.finalResponse || "",
			usage: summary.usage,
			stderr: result.stderr.trim() || "",
			events,
			parsedFinalResponse:
				request.options.parseFinalResponseAsJson && summary.finalResponse
					? parseJsonOutput(summary.finalResponse, "Codex final response")
					: null,
			rawResult: result,
		};
	} finally {
		await cleanup();
	}
}

async function runCliAuth(request) {
	const executable = resolveCodexExecutable(request.credentials.codexExecutable);
	const env = applyApiKeyEnv(request.env, request.credentials);
	const args = ["login"];

	if (request.operation === "status") {
		args.push("status");
		const result = await runCodexCommand({
			executable,
			args,
			env,
			cwd: process.cwd(),
			allowedExitCodes: [1],
		});
		return {
			loggedIn: result.code === 0,
			message: result.stdout.trim() || result.stderr.trim(),
		};
	}

	if (request.operation === "loginApiKey") {
		await runCodexCommand({
			executable,
			args: ["login", "--with-api-key"],
			env,
			cwd: process.cwd(),
			stdin: request.credentials.apiKey || "",
		});
		return await runCliAuth({
			...request,
			operation: "status",
		});
	}

	if (request.operation === "logout") {
		const result = await runCodexCommand({
			executable,
			args: ["logout"],
			env,
			cwd: process.cwd(),
		});
		return {
			loggedIn: false,
			message: result.stdout.trim() || result.stderr.trim() || "Logged out",
		};
	}

	throw new Error(`Unsupported auth operation: ${request.operation}`);
}

async function runCliMcp(request) {
	const executable = resolveCodexExecutable(request.credentials.codexExecutable);
	const env = applyApiKeyEnv(request.env, request.credentials);
	const baseArgs = ["mcp"];

	if (request.operation === "list") {
		const result = await runCodexCommand({
			executable,
			args: [...baseArgs, "list", "--json"],
			env,
			cwd: process.cwd(),
		});
		return {
			servers: parseJsonOutput(result.stdout, "MCP server list") || [],
		};
	}

	if (request.operation === "get") {
		const result = await runCodexCommand({
			executable,
			args: [...baseArgs, "get", request.serverName, "--json"],
			env,
			cwd: process.cwd(),
		});
		return {
			server: parseJsonOutput(result.stdout, "MCP server output"),
		};
	}

	if (request.operation === "remove") {
		const result = await runCodexCommand({
			executable,
			args: [...baseArgs, "remove", request.serverName],
			env,
			cwd: process.cwd(),
		});
		return { success: true, message: result.stdout.trim() || "Removed" };
	}

	if (request.operation === "login") {
		const args = [...baseArgs, "login", request.serverName];
		if (Array.isArray(request.scopes) && request.scopes.length > 0) {
			args.push("--scopes", request.scopes.join(","));
		}
		const result = await runCodexCommand({
			executable,
			args,
			env,
			cwd: process.cwd(),
		});
		return { success: true, message: result.stdout.trim() || "Logged in" };
	}

	if (request.operation === "logout") {
		const result = await runCodexCommand({
			executable,
			args: [...baseArgs, "logout", request.serverName],
			env,
			cwd: process.cwd(),
		});
		return { success: true, message: result.stdout.trim() || "Logged out" };
	}

	if (request.operation === "add") {
		const args = [...baseArgs, "add", request.serverName];
		if (request.serverType === "http") {
			args.push("--url", request.serverUrl);
			if (request.bearerTokenEnvVar) {
				args.push("--bearer-token-env-var", request.bearerTokenEnvVar);
			}
		} else {
			for (const [key, value] of Object.entries(request.commandEnv || {})) {
				const envValue =
					typeof value === "string" ? value : JSON.stringify(value);
				args.push("--env", `${key}=${envValue}`);
			}
			args.push("--", request.stdioCommand);
			for (const entry of request.stdioArgs || []) {
				args.push(String(entry));
			}
		}

		await runCodexCommand({
			executable,
			args,
			env,
			cwd: process.cwd(),
		});

		return await runCliMcp({
			...request,
			operation: "get",
		});
	}

	throw new Error(`Unsupported MCP operation: ${request.operation}`);
}

module.exports = {
	runCliAgent,
	runCliAuth,
	runCliMcp,
};
