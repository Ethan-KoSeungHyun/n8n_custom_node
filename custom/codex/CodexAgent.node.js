"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexAgent = void 0;

const { NodeConnectionTypes, NodeOperationError } = require("n8n-workflow");
const { executeAgentRun } = require("./runtime/codex-service");
const {
	buildCodexMcpConfig,
	getBaseNodeContext,
	getConnectedCodexMemory,
	getConnectedCodexToolsets,
	readCommonOptions,
	resolveSessionIdField,
	toConnectionArray,
} = require("./lib/node-runtime-helpers");

class CodexAgent {
	description = {
		displayName: "Codex Agent",
		name: "codexAgent",
		icon: { light: "file:codex.svg", dark: "file:codex.svg" },
		group: ["transform"],
		version: 1,
		description: "Run Codex as a root AI agent node with session, memory, and MCP support",
		defaults: {
			name: "Codex Agent",
			color: "#404040",
		},
		codex: {
			categories: ["AI"],
			subcategories: {
				AI: ["Agents", "Root Nodes"],
			},
			resources: {
				primaryDocumentation: [
					{
						url: "https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/",
					},
				],
			},
		},
		inputs: [
			NodeConnectionTypes.Main,
			{
				displayName: "Memory",
				type: NodeConnectionTypes.AiMemory,
				required: false,
				maxConnections: 1,
			},
			{
				displayName: "Tools",
				type: NodeConnectionTypes.AiTool,
				required: false,
			},
		],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: "codexCliApi", required: true }],
		properties: [
			{
				displayName:
					"Recommended for chat workflows: keep State Scope as Workspace Scoped, Session Strategy as Auto Resume, and Session ID as {{$json.sessionId}}.",
				name: "recommendedSetupNotice",
				type: "notice",
				default: "",
			},
			{
				displayName:
					"Codex Agent is the main conversational node. Connect Codex Memory for session continuity and Codex MCP Toolset for MCP servers.",
				name: "memoryAndToolNotice",
				type: "notice",
				default: "",
			},
			{
				displayName: "Prompt",
				name: "prompt",
				type: "string",
				typeOptions: { rows: 6 },
				default: "={{ $json.chatInput || $json.prompt || '' }}",
				required: true,
				description: "The main user request or task sent to Codex",
			},
			{
				displayName: "System Instructions",
				name: "systemInstructions",
				type: "string",
				typeOptions: { rows: 4 },
				default: "",
				description:
					"Optional persistent guidance applied before the prompt, for example response style or task boundaries",
			},
			{
				displayName: "Model",
				name: "model",
				type: "string",
				default: "",
				description:
					'Optional model override. Leave empty to use the Codex default for this environment',
			},
			{
				displayName: "Runtime",
				name: "runtimeMode",
				type: "options",
				default: "auto",
				options: [
					{ name: "Auto (CLI First)", value: "auto" },
					{ name: "CLI", value: "cli" },
					{ name: "SDK", value: "sdk" },
				],
				description:
					"Auto is the safest default. Choose SDK if you specifically want the newer SDK execution path",
			},
			{
				displayName: "State Scope",
				name: "stateScope",
				type: "options",
				default: "workspaceScoped",
				options: [
					{ name: "Workspace Scoped (Recommended)", value: "workspaceScoped" },
					{ name: "System Default", value: "systemDefault" },
					{ name: "Custom Path", value: "customPath" },
				],
			},
			{
				displayName: "Custom CODEX_HOME",
				name: "customCodexHome",
				type: "string",
				default: "",
				displayOptions: {
					show: {
						stateScope: ["customPath"],
					},
				},
			},
			{
				displayName: "Working Directory",
				name: "workingDirectory",
				type: "string",
				default: "",
				description:
					"Absolute path or workspace-relative path. Leave empty to use the current n8n process directory and workspace root",
			},
			{
				displayName: "Session Strategy",
				name: "sessionStrategy",
				type: "options",
				default: "autoResume",
				options: [
					{ name: "Auto Resume", value: "autoResume" },
					{ name: "Always New", value: "alwaysNew" },
					{ name: "Specific Thread ID", value: "specificThreadId" },
					{ name: "Last Thread", value: "lastThread" },
				],
				description:
					"Auto Resume is recommended for chat-style workflows so the same session can continue over time",
			},
			{
				displayName: "Session ID",
				name: "sessionId",
				type: "string",
				default: "={{ $json.sessionId }}",
				description:
					"The stable chat or user session key. With Auto Resume, this maps to a saved Codex thread automatically",
				displayOptions: {
					show: {
						sessionStrategy: ["autoResume"],
					},
				},
			},
			{
				displayName: "Thread ID",
				name: "threadId",
				type: "string",
				default: "",
				description:
					"Use only when you already know the exact Codex thread ID to continue",
				displayOptions: {
					show: {
						sessionStrategy: ["specificThreadId"],
					},
				},
			},
			...buildCommonFields(),
		],
	};

	async execute() {
		const items = this.getInputData();
		const returnData = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
			try {
				const base = await getBaseNodeContext(this, itemIndex);
				const options = readCommonOptions(this, itemIndex);
				const toolsets = await getConnectedCodexToolsets(this);
				const memory = await getConnectedCodexMemory(this);
				const connectedTools = toConnectionArray(
					await this.getInputConnectionData(NodeConnectionTypes.AiTool, 0),
				);
				const ignoredToolCount = Math.max(
					0,
					connectedTools.length - toolsets.length,
				);

				const sessionStrategy = this.getNodeParameter(
					"sessionStrategy",
					itemIndex,
					"autoResume",
				);
				const sessionId =
					sessionStrategy === "autoResume"
						? resolveSessionIdField(this, itemIndex, "sessionId") || null
						: memory?.sessionId || null;
				const threadId =
					sessionStrategy === "specificThreadId"
						? this.getNodeParameter("threadId", itemIndex, "")
						: null;

				const result = await executeAgentRun({
					resource: "agent",
					operation: "exec",
					runtimeMode: this.getNodeParameter("runtimeMode", itemIndex, "auto"),
					defaultRuntime: "cli",
					workflowId: base.workflowId,
					nodeId: base.nodeId,
					executionId: base.executionId,
					credentials: base.credentials,
					codexHome: base.codexHome,
					env: base.env,
					workingDirectory: base.workingDirectory,
					prompt: this.getNodeParameter("prompt", itemIndex),
					systemInstructions: this.getNodeParameter(
						"systemInstructions",
						itemIndex,
						"",
					),
					model: this.getNodeParameter("model", itemIndex, ""),
					options,
					sessionStrategy,
					sessionId,
					threadId,
					resumeLast: sessionStrategy === "lastThread",
					memory,
					codexConfig: buildCodexMcpConfig(toolsets),
				});

				returnData.push({
					json: {
						resource: "agent",
						operation: "exec",
						codexHome: base.codexHome || null,
						workingDirectory: base.workingDirectory,
						ignoredToolCount,
						...result,
					},
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: error.message,
						},
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

function buildCommonFields() {
	return [
		{
			displayName: "Sandbox",
			name: "sandbox",
			type: "options",
			default: "workspace-write",
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
			description:
				"Controls when Codex should pause and ask for approval before sensitive actions",
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
			description:
				"Controls whether Codex may use web search during the run",
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
				"Higher effort can improve harder tasks at the cost of more time and tokens",
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
				"Controls how terse or detailed the Codex response should be",
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
				"Let Codex act more autonomously within the chosen sandbox and approval policy",
		},
		{
			displayName: "Include Events In Output",
			name: "includeEvents",
			type: "boolean",
			default: false,
			description:
				"Execution events are always stored internally; turn this on only if you also want them in node output",
		},
		{
			displayName: "Streaming",
			name: "streaming",
			type: "boolean",
			default: false,
			description:
				"When SDK runtime is used, collect streamed events internally before returning the final result",
		},
		{
			displayName: "Ephemeral",
			name: "ephemeral",
			type: "boolean",
			default: false,
			description:
				"Use an isolated throwaway execution instead of reusing more persistent local state where supported",
		},
		{
			displayName: "Skip Git Repo Check",
			name: "skipGitRepoCheck",
			type: "boolean",
			default: false,
			description:
				"Leave off for normal use. Non-Git working directories are auto-detected and skipped automatically; enable only to force the bypass",
		},
		{
			displayName: "Danger Bypass",
			name: "dangerBypass",
			type: "boolean",
			default: false,
			description:
				"Bypass normal safety gates in the CLI path. Use only in tightly controlled environments",
		},
		{
			displayName: "Enable Network Access",
			name: "networkAccessEnabled",
			type: "boolean",
			default: false,
			description:
				"Allow Codex to access the network when the runtime and sandbox support it",
		},
		{
			displayName: "Additional Directories",
			name: "additionalDirectories",
			type: "string",
			typeOptions: { rows: 3 },
			default: "",
			description:
				"Comma or newline separated paths that Codex may also read from or use",
		},
		{
			displayName: "Auto Compact Token Limit",
			name: "autoCompactTokenLimit",
			type: "number",
			default: 0,
			description:
				"Optional token threshold for compaction. Leave 0 to keep the Codex default behavior",
		},
		{
			displayName: "Parse Final Response As JSON",
			name: "parseFinalResponseAsJson",
			type: "boolean",
			default: false,
			description:
				"Try to parse the final response as JSON and return it in parsedFinalResponse",
		},
		{
			displayName: "Output Schema JSON",
			name: "outputSchemaJson",
			type: "string",
			typeOptions: { rows: 6 },
			default: "",
			description:
				"Optional JSON Schema used to request a structured final response from Codex",
		},
		{
			displayName: "Use Workspace Skills",
			name: "useWorkspaceSkills",
			type: "boolean",
			default: true,
			description:
				"If a .codex/skills folder exists in the working directory, expose it to Codex automatically",
		},
		{
			displayName: "Additional Skill Paths",
			name: "additionalSkillPaths",
			type: "string",
			typeOptions: { rows: 3 },
			default: "",
			description:
				"Comma or newline separated skill directories to expose in addition to workspace skills",
		},
		{
			displayName: "Advanced Config JSON",
			name: "advancedConfigJson",
			type: "string",
			typeOptions: { rows: 6 },
			default: "",
			description:
				"Advanced escape hatch for raw Codex config overrides when the first-class fields are not enough",
		},
		{
			displayName: "Extra Environment JSON",
			name: "extraEnvJson",
			type: "string",
			typeOptions: { rows: 4 },
			default: "",
			description:
				'Optional JSON object of environment variables to inject into the Codex process, for example {"HTTPS_PROXY":"http://proxy:8080"}',
		},
	];
}

exports.CodexAgent = CodexAgent;
