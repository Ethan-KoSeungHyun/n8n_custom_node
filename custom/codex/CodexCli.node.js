"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexCli = void 0;

const { NodeConnectionTypes, NodeOperationError } = require("n8n-workflow");
const { executeAgentRun } = require("./runtime/codex-service");
const { runCliAuth, runCliMcp } = require("./runtime/cli-runtime");
const { parseOptionalJsonArray } = require("./lib/codex-cli");
const {
	getBaseNodeContext,
	parseDelimitedPaths,
	parseJsonObjectOrEmpty,
	readCommonOptions,
	resolveSessionIdField,
} = require("./lib/node-runtime-helpers");

class CodexCli {
	description = {
		displayName: "Codex CLI",
		name: "codexCli",
		icon: { light: "file:codex.svg", dark: "file:codex.svg" },
		group: ["transform"],
		version: 1,
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description:
			"Legacy Codex operations node for auth, MCP, review, and fallback agent execution",
		defaults: { name: "Codex CLI", color: "#111111" },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: "codexCliApi", required: true }],
		codex: {
			categories: ["AI"],
			subcategories: {
				AI: ["Agents"],
			},
			resources: {
				primaryDocumentation: [
					{ url: "https://developers.openai.com/codex" },
					{ url: "https://developers.openai.com/codex/noninteractive" },
					{ url: "https://developers.openai.com/codex/sdk" },
				],
				credentialDocumentation: [
					{ url: "https://developers.openai.com/codex/auth" },
				],
			},
		},
		properties: [
			{
				displayName: "Resource",
				name: "resource",
				type: "options",
				noDataExpression: true,
				default: "agent",
				options: [
					{ name: "Agent", value: "agent" },
					{ name: "Auth", value: "auth" },
					{ name: "MCP", value: "mcp" },
				],
			},
			{
				displayName:
					"For new chat-style workflows, prefer Codex Agent. Use Codex CLI mainly for Auth, MCP management, Review, and compatibility or fallback runs.",
				name: "legacyNodeNotice",
				type: "notice",
				default: "",
			},
			{
				displayName: "Operation",
				name: "operation",
				type: "options",
				noDataExpression: true,
				default: "exec",
				displayOptions: { show: { resource: ["agent"] } },
				options: [
					{ name: "Execute Prompt", value: "exec", action: "Execute a prompt" },
					{
						name: "Resume Thread",
						value: "resume",
						action: "Resume a specific or last thread",
					},
					{ name: "Review Changes", value: "review", action: "Run a review" },
				],
			},
			{
				displayName: "Operation",
				name: "operation",
				type: "options",
				noDataExpression: true,
				default: "status",
				displayOptions: { show: { resource: ["auth"] } },
				options: [
					{ name: "Status", value: "status", action: "Check auth status" },
					{
						name: "Login with API Key",
						value: "loginApiKey",
						action: "Persist API key auth",
					},
					{ name: "Logout", value: "logout", action: "Remove stored auth" },
				],
			},
			{
				displayName: "Operation",
				name: "operation",
				type: "options",
				noDataExpression: true,
				default: "list",
				displayOptions: { show: { resource: ["mcp"] } },
				options: [
					{ name: "List Servers", value: "list", action: "List MCP servers" },
					{ name: "Get Server", value: "get", action: "Get one MCP server" },
					{ name: "Add Server", value: "add", action: "Add an MCP server" },
					{
						name: "Remove Server",
						value: "remove",
						action: "Remove an MCP server",
					},
					{
						name: "Login Server",
						value: "login",
						action: "Run MCP OAuth login",
					},
					{
						name: "Logout Server",
						value: "logout",
						action: "Run MCP OAuth logout",
					},
				],
			},
			{
				displayName: "State Scope",
				name: "stateScope",
				type: "options",
				default: "workspaceScoped",
				description:
					"Where Codex stores auth, sessions, memory, and MCP configuration",
				options: [
					{
						name: "Workspace Scoped (Recommended)",
						value: "workspaceScoped",
					},
					{ name: "System Default", value: "systemDefault" },
					{ name: "Custom Path", value: "customPath" },
				],
			},
			{
				displayName: "Custom CODEX_HOME",
				name: "customCodexHome",
				type: "string",
				default: "",
				displayOptions: { show: { stateScope: ["customPath"] } },
			},
			{
				displayName: "Working Directory",
				name: "workingDirectory",
				type: "string",
				default: "",
				displayOptions: { show: { resource: ["agent"] } },
				description:
					"Absolute path or workspace-relative path. Leave empty to use the current n8n process directory",
			},
			{
				displayName: "Prompt",
				name: "prompt",
				type: "string",
				typeOptions: { rows: 6 },
				default: "",
				required: true,
				displayOptions: { show: { resource: ["agent"], operation: ["exec"] } },
				description: "The main user request or task sent to Codex",
			},
			{
				displayName: "Prompt",
				name: "prompt",
				type: "string",
				typeOptions: { rows: 6 },
				default: "",
				displayOptions: {
					show: { resource: ["agent"], operation: ["resume", "review"] },
				},
				description: "Optional follow-up instructions",
			},
			{
				displayName: "System Instructions",
				name: "systemInstructions",
				type: "string",
				typeOptions: { rows: 4 },
				default: "",
				displayOptions: {
					show: { resource: ["agent"], operation: ["exec", "resume"] },
				},
			},
			{
				displayName: "Runtime",
				name: "runtimeMode",
				type: "options",
				default: "auto",
				displayOptions: { show: { resource: ["agent"] } },
				options: [
					{ name: "Auto (Recommended)", value: "auto" },
					{ name: "CLI", value: "cli" },
					{ name: "SDK", value: "sdk" },
				],
				description:
					'Auto currently defaults to "CLI" for the legacy node until SDK parity is fully validated',
			},
			{
				displayName: "Model",
				name: "model",
				type: "string",
				default: "",
				displayOptions: { show: { resource: ["agent"] } },
				description: 'Optional model override, for example "gpt-5-codex"',
			},
			{
				displayName: "Session Strategy",
				name: "sessionStrategy",
				type: "options",
				default: "autoResume",
				displayOptions: { show: { resource: ["agent"], operation: ["exec"] } },
				options: [
					{ name: "Auto Resume", value: "autoResume" },
					{ name: "Always New", value: "alwaysNew" },
					{ name: "Specific Thread ID", value: "specificThreadId" },
					{ name: "Last Thread", value: "lastThread" },
				],
			},
			{
				displayName: "Session ID",
				name: "sessionId",
				type: "string",
				default: "={{ $json.sessionId }}",
				displayOptions: {
					show: {
						resource: ["agent"],
						operation: ["exec"],
						sessionStrategy: ["autoResume"],
					},
				},
				description:
					"Used for automatic sessionId -> threadId binding in the active n8n database",
			},
			{
				displayName: "Thread ID",
				name: "threadId",
				type: "string",
				default: "",
				displayOptions: {
					show: {
						resource: ["agent"],
						operation: ["exec"],
						sessionStrategy: ["specificThreadId"],
					},
				},
			},
			{
				displayName: "Resume Mode",
				name: "resumeMode",
				type: "options",
				default: "specificThreadId",
				displayOptions: { show: { resource: ["agent"], operation: ["resume"] } },
				options: [
					{ name: "Specific Thread ID", value: "specificThreadId" },
					{ name: "Last Thread", value: "lastThread" },
				],
			},
			{
				displayName: "Thread ID",
				name: "resumeThreadId",
				type: "string",
				default: "",
				displayOptions: {
					show: {
						resource: ["agent"],
						operation: ["resume"],
						resumeMode: ["specificThreadId"],
					},
				},
			},
			{
				displayName: "Review Target",
				name: "reviewTarget",
				type: "options",
				default: "uncommitted",
				displayOptions: { show: { resource: ["agent"], operation: ["review"] } },
				options: [
					{ name: "Uncommitted Changes", value: "uncommitted" },
					{ name: "Base Branch", value: "base" },
					{ name: "Commit", value: "commit" },
				],
			},
			{
				displayName: "Base Branch",
				name: "baseBranch",
				type: "string",
				default: "",
				required: true,
				displayOptions: {
					show: {
						resource: ["agent"],
						operation: ["review"],
						reviewTarget: ["base"],
					},
				},
			},
			{
				displayName: "Commit SHA",
				name: "commitSha",
				type: "string",
				default: "",
				required: true,
				displayOptions: {
					show: {
						resource: ["agent"],
						operation: ["review"],
						reviewTarget: ["commit"],
					},
				},
			},
			{
				displayName: "Review Title",
				name: "reviewTitle",
				type: "string",
				default: "",
				displayOptions: { show: { resource: ["agent"], operation: ["review"] } },
			},
			...buildCommonOptionFields(),
			{
				displayName: "Server Name",
				name: "serverName",
				type: "string",
				default: "",
				required: true,
				displayOptions: {
					show: {
						resource: ["mcp"],
						operation: ["get", "add", "remove", "login", "logout"],
					},
				},
			},
			{
				displayName: "Server Type",
				name: "serverType",
				type: "options",
				default: "http",
				displayOptions: { show: { resource: ["mcp"], operation: ["add"] } },
				options: [
					{ name: "Streamable HTTP", value: "http" },
					{ name: "stdio Command", value: "stdio" },
				],
			},
			{
				displayName: "Server URL",
				name: "serverUrl",
				type: "string",
				default: "",
				required: true,
				displayOptions: {
					show: { resource: ["mcp"], operation: ["add"], serverType: ["http"] },
				},
			},
			{
				displayName: "Bearer Token Env Var",
				name: "bearerTokenEnvVar",
				type: "string",
				default: "",
				displayOptions: {
					show: { resource: ["mcp"], operation: ["add"], serverType: ["http"] },
				},
			},
			{
				displayName: "Command",
				name: "stdioCommand",
				type: "string",
				default: "",
				required: true,
				displayOptions: {
					show: { resource: ["mcp"], operation: ["add"], serverType: ["stdio"] },
				},
			},
			{
				displayName: "Arguments JSON",
				name: "stdioArgsJson",
				type: "string",
				typeOptions: { rows: 4 },
				default: "",
				displayOptions: {
					show: { resource: ["mcp"], operation: ["add"], serverType: ["stdio"] },
				},
				description:
					'Optional JSON array, for example ["server.js","--port","3000"]',
			},
			{
				displayName: "Command Env JSON",
				name: "commandEnvJson",
				type: "string",
				typeOptions: { rows: 4 },
				default: "",
				displayOptions: {
					show: { resource: ["mcp"], operation: ["add"], serverType: ["stdio"] },
				},
				description:
					'Optional JSON object, for example {"GITHUB_TOKEN":"{{$env.GITHUB_TOKEN}}"}',
			},
			{
				displayName: "Scopes",
				name: "scopes",
				type: "string",
				default: "",
				displayOptions: { show: { resource: ["mcp"], operation: ["login"] } },
				description: "Optional comma-separated OAuth scopes",
			},
		],
	};

	async execute() {
		const items = this.getInputData();
		const returnData = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
			try {
				const result = await executeItem(this, itemIndex);
				returnData.push({ json: result, pairedItem: { item: itemIndex } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: formatErrorOutput(error),
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error, { itemIndex });
			}
		}

		return [returnData];
	}
}

function buildCommonOptionFields() {
	return [
		{
			displayName: "Sandbox",
			name: "sandbox",
			type: "options",
			default: "workspace-write",
			displayOptions: { show: { resource: ["agent"] } },
			description:
				"Controls whether Codex can only read files, write inside the workspace, or access the system more broadly",
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
			displayOptions: { show: { resource: ["agent"] } },
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
			displayOptions: { show: { resource: ["agent"] } },
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
			displayOptions: { show: { resource: ["agent"] } },
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
			displayOptions: { show: { resource: ["agent"] } },
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
			displayOptions: { show: { resource: ["agent"] } },
		},
		{
			displayName: "Include Events In Output",
			name: "includeEvents",
			type: "boolean",
			default: false,
			displayOptions: { show: { resource: ["agent"] } },
			description:
				"Events are always stored internally; this controls whether they are also returned in node output",
		},
		{
			displayName: "Streaming",
			name: "streaming",
			type: "boolean",
			default: false,
			displayOptions: { show: { resource: ["agent"] } },
			description:
				"If SDK runtime is used, stream events internally before the final result is returned",
		},
		{
			displayName: "Ephemeral",
			name: "ephemeral",
			type: "boolean",
			default: false,
			displayOptions: { show: { resource: ["agent"] } },
		},
		{
			displayName: "Skip Git Repo Check",
			name: "skipGitRepoCheck",
			type: "boolean",
			default: false,
			displayOptions: { show: { resource: ["agent"] } },
			description:
				"Leave off for normal use. Non-Git working directories are auto-detected and skipped automatically; enable only to force the bypass",
		},
		{
			displayName: "Danger Bypass",
			name: "dangerBypass",
			type: "boolean",
			default: false,
			displayOptions: { show: { resource: ["agent"] } },
			description:
				"Pass the CLI bypass flag. Use with care and only for trusted workspaces.",
		},
		{
			displayName: "Enable Network Access",
			name: "networkAccessEnabled",
			type: "boolean",
			default: false,
			displayOptions: { show: { resource: ["agent"] } },
		},
		{
			displayName: "Additional Directories",
			name: "additionalDirectories",
			type: "string",
			typeOptions: { rows: 3 },
			default: "",
			displayOptions: { show: { resource: ["agent"] } },
			description: "Comma or newline separated list of extra directories Codex may access",
		},
		{
			displayName: "Auto Compact Token Limit",
			name: "autoCompactTokenLimit",
			type: "number",
			default: 0,
			displayOptions: { show: { resource: ["agent"] } },
			description: "0 disables this override",
		},
		{
			displayName: "Parse Final Response As JSON",
			name: "parseFinalResponseAsJson",
			type: "boolean",
			default: false,
			displayOptions: { show: { resource: ["agent"] } },
		},
		{
			displayName: "Output Schema JSON",
			name: "outputSchemaJson",
			type: "string",
			typeOptions: { rows: 6 },
			default: "",
			displayOptions: { show: { resource: ["agent"] } },
		},
		{
			displayName: "Use Workspace Skills",
			name: "useWorkspaceSkills",
			type: "boolean",
			default: true,
			displayOptions: { show: { resource: ["agent"] } },
			description:
				"If a .codex/skills directory exists in the working directory, expose it to the agent",
		},
		{
			displayName: "Additional Skill Paths",
			name: "additionalSkillPaths",
			type: "string",
			typeOptions: { rows: 3 },
			default: "",
			displayOptions: { show: { resource: ["agent"] } },
			description: "Comma or newline separated list of extra skill directories",
		},
		{
			displayName: "Advanced Config JSON",
			name: "advancedConfigJson",
			type: "string",
			typeOptions: { rows: 6 },
			default: "",
			displayOptions: { show: { resource: ["agent"] } },
			description:
				"Advanced escape hatch for raw Codex config overrides. First-class fields still take precedence.",
		},
		{
			displayName: "Options JSON (Legacy)",
			name: "optionsJson",
			type: "string",
			typeOptions: { rows: 6 },
			default: "",
			displayOptions: { show: { resource: ["agent"] } },
			description:
				"Backward compatibility field from the older node version. Prefer the first-class option fields above.",
		},
		{
			displayName: "Extra Environment JSON",
			name: "extraEnvJson",
			type: "string",
			typeOptions: { rows: 4 },
			default: "",
			description:
				'Optional JSON object of environment variables, for example {"HTTPS_PROXY":"http://proxy:8080"}',
		},
	];
}

async function executeItem(context, itemIndex) {
	const resource = context.getNodeParameter("resource", itemIndex);

	if (resource === "auth") {
		const base = await getBaseNodeContext(context, itemIndex);
		const result = await runCliAuth({
			operation: context.getNodeParameter("operation", itemIndex),
			credentials: base.credentials,
			env: base.env,
		});
		return {
			resource: "auth",
			operation: context.getNodeParameter("operation", itemIndex),
			codexHome: base.codexHome || null,
			...result,
		};
	}

	if (resource === "mcp") {
		const base = await getBaseNodeContext(context, itemIndex);
		const operation = context.getNodeParameter("operation", itemIndex);
		const request = {
			operation,
			credentials: base.credentials,
			env: base.env,
			serverName: context.getNodeParameter("serverName", itemIndex, ""),
			serverType: context.getNodeParameter("serverType", itemIndex, "http"),
			serverUrl: context.getNodeParameter("serverUrl", itemIndex, ""),
			bearerTokenEnvVar: context.getNodeParameter(
				"bearerTokenEnvVar",
				itemIndex,
				"",
			),
			stdioCommand: context.getNodeParameter("stdioCommand", itemIndex, ""),
			stdioArgs: parseOptionalJsonArray(
				context.getNodeParameter("stdioArgsJson", itemIndex, ""),
				"Arguments JSON",
			),
			commandEnv: parseJsonObjectOrEmpty(
				context.getNodeParameter("commandEnvJson", itemIndex, ""),
				"Command Env JSON",
			),
			scopes: parseDelimitedPaths(
				context.getNodeParameter("scopes", itemIndex, ""),
			),
		};
		if (!Array.isArray(request.stdioArgs)) {
			request.stdioArgs = [];
		}

		const result = await runCliMcp(request);
		return {
			resource: "mcp",
			operation,
			codexHome: base.codexHome || null,
			...result,
		};
	}

	return await executeAgentItem(context, itemIndex);
}

async function executeAgentItem(context, itemIndex) {
	const base = await getBaseNodeContext(context, itemIndex);
	const operation = context.getNodeParameter("operation", itemIndex);
	const options = readCommonOptions(context, itemIndex);
	const runtimeMode = context.getNodeParameter("runtimeMode", itemIndex, "auto");
	const prompt = context.getNodeParameter("prompt", itemIndex, "");
	const model = context.getNodeParameter("model", itemIndex, "");
	const systemInstructions = context.getNodeParameter(
		"systemInstructions",
		itemIndex,
		"",
	);

	let sessionStrategy = "alwaysNew";
	let sessionId = null;
	let threadId = null;
	let resumeLast = false;

	if (operation === "exec") {
		sessionStrategy = context.getNodeParameter(
			"sessionStrategy",
			itemIndex,
			"autoResume",
		);
		if (sessionStrategy === "autoResume") {
			sessionId = resolveSessionIdField(context, itemIndex, "sessionId") || null;
		}
		if (sessionStrategy === "specificThreadId") {
			threadId = context.getNodeParameter("threadId", itemIndex, "");
		}
		if (sessionStrategy === "lastThread") {
			resumeLast = true;
		}
	} else if (operation === "resume") {
		const resumeMode = context.getNodeParameter(
			"resumeMode",
			itemIndex,
			"specificThreadId",
		);
		if (resumeMode === "lastThread") {
			sessionStrategy = "lastThread";
			resumeLast = true;
		} else {
			sessionStrategy = "specificThreadId";
			threadId = context.getNodeParameter("resumeThreadId", itemIndex, "");
		}
	}

	const result = await executeAgentRun({
		resource: "agent",
		operation,
		runtimeMode,
		defaultRuntime: "cli",
		workflowId: base.workflowId,
		nodeId: base.nodeId,
		executionId: base.executionId,
		credentials: base.credentials,
		codexHome: base.codexHome,
		env: base.env,
		workingDirectory: base.workingDirectory,
		prompt,
		systemInstructions,
		model,
		options,
		sessionStrategy,
		sessionId,
		threadId,
		resumeLast,
		reviewTarget: context.getNodeParameter("reviewTarget", itemIndex, "uncommitted"),
		baseBranch: context.getNodeParameter("baseBranch", itemIndex, ""),
		commitSha: context.getNodeParameter("commitSha", itemIndex, ""),
		reviewTitle: context.getNodeParameter("reviewTitle", itemIndex, ""),
		memory: null,
		codexConfig: {},
	});

	return {
		resource: "agent",
		operation,
		codexHome: base.codexHome || null,
		workingDirectory: base.workingDirectory,
		...result,
	};
}

function formatErrorOutput(error) {
	const details = error?.details ?? {};
	return {
		error: error.message,
		exitCode: details.exitCode ?? null,
		stdout: details.stdout ?? "",
		stderr: details.stderr ?? "",
		command: details.args ?? [],
	};
}

exports.CodexCli = CodexCli;
