"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { NodeConnectionTypes } = require("n8n-workflow");
const {
	ensureDirectory,
	parseOptionalJsonObject,
	parseStringList,
	resolveCodexHome,
	resolvePathMaybeRelative,
	syncSavedAuthToCodexHome,
} = require("./codex-utils");

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

function resolvePromptValue(rawPrompt, inputJson) {
	if (typeof rawPrompt === "string" && rawPrompt.trim()) {
		return rawPrompt.trim();
	}

	const candidate = [
		inputJson?.chatInput,
		inputJson?.prompt,
		inputJson?.text,
		inputJson?.query,
		inputJson?.message,
		inputJson?.input,
	].find((value) => typeof value === "string" && value.trim());

	if (candidate) {
		return candidate.trim();
	}

	if (inputJson && Object.keys(inputJson).length > 0) {
		return JSON.stringify(inputJson, null, 2);
	}

	return "";
}

async function getBaseNodeContext(context, itemIndex) {
	const rawCredentials = await context.getCredentials("codexApi", itemIndex);
	const credentials = {
		...rawCredentials,
		codexExecutable:
			rawCredentials.codexExecutable ||
			process.env.CODEX_BINARY_PATH ||
			process.env.CODEX_EXECUTABLE_PATH ||
			"",
	};
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
	if (stateScope === "workspaceScoped" && credentials.authMode === "saved") {
		await syncSavedAuthToCodexHome(codexHome);
	}

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
		eventPayloadDetail: coalesce(
			context.getNodeParameter("eventPayloadDetail", itemIndex, "summary"),
			legacyOptions.eventPayloadDetail,
			"summary",
		),
		eventContentMaxLength:
			Number(
				context.getNodeParameter("eventContentMaxLength", itemIndex, 400),
			) ||
			legacyOptions.eventContentMaxLength ||
			400,
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
	};
}

function resolveSessionIdField(context, itemIndex, fieldName = "sessionId") {
	return String(context.getNodeParameter(fieldName, itemIndex, "") || "").trim();
}

function resolveModelField(context, itemIndex, fallbackFieldName = "model") {
	const preset = String(
		context.getNodeParameter("modelPreset", itemIndex, ""),
	).trim();
	const customValue = String(
		context.getNodeParameter(fallbackFieldName, itemIndex, "") || "",
	).trim();

	if (preset === "__custom__") {
		return customValue;
	}

	return preset || customValue || "";
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
			if (server.timeout) {
				entry.tool_timeout_sec = Number(server.timeout);
				entry.startup_timeout_sec = Number(server.timeout);
			}
			if (Array.isArray(server.includeTools) && server.includeTools.length > 0) {
				entry.enabled_tools = server.includeTools;
			}
			if (Array.isArray(server.excludeTools) && server.excludeTools.length > 0) {
				entry.disabled_tools = server.excludeTools;
			}
			if (server.serverSource === "http") {
				entry.transport = "streamable_http";
				entry.url = server.serverUrl;
				if (server.bearerTokenEnvVar) {
					entry.bearer_token_env_var = server.bearerTokenEnvVar;
				}
			} else if (server.serverSource === "stdio") {
				entry.transport = "stdio";
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

function describeConfiguredMcpToolsets(toolsets) {
	const servers = [];

	for (const toolset of Array.isArray(toolsets) ? toolsets : []) {
		for (const server of toolset.servers || []) {
			servers.push({
				serverName: server.serverName,
				serverSource: server.serverSource,
				required: Boolean(server.required),
				timeout: server.timeout ?? null,
				includeTools: Array.isArray(server.includeTools)
					? server.includeTools
					: [],
				excludeTools: Array.isArray(server.excludeTools)
					? server.excludeTools
					: [],
			});
		}
	}

	return {
		serverCount: servers.length,
		servers,
		toolsetNodesAreConfigurationOnly: true,
		runtimeEventsAppearOn: "Codex Agent",
	};
}

function assertSavedMcpServerConfig(toolsets, codexHome) {
	for (const toolset of Array.isArray(toolsets) ? toolsets : []) {
		for (const server of toolset.servers || []) {
			if (server.serverSource !== "saved") continue;

			const misusedToolPath = [...(server.includeTools || []), ...(server.excludeTools || [])]
				.find((entry) =>
					typeof entry === "string" &&
					(/[\\/]/.test(entry) || /\.[a-z0-9]+$/i.test(entry)),
				);
			if (misusedToolPath) {
				throw new Error(
					`Saved CODEX_HOME Server "${server.serverName}" expects MCP tool names in Include/Exclude Tools, not a file path like "${misusedToolPath}". If you want to launch D:/.../dist/index.js directly, use Inline stdio Server instead.`,
				);
			}

			const configPath = path.join(codexHome || "", "config.toml");
			if (!codexHome || !fs.existsSync(configPath)) {
				throw new Error(
					`Saved CODEX_HOME Server "${server.serverName}" requires a pre-registered MCP server in ${configPath}. That file was not found. Use Inline stdio Server, Inline HTTP Server, or register the server in this CODEX_HOME first.`,
				);
			}

			const configText = fs.readFileSync(configPath, "utf8");
			const escapedName = server.serverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const sectionPattern = new RegExp(
				`^\\s*\\[mcp_servers\\.${escapedName}\\]\\s*$`,
				"m",
			);
			if (!sectionPattern.test(configText)) {
				throw new Error(
					`Saved CODEX_HOME Server "${server.serverName}" was selected, but ${configPath} does not contain an [mcp_servers.${server.serverName}] entry. Register it first or switch this node to Inline stdio Server.`,
				);
			}
		}
	}
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
	describeConfiguredMcpToolsets,
	coerceBoolean,
	getBaseNodeContext,
	getConnectedCodexMemory,
	getConnectedCodexToolsets,
	assertSavedMcpServerConfig,
	parseDelimitedPaths,
	parseJsonObjectOrEmpty,
	readCommonOptions,
	resolveModelField,
	resolvePromptValue,
	resolveSessionIdField,
	stringifyObjectValues,
	toConnectionArray,
};
