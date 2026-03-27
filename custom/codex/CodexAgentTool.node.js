"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexAgentTool = void 0;

const { DynamicStructuredTool } = require("@langchain/core/tools");
const { z } = require("zod");
const {
	NodeConnectionTypes,
	NodeOperationError,
	jsonParse,
	nodeNameToToolName,
} = require("n8n-workflow");
const { executeAgentRun } = require("./runtime/codex-service");
const {
	buildCodexMcpConfig,
	getBaseNodeContext,
	getConnectedCodexMemory,
	getConnectedCodexToolsets,
	parseJsonObjectOrEmpty,
	readCommonOptions,
	resolveSessionIdField,
} = require("./lib/node-runtime-helpers");

class CodexAgentTool {
	description = {
		displayName: "Codex Agent Tool",
		name: "codexAgentTool",
		icon: { light: "file:codex.svg", dark: "file:codex.svg" },
		group: ["transform"],
		version: 1,
		description: "Expose Codex as an AI tool that other n8n AI Agents can call",
		defaults: {
			name: "Codex Agent Tool",
			color: "#404040",
		},
		codex: {
			categories: ["AI"],
			subcategories: {
				AI: ["Tools"],
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
		outputs: [NodeConnectionTypes.AiTool],
		outputNames: ["Tool"],
		credentials: [{ name: "codexCliApi", required: true }],
		properties: [
			{
				displayName:
					"Recommended for sub-agent use: keep Session Strategy as Always New and Ephemeral enabled unless you explicitly want reusable Codex threads.",
				name: "recommendedToolSetupNotice",
				type: "notice",
				default: "",
			},
			{
				displayName: "Name",
				name: "name",
				type: "string",
				default: "",
				placeholder: "codex_worker",
				validateType: "string-alphanumeric",
				description:
					"Tool name exposed to the parent AI agent. Letters, numbers, and underscores only",
			},
			{
				displayName: "Description",
				name: "description",
				type: "string",
				typeOptions: { rows: 3 },
				default:
					"Use this tool when you need a code-aware sub-agent that can inspect files, use Codex MCP servers, and return a focused result.",
			},
			{
				displayName: "System Prompt",
				name: "systemInstructions",
				type: "string",
				typeOptions: { rows: 4 },
				default: "",
				description:
					"Optional persistent instructions for how this Codex tool should behave when called by a parent agent",
			},
			{
				displayName: "Model",
				name: "model",
				type: "string",
				default: "",
				description:
					'Optional model override. Leave empty to use the environment default',
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
					"Auto is the safest default. Choose SDK only when you specifically want the SDK execution path",
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
				default: "alwaysNew",
				options: [
					{ name: "Always New", value: "alwaysNew" },
					{ name: "Auto Resume", value: "autoResume" },
					{ name: "Specific Thread ID", value: "specificThreadId" },
					{ name: "Last Thread", value: "lastThread" },
				],
				description:
					"Always New is recommended for sub-agent use so parent agents do not accidentally share state",
			},
			{
				displayName: "Default Session ID",
				name: "sessionId",
				type: "string",
				default: "={{ $json.sessionId }}",
				description:
					"Used only when the tool input does not provide sessionId and Session Strategy is Auto Resume",
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
			{
				displayName: "Output Schema JSON",
				name: "outputSchemaJson",
				type: "string",
				typeOptions: { rows: 6 },
				default: "",
				description:
					"Optional JSON Schema for the final response. When set, the tool returns the parsed JSON text if available",
			},
			...buildToolOptionFields(),
		],
	};

	async supplyData(itemIndex) {
		return {
			response: createTool(this, itemIndex),
		};
	}

	async execute() {
		const input = this.getInputData();
		const result = [];

		for (let itemIndex = 0; itemIndex < input.length; itemIndex += 1) {
			try {
				const tool = createTool(this, itemIndex, false);
				const toolInput = normalizeStandaloneInput(input[itemIndex].json);
				const response = await tool.invoke(toolInput);
				result.push({
					json: jsonParse(response, { fallbackValue: { response } }),
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					result.push({
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

		return [result];
	}
}

function createTool(context, itemIndex, log = true) {
	const node = context.getNode();
	const name =
		context.getNodeParameter("name", itemIndex, "") ||
		nodeNameToToolName(node) ||
		"codex_agent_tool";
	const description = context.getNodeParameter("description", itemIndex);
	const inputSchema = z.object({
		prompt: z
			.string()
			.min(1)
			.describe("The task or prompt to send to the Codex sub-agent"),
		sessionId: z
			.string()
			.optional()
			.describe("Optional session ID to resume Codex memory across calls"),
		systemInstructions: z
			.string()
			.optional()
			.describe("Optional per-call system instructions appended to the tool default"),
	});

	const func = async (query) => {
		const { index } = log
			? context.addInputData(NodeConnectionTypes.AiTool, [[{ json: query }]])
			: { index: 0 };
		let responseText = "";
		let outputJson = {};
		let executionError;

		try {
			const base = await getBaseNodeContext(context, itemIndex);
			const options = readCommonOptions(context, itemIndex);
			const toolsets = await getConnectedCodexToolsets(context);
			const memory = await getConnectedCodexMemory(context);
			const sessionStrategy = context.getNodeParameter(
				"sessionStrategy",
				itemIndex,
				"alwaysNew",
			);
			const defaultSystemPrompt = context.getNodeParameter(
				"systemInstructions",
				itemIndex,
				"",
			);
			const effectiveSystemInstructions = [defaultSystemPrompt, query.systemInstructions]
				.filter(Boolean)
				.join("\n\n");
			const defaultSessionId =
				sessionStrategy === "autoResume"
					? resolveSessionIdField(context, itemIndex, "sessionId") || null
					: null;
			const sessionId =
				sessionStrategy === "autoResume"
					? String(query.sessionId || defaultSessionId || memory?.sessionId || "")
							.trim() || null
					: memory?.sessionId || null;
			const threadId =
				sessionStrategy === "specificThreadId"
					? context.getNodeParameter("threadId", itemIndex, "")
					: null;

			const result = await executeAgentRun({
				resource: "agent",
				operation: "exec",
				runtimeMode: context.getNodeParameter("runtimeMode", itemIndex, "auto"),
				defaultRuntime: "cli",
				workflowId: base.workflowId,
				nodeId: base.nodeId,
				executionId: base.executionId,
				credentials: base.credentials,
				codexHome: base.codexHome,
				env: base.env,
				workingDirectory: base.workingDirectory,
				prompt: query.prompt,
				systemInstructions: effectiveSystemInstructions,
				model: context.getNodeParameter("model", itemIndex, ""),
				options,
				sessionStrategy,
				sessionId,
				threadId,
				resumeLast: sessionStrategy === "lastThread",
				memory,
				codexConfig: buildCodexMcpConfig(toolsets),
			});

			const parsedOutput =
				result.parsedFinalResponse ||
				jsonParse(result.finalResponse || "", { fallbackValue: null });
			responseText =
				result.parsedFinalResponse && typeof result.parsedFinalResponse === "object"
					? JSON.stringify(result.parsedFinalResponse, null, 2)
					: result.finalResponse || "";
			outputJson = {
				response: responseText,
				runId: result.runId,
				threadId: result.threadId,
				sessionId: result.sessionId,
				runtime: result.runtime,
				usage: result.usage || null,
				storedEventCount: result.storedEventCount,
				artifactsSummary: result.artifactsSummary,
				parsed: parsedOutput,
			};
		} catch (error) {
			executionError = new NodeOperationError(context.getNode(), error);
			responseText = `There was an error: "${executionError.message}"`;
			outputJson = {
				error: executionError.message,
			};
		}

		if (log) {
			if (executionError) {
				void context.addOutputData(
					NodeConnectionTypes.AiTool,
					index,
					executionError,
				);
			} else {
				void context.addOutputData(NodeConnectionTypes.AiTool, index, [
					[{ json: outputJson }],
				]);
			}
		}

		return responseText;
	};

	return new DynamicStructuredTool({
		name,
		description,
		schema: inputSchema,
		func,
	});
}

function normalizeStandaloneInput(input) {
	if (input && typeof input.prompt === "string" && input.prompt.trim()) {
		return {
			prompt: input.prompt,
			sessionId:
				typeof input.sessionId === "string" ? input.sessionId : undefined,
			systemInstructions:
				typeof input.systemInstructions === "string"
					? input.systemInstructions
					: undefined,
		};
	}

	return {
		prompt:
			String(
				input?.chatInput ??
					input?.text ??
					input?.query ??
					input?.message ??
					input?.input ??
					"",
			).trim() || JSON.stringify(input ?? {}, null, 2),
		sessionId:
			typeof input?.sessionId === "string" ? input.sessionId : undefined,
		systemInstructions:
			typeof input?.systemInstructions === "string"
				? input.systemInstructions
				: undefined,
	};
}

function buildToolOptionFields() {
	return [
		{
			displayName: "Sandbox",
			name: "sandbox",
			type: "options",
			default: "workspace-write",
			description:
				"Controls whether the Codex sub-agent can only read files, write inside the workspace, or access the system more broadly",
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
				"Controls when Codex should ask for approval before sensitive actions",
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
				"Controls whether Codex may use web search while serving the parent agent",
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
			displayName: "Ephemeral",
			name: "ephemeral",
			type: "boolean",
			default: true,
			description:
				"Use an isolated run by default so this tool behaves like a sub-agent",
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
				"Execution events are always stored internally; turn this on only if you also want them returned in tool output",
		},
		{
			displayName: "Streaming",
			name: "streaming",
			type: "boolean",
			default: false,
			description:
				"When SDK runtime is used, collect streamed events internally before returning the final tool result",
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
			default: true,
			description:
				"Try to parse the final response as JSON and return it in parsed output",
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
			displayName: "Legacy Options JSON",
			name: "optionsJson",
			type: "string",
			typeOptions: { rows: 6 },
			default: "",
			description:
				"Compatibility escape hatch for older Codex CLI node options",
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

exports.CodexAgentTool = CodexAgentTool;
