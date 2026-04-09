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
			context.getNodeParameter("streaming", itemIndex, true),
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

function buildSharedOptionFields(overrides = {}) {
	const defaults = {
		sandboxDescription:
			"Codex가 파일을 읽기만 할지, 워크스페이스 안에서 쓰기까지 할지, 더 넓은 시스템 접근을 허용할지 정합니다.",
		approvalDescription:
			"민감한 작업 전에 언제 멈추고 사용자 승인을 요청할지 정합니다.",
		webSearchDescription:
			"실행 중 웹 검색을 사용할 수 있는지 정합니다.",
		ephemeralDefault: false,
		ephemeralDescription:
			"가능한 경우, 지속 상태를 재사용하는 대신 일회성 격리 실행을 사용합니다.",
		parseFinalResponseAsJsonDefault: false,
		parseFinalResponseAsJsonDescription:
			"최종 응답을 JSON으로 파싱해 parsedFinalResponse에 함께 반환합니다.",
		includeOutputSchemaJson: false,
		...overrides,
	};

	const fields = [
		{
			displayName: "Sandbox",
			name: "sandbox",
			type: "options",
			default: "workspace-write",
			description: defaults.sandboxDescription,
			options: [
				{ name: "Read Only", value: "read-only" },
				{ name: "Workspace Write", value: "workspace-write" },
				{ name: "Danger Full Access", value: "danger-full-access" },
			],
		},
		{
			displayName: "Approval Policy",
			name: "approvalPolicy",
			type: "options",
			default: "on-request",
			description: defaults.approvalDescription,
			options: [
				{ name: "Never", value: "never" },
				{ name: "On Request", value: "on-request" },
				{ name: "On Failure", value: "on-failure" },
				{ name: "Untrusted", value: "untrusted" },
			],
		},
		{
			displayName: "Web Search",
			name: "webSearch",
			type: "options",
			default: "live",
			description: defaults.webSearchDescription,
			options: [
				{ name: "Live", value: "live" },
				{ name: "Cached", value: "cached" },
				{ name: "Disabled", value: "disabled" },
			],
		},
		{
			displayName: "Reasoning Effort",
			name: "reasoningEffort",
			type: "options",
			default: "medium",
			description:
				"값이 높을수록 어려운 작업의 품질은 좋아질 수 있지만 시간과 토큰을 더 사용합니다.",
			options: [
				{ name: "Minimal", value: "minimal" },
				{ name: "Low", value: "low" },
				{ name: "Medium", value: "medium" },
				{ name: "High", value: "high" },
				{ name: "Extra High", value: "xhigh" },
			],
		},
		{
			displayName: "Verbosity",
			name: "verbosity",
			type: "options",
			default: "medium",
			description:
				"Codex 응답을 얼마나 짧게 또는 자세하게 만들지 정합니다.",
			options: [
				{ name: "Low", value: "low" },
				{ name: "Medium", value: "medium" },
				{ name: "High", value: "high" },
			],
		},
		{
			displayName: "Full Auto",
			name: "fullAuto",
			type: "boolean",
			default: false,
			description:
				"선택한 sandbox와 approval policy 안에서 Codex가 더 자율적으로 행동하게 합니다.",
		},
		{
			displayName: "Include Events In Output",
			name: "includeEvents",
			type: "boolean",
			default: false,
			description:
				'디버깅용으로 SDK thread 이벤트 원문을 이 노드의 Output JSON에 포함합니다. n8n의 Logs 패널을 채우는 것은 아니고, 반환 결과에만 추가됩니다.',
		},
		{
			displayName: "Event Payload Detail",
			name: "eventPayloadDetail",
			type: "options",
			default: "summary",
			description:
				'"events" 출력에 요약만 넣을지, 원본 payload 전체를 넣을지 정합니다.',
			options: [
				{ name: "Summary", value: "summary" },
				{ name: "Full Raw Payload", value: "full" },
			],
			displayOptions: { show: { includeEvents: [true] } },
		},
		{
			displayName: "Event Content Max Length",
			name: "eventContentMaxLength",
			type: "number",
			default: 400,
			description:
				'Event Payload Detail이 Summary일 때 긴 이벤트 텍스트와 MCP payload를 이 길이까지 잘라서 반환합니다.',
			displayOptions: { show: { includeEvents: [true], eventPayloadDetail: ["summary"] } },
		},
		{
			displayName: "Streaming",
			name: "streaming",
			type: "boolean",
			default: true,
			description:
				"SDK 스트리밍 경로를 사용합니다. 활성화하면 Logs 트리에 실행 중 도구 호출이 기록되고, n8n 실행 UI가 실시간 청크 표시를 지원하면 응답이 진행 중에 바로 보입니다. 비활성화하면 SDK가 완료 후 한 번에 결과를 반환하며 Logs 트리 항목이 생성되지 않습니다.",
		},
		{
			displayName: "Ephemeral",
			name: "ephemeral",
			type: "boolean",
			default: defaults.ephemeralDefault,
			description: defaults.ephemeralDescription,
		},
		{
			displayName: "Skip Git Repo Check",
			name: "skipGitRepoCheck",
			type: "boolean",
			default: false,
			description:
				"보통은 끄고 사용하세요. Git 저장소가 아닌 작업 디렉터리는 자동으로 감지해 건너뜁니다. 강제로 검사 우회를 시키고 싶을 때만 켜세요.",
		},
		{
			displayName: "Enable Network Access",
			name: "networkAccessEnabled",
			type: "boolean",
			default: false,
			description:
				"런타임과 sandbox가 허용하는 범위에서 Codex의 네트워크 접근을 허용합니다.",
		},
		{
			displayName: "Additional Directories",
			name: "additionalDirectories",
			type: "string",
			typeOptions: { rows: 3 },
			default: "",
			description:
				"Codex가 추가로 읽거나 사용할 수 있는 경로 목록입니다. 쉼표 또는 줄바꿈으로 구분합니다.",
		},
		{
			displayName: "Auto Compact Token Limit",
			name: "autoCompactTokenLimit",
			type: "number",
			default: 0,
			description:
				"자동 compact를 시작할 토큰 기준값입니다. 0이면 Codex 기본 동작을 유지합니다.",
		},
		{
			displayName: "Parse Final Response As JSON",
			name: "parseFinalResponseAsJson",
			type: "boolean",
			default: defaults.parseFinalResponseAsJsonDefault,
			description: defaults.parseFinalResponseAsJsonDescription,
		},
	];

	if (defaults.includeOutputSchemaJson) {
		fields.push({
			displayName: "Output Schema JSON",
			name: "outputSchemaJson",
			type: "string",
			typeOptions: { rows: 6 },
			default: "",
			description:
				"Codex에게 구조화된 최종 응답을 요청할 때 사용하는 선택형 JSON Schema입니다.",
		});
	}

	fields.push(
		{
			displayName: "Use Workspace Skills",
			name: "useWorkspaceSkills",
			type: "boolean",
			default: true,
			description:
				"작업 디렉터리에 `.codex/skills` 폴더가 있으면 자동으로 Codex에 노출합니다.",
		},
		{
			displayName: "Additional Skill Paths",
			name: "additionalSkillPaths",
			type: "string",
			typeOptions: { rows: 3 },
			default: "",
			description:
				"워크스페이스 skill 외에 추가로 노출할 skill 디렉터리 목록입니다. 쉼표 또는 줄바꿈으로 구분합니다.",
		},
		{
			displayName: "Advanced Config JSON",
			name: "advancedConfigJson",
			type: "string",
			typeOptions: { rows: 6 },
			default: "",
			description:
				"기본 필드만으로 부족할 때 raw Codex config를 직접 덮어쓸 수 있는 고급 설정입니다.",
		},
		{
			displayName: "Extra Environment JSON",
			name: "extraEnvJson",
			type: "string",
			typeOptions: { rows: 4 },
			default: "",
			description:
				'Codex 프로세스에 추가로 주입할 환경 변수 JSON입니다. 예: {"HTTPS_PROXY":"http://proxy:8080"}',
		},
	);

	return fields;
}

module.exports = {
	buildCodexMcpConfig,
	buildSharedOptionFields,
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
