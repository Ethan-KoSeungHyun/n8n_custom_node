"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { NodeConnectionTypes } = require("n8n-workflow");
const {
	ensureDirectory,
	parseOptionalJsonObject,
	parseStringList,
	resolvePathMaybeRelative,
} = require("./codex-utils");
const {
	ensureProfileStructure,
	readProfileState,
	sanitizeProfileKey,
} = require("./codex-profile-utils");

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
	if (Array.isArray(value)) return value;
	if (value === undefined || value === null) return [];
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

	if (candidate) return candidate.trim();

	if (inputJson && Object.keys(inputJson).length > 0) {
		return JSON.stringify(inputJson, null, 2);
	}

	return "";
}

async function getBaseNodeContext(context, itemIndex) {
	const resolvedCredential = await resolveCodexCredential(context, itemIndex);
	const credentials = resolvedCredential.credentials;
	const workspaceRoot = process.cwd();

	if (!credentials.profileKey) {
		throw new Error(
			"Codex ChatGPT Account가 아직 연결되지 않았습니다. Credential에서 Connect를 먼저 완료하세요.",
		);
	}

	const profile = await ensureProfileStructure(credentials.profileKey, workspaceRoot);
	const codexHome = profile.codexHome;
	const profileState = await readProfileState({
		profileKey: credentials.profileKey,
		workspaceRoot,
		codexExecutable: credentials.codexExecutable,
	});

	if (profileState.status !== "connected") {
		throw new Error(
			`Codex ChatGPT Account 상태가 ${String(
				profileState.status || "disconnected",
			).replace(/_/g, " ")} 입니다. 워크플로 실행 전에 Credential에서 다시 연결하세요.`,
		);
	}

	const extraEnv = parseJsonObjectOrEmpty(
		context.getNodeParameter("extraEnvJson", itemIndex, ""),
		"Extra Environment JSON",
	);
	const env = {
		...process.env,
		...stringifyObjectValues(extraEnv),
		CODEX_HOME: codexHome,
	};

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
		credentialType: resolvedCredential.credentialType,
		credentialRef: resolvedCredential.credentialRef,
		workspaceRoot,
		codexHome,
		profileKey: credentials.profileKey || null,
		authFingerprint:
			profileState?.authFingerprint || credentials.authFingerprint || null,
		profileState,
		env,
		workingDirectory,
		workflowId: context.getWorkflow().id || null,
		nodeId: context.getNode().id || context.getNode().name,
		executionId: context.getExecutionId ? context.getExecutionId() : null,
	};
}

async function resolveCodexCredential(context, itemIndex) {
	const credentialRef = getConfiguredCredentialReference(
		context,
		"codexChatgptAccount",
	);

	if (!credentialRef) {
		throw new Error(
			"이 노드에서 사용할 Codex ChatGPT Account credential을 먼저 선택하세요.",
		);
	}

	let rawCredentials;
	try {
		rawCredentials = await context.getCredentials(
			"codexChatgptAccount",
			itemIndex,
		);
	} catch (error) {
		const message = String(error?.message || "");
		if (/does not exist/i.test(message)) {
			throw new Error(
				"선택되어 있던 Codex ChatGPT Account credential을 찾을 수 없습니다. 이 노드에서 Credential을 다시 선택하세요.",
			);
		}
		throw error;
	}

	const oauthTokenData =
		rawCredentials && typeof rawCredentials.oauthTokenData === "object"
			? rawCredentials.oauthTokenData
			: {};

	return {
		credentialType: "codexChatgptAccount",
		credentialRef,
		credentials: {
			...rawCredentials,
			profileKey: sanitizeProfileKey(oauthTokenData.profile_key || ""),
			authFingerprint: String(oauthTokenData.auth_fingerprint || "").trim(),
			codexExecutable:
				rawCredentials.codexExecutable ||
				process.env.CODEX_BINARY_PATH ||
				process.env.CODEX_EXECUTABLE_PATH ||
				"",
		},
	};
}

function getConfiguredCredentialReference(context, credentialType) {
	return context.getNode()?.credentials?.[credentialType] || null;
}

function readCommonOptions(context, itemIndex) {
	const advancedConfig = parseJsonObjectOrEmpty(
		context.getNodeParameter("advancedConfigJson", itemIndex, ""),
		"Advanced Config JSON",
	);
	const outputSchema = parseJsonObjectOrEmpty(
		context.getNodeParameter("outputSchemaJson", itemIndex, ""),
		"Output Schema JSON",
	);

	return {
		sandbox: coalesce(context.getNodeParameter("sandbox", itemIndex, "")),
		approvalPolicy: coalesce(
			context.getNodeParameter("approvalPolicy", itemIndex, ""),
		),
		webSearch: coalesce(context.getNodeParameter("webSearch", itemIndex, "")),
		reasoningEffort: coalesce(
			context.getNodeParameter("reasoningEffort", itemIndex, ""),
		),
		verbosity: coalesce(context.getNodeParameter("verbosity", itemIndex, "")),
		fullAuto: coerceBoolean(
			context.getNodeParameter("fullAuto", itemIndex, false),
		),
		includeEvents: coerceBoolean(
			context.getNodeParameter("includeEvents", itemIndex, false),
		),
		eventPayloadDetail: coalesce(
			context.getNodeParameter("eventPayloadDetail", itemIndex, "summary"),
			"summary",
		),
		eventContentMaxLength:
			Number(
				context.getNodeParameter("eventContentMaxLength", itemIndex, 400),
			) || 400,
		ephemeral: coerceBoolean(
			context.getNodeParameter("ephemeral", itemIndex, false),
		),
		skipGitRepoCheck: coerceBoolean(
			context.getNodeParameter("skipGitRepoCheck", itemIndex, false),
		),
		additionalDirectories: parseDelimitedPaths(
			context.getNodeParameter("additionalDirectories", itemIndex, ""),
		),
		autoCompactTokenLimit:
			Number(context.getNodeParameter("autoCompactTokenLimit", itemIndex, 0)) ||
			0,
		parseFinalResponseAsJson: coerceBoolean(
			context.getNodeParameter("parseFinalResponseAsJson", itemIndex, false),
		),
		outputSchema,
		useWorkspaceSkills: coerceBoolean(
			context.getNodeParameter("useWorkspaceSkills", itemIndex, true),
			true,
		),
		additionalSkillPaths: parseDelimitedPaths(
			context.getNodeParameter("additionalSkillPaths", itemIndex, ""),
		),
		advancedConfig,
		streaming: coerceBoolean(
			context.getNodeParameter("streaming", itemIndex, false),
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

			const misusedToolPath = [
				...(server.includeTools || []),
				...(server.excludeTools || []),
			].find(
				(entry) =>
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
