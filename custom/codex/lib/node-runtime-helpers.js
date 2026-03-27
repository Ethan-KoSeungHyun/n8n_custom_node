"use strict";

const path = require("node:path");
const { NodeConnectionTypes } = require("n8n-workflow");
const {
	ensureDirectory,
	parseOptionalJsonObject,
	parseStringList,
	resolveCodexHome,
	resolvePathMaybeRelative,
} = require("./codex-cli");

function coalesce(...values) {
	for (const value of values) {
		if (value !== undefined && value !== null && value !== "") {
			return value;
		}
	}
	return undefined;
}

function coerceBoolean(primaryValue, fallbackValue = false) {
	if (primaryValue !== undefined && primaryValue !== null) {
		return Boolean(primaryValue);
	}
	if (fallbackValue !== undefined && fallbackValue !== null) {
		return Boolean(fallbackValue);
	}
	return false;
}

function parseJsonObjectOrEmpty(rawValue, label) {
	if (!rawValue) return {};
	return parseOptionalJsonObject(rawValue, label);
}

function parseDelimitedPaths(rawValue) {
	if (!rawValue) return [];
	return parseStringList(rawValue);
}

function toConnectionArray(value) {
	if (Array.isArray(value)) {
		return value;
	}
	if (value === undefined || value === null) {
		return [];
	}
	return [value];
}

async function getBaseNodeContext(context, itemIndex) {
	const credentials = await context.getCredentials("codexCliApi", itemIndex);
	const workspaceRoot = process.cwd();
	const stateScope = context.getNodeParameter("stateScope", itemIndex, "workspaceScoped");
	const customCodexHome = context.getNodeParameter(
		"customCodexHome",
		itemIndex,
		"",
	);
	const codexHome = resolveCodexHome({
		scope: stateScope,
		customPath: customCodexHome,
		workspaceRoot,
	});
	await ensureDirectory(codexHome);

	const extraEnv = parseJsonObjectOrEmpty(
		context.getNodeParameter("extraEnvJson", itemIndex, ""),
		"Extra Environment JSON",
	);
	const env = {
		...process.env,
		...stringifyObjectValues(extraEnv),
	};
	if (codexHome) env.CODEX_HOME = codexHome;
	if (credentials.caCertificatePath) {
		env.CODEX_CA_CERTIFICATE = credentials.caCertificatePath;
	}

	let workingDirectoryInput = "";
	try {
		workingDirectoryInput = context.getNodeParameter(
			"workingDirectory",
			itemIndex,
			"",
		);
	} catch {}
	const workingDirectory = workingDirectoryInput
		? resolvePathMaybeRelative(workspaceRoot, workingDirectoryInput)
		: workspaceRoot;
	await ensureDirectory(workingDirectory);

	return {
		credentials,
		workspaceRoot,
		codexHome,
		env,
		workingDirectory,
		workflowId: context.getWorkflow().id || null,
		nodeId: context.getNode().id || context.getNode().name,
		executionId: context.getExecutionId ? context.getExecutionId() : null,
	};
}

function readCommonOptions(context, itemIndex) {
	const legacyOptions = parseJsonObjectOrEmpty(
		context.getNodeParameter("optionsJson", itemIndex, ""),
		"Legacy Options JSON",
	);
	const advancedConfig = parseJsonObjectOrEmpty(
		context.getNodeParameter("advancedConfigJson", itemIndex, ""),
		"Advanced Config JSON",
	);
	const outputSchema = parseJsonObjectOrEmpty(
		context.getNodeParameter("outputSchemaJson", itemIndex, ""),
		"Output Schema JSON",
	);

	return {
		sandbox: coalesce(
			context.getNodeParameter("sandbox", itemIndex, ""),
			legacyOptions.sandbox,
		),
		approvalPolicy: coalesce(
			context.getNodeParameter("approvalPolicy", itemIndex, ""),
			legacyOptions.approvalPolicy,
		),
		webSearch: coalesce(
			context.getNodeParameter("webSearch", itemIndex, ""),
			legacyOptions.webSearch,
		),
		reasoningEffort: coalesce(
			context.getNodeParameter("reasoningEffort", itemIndex, ""),
			legacyOptions.reasoningEffort,
		),
		verbosity: coalesce(
			context.getNodeParameter("verbosity", itemIndex, ""),
			legacyOptions.verbosity,
		),
		fullAuto: coerceBoolean(
			context.getNodeParameter("fullAuto", itemIndex, false),
			legacyOptions.fullAuto,
		),
		includeEvents: coerceBoolean(
			context.getNodeParameter("includeEvents", itemIndex, false),
			legacyOptions.includeEvents,
		),
		ephemeral: coerceBoolean(
			context.getNodeParameter("ephemeral", itemIndex, false),
			legacyOptions.ephemeral,
		),
		skipGitRepoCheck: coerceBoolean(
			context.getNodeParameter("skipGitRepoCheck", itemIndex, false),
			legacyOptions.skipGitRepoCheck,
		),
		additionalDirectories:
			parseDelimitedPaths(
				context.getNodeParameter("additionalDirectories", itemIndex, ""),
			).length > 0
				? parseDelimitedPaths(
						context.getNodeParameter("additionalDirectories", itemIndex, ""),
				  )
				: legacyOptions.additionalDirectories || [],
		autoCompactTokenLimit:
			Number(context.getNodeParameter("autoCompactTokenLimit", itemIndex, 0)) ||
			legacyOptions.autoCompactTokenLimit ||
			0,
		parseFinalResponseAsJson: coerceBoolean(
			context.getNodeParameter("parseFinalResponseAsJson", itemIndex, false),
			legacyOptions.parseFinalResponseAsJson,
		),
		outputSchema:
			Object.keys(outputSchema).length > 0
				? outputSchema
				: legacyOptions.outputSchema || {},
		useWorkspaceSkills: coerceBoolean(
			context.getNodeParameter("useWorkspaceSkills", itemIndex, true),
			legacyOptions.useWorkspaceSkills ?? true,
		),
		additionalSkillPaths:
			parseDelimitedPaths(
				context.getNodeParameter("additionalSkillPaths", itemIndex, ""),
			).length > 0
				? parseDelimitedPaths(
						context.getNodeParameter("additionalSkillPaths", itemIndex, ""),
				  )
				: legacyOptions.additionalSkillPaths || [],
		advancedConfig: {
			...(legacyOptions.config || {}),
			...advancedConfig,
		},
		streaming: coerceBoolean(
			context.getNodeParameter("streaming", itemIndex, false),
			legacyOptions.streaming,
		),
		networkAccessEnabled:
			context.getNodeParameter("networkAccessEnabled", itemIndex, undefined),
		dangerBypass: coerceBoolean(
			context.getNodeParameter("dangerBypass", itemIndex, false),
			legacyOptions.dangerBypass,
		),
	};
}

function resolveSessionIdField(context, itemIndex, fieldName = "sessionId") {
	return String(context.getNodeParameter(fieldName, itemIndex, "") || "").trim();
}

async function getConnectedCodexMemory(context) {
	const values = toConnectionArray(
		await context.getInputConnectionData(NodeConnectionTypes.AiMemory, 0),
	);
	return values.find((entry) => entry && entry.__codexMemory) || null;
}

async function getConnectedCodexToolsets(context) {
	const values = toConnectionArray(
		await context.getInputConnectionData(NodeConnectionTypes.AiTool, 0),
	);
	return values.filter((entry) => entry && entry.__codexMcpToolset);
}

function buildCodexMcpConfig(toolsets) {
	const mcpServers = {};

	for (const toolset of Array.isArray(toolsets) ? toolsets : []) {
		for (const server of toolset.servers || []) {
			const entry = {};
			if (server.required !== undefined) entry.required = Boolean(server.required);
			if (server.timeout) entry.tool_timeout_sec = Number(server.timeout);
			if (Array.isArray(server.includeTools) && server.includeTools.length > 0) {
				entry.include_tools = server.includeTools;
			}
			if (Array.isArray(server.excludeTools) && server.excludeTools.length > 0) {
				entry.exclude_tools = server.excludeTools;
			}
			if (server.serverSource === "http") {
				entry.url = server.serverUrl;
				if (server.bearerTokenEnvVar) {
					entry.bearer_token_env_var = server.bearerTokenEnvVar;
				}
			} else if (server.serverSource === "stdio") {
				entry.command = server.stdioCommand;
				entry.args = server.stdioArgs || [];
				entry.env = server.commandEnv || {};
			}

			mcpServers[server.serverName] = entry;
		}
	}

	if (Object.keys(mcpServers).length === 0) {
		return {};
	}

	return {
		mcp_servers: mcpServers,
	};
}

function stringifyObjectValues(input) {
	const result = {};
	for (const [key, value] of Object.entries(input)) {
		result[key] = typeof value === "string" ? value : JSON.stringify(value);
	}
	return result;
}

module.exports = {
	buildCodexMcpConfig,
	coerceBoolean,
	getBaseNodeContext,
	getConnectedCodexMemory,
	getConnectedCodexToolsets,
	parseDelimitedPaths,
	parseJsonObjectOrEmpty,
	readCommonOptions,
	resolveSessionIdField,
	stringifyObjectValues,
	toConnectionArray,
};
