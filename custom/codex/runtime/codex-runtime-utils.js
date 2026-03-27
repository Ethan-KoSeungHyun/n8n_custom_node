"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
	parseOptionalJsonObject,
	parseStringList,
	resolvePathMaybeRelative,
	setConfigValue,
	writeJsonFile,
} = require("../lib/codex-cli");

function directoryHasGitRepo(startDirectory) {
	if (!startDirectory) return false;

	let currentDirectory = startDirectory;
	while (true) {
		if (fs.existsSync(path.join(currentDirectory, ".git"))) {
			return true;
		}

		const parentDirectory = path.dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			return false;
		}
		currentDirectory = parentDirectory;
	}
}

function shouldSkipGitRepoCheck(options, workingDirectory, forceReview = false) {
	if (forceReview) return false;
	if (options.skipGitRepoCheck === true) return true;
	return !directoryHasGitRepo(workingDirectory);
}

function resolveSkillDirectories(options, workingDirectory) {
	const result = [];
	if (options.useWorkspaceSkills) {
		const workspaceSkillsPath = path.join(workingDirectory, ".codex", "skills");
		if (fs.existsSync(workspaceSkillsPath)) {
			result.push(workspaceSkillsPath);
		}
	}

	const additionalSkillPaths = Array.isArray(options.additionalSkillPaths)
		? options.additionalSkillPaths
		: parseStringList(options.additionalSkillPaths);

	for (const entry of additionalSkillPaths) {
		result.push(resolvePathMaybeRelative(workingDirectory, String(entry)));
	}

	return result.filter(Boolean);
}

function resolveAdditionalDirectories(options, workingDirectory) {
	const result = [];
	const rawEntries = Array.isArray(options.additionalDirectories)
		? options.additionalDirectories
		: parseStringList(options.additionalDirectories);

	for (const entry of rawEntries) {
		result.push(resolvePathMaybeRelative(workingDirectory, String(entry)));
	}

	const skillDirectories = resolveSkillDirectories(options, workingDirectory);
	for (const entry of skillDirectories) {
		if (!result.includes(entry)) result.push(entry);
	}

	return result.filter(Boolean);
}

function buildCodexConfig(credentials, options, model, extraConfig = {}) {
	const config = parseOptionalJsonObject(
		JSON.stringify(options.advancedConfig || {}),
		"Advanced Config JSON",
	);

	if (credentials?.baseUrl) {
		setConfigValue(config, "openai_base_url", credentials.baseUrl);
	}

	if (model) setConfigValue(config, "model", model);
	setConfigValue(config, "approval_policy", options.approvalPolicy);
	setConfigValue(config, "web_search", options.webSearch);
	setConfigValue(config, "model_reasoning_effort", options.reasoningEffort);
	setConfigValue(config, "model_verbosity", options.verbosity);
	if (options.autoCompactTokenLimit) {
		setConfigValue(
			config,
			"model_auto_compact_token_limit",
			Number(options.autoCompactTokenLimit),
		);
	}
	if (typeof options.networkAccessEnabled === "boolean") {
		setConfigValue(
			config,
			"sandbox_workspace_write.network_access",
			options.networkAccessEnabled,
		);
	}

	mergeConfigObjects(config, extraConfig);
	return config;
}

function mergeConfigObjects(target, source) {
	if (!source || typeof source !== "object" || Array.isArray(source)) return;

	for (const [key, value] of Object.entries(source)) {
		if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			target[key] &&
			typeof target[key] === "object" &&
			!Array.isArray(target[key])
		) {
			mergeConfigObjects(target[key], value);
		} else {
			target[key] = value;
		}
	}
}

function buildPrompt({ prompt, systemInstructions, transcriptEntries, skillDirectories }) {
	const sections = [];

	if (systemInstructions) {
		sections.push(`System instructions:\n${systemInstructions}`);
	}

	if (Array.isArray(transcriptEntries) && transcriptEntries.length > 0) {
		const transcript = transcriptEntries
			.map((entry, index) =>
				[
					`Previous turn ${index + 1}:`,
					entry.promptPreview ? `User: ${entry.promptPreview}` : "",
					entry.finalResponse ? `Assistant: ${entry.finalResponse}` : "",
				]
					.filter(Boolean)
					.join("\n"),
			)
			.join("\n\n");
		sections.push(`Conversation memory:\n${transcript}`);
	}

	if (Array.isArray(skillDirectories) && skillDirectories.length > 0) {
		sections.push(
			[
				"Skill directories available in the workspace:",
				...skillDirectories.map((entry) => `- ${entry}`),
				"Use them when relevant.",
			].join("\n"),
		);
	}

	sections.push(prompt || "");
	return sections.filter(Boolean).join("\n\n");
}

async function maybeWriteOutputSchema(workingDirectory, outputSchema) {
	if (!outputSchema || Object.keys(outputSchema).length === 0) {
		return {
			schemaPath: "",
			cleanup: async () => {},
		};
	}

	const schemaPath = await writeJsonFile(
		path.join(workingDirectory, "data", "codex-tmp"),
		"output-schema",
		JSON.stringify(outputSchema, null, 2),
	);

	return {
		schemaPath,
		cleanup: async () => {
			try {
				await fs.promises.unlink(schemaPath);
			} catch {}
		},
	};
}

module.exports = {
	buildCodexConfig,
	buildPrompt,
	directoryHasGitRepo,
	mergeConfigObjects,
	resolveAdditionalDirectories,
	resolveSkillDirectories,
	shouldSkipGitRepoCheck,
	maybeWriteOutputSchema,
};
