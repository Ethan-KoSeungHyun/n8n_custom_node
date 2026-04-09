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
	assertSavedMcpServerConfig,
	buildCodexMcpConfig,
	buildSharedOptionFields,
	describeConfiguredMcpToolsets,
	getBaseNodeContext,
	getConnectedCodexMemory,
	getConnectedCodexToolsets,
	readCommonOptions,
	resolveModelField,
	resolveSessionIdField,
} = require("./lib/node-runtime-helpers");
const { getAgentByKey } = require("./store/codex-agent-registry-store");
const { wrapHooksWithBridge } = require("./lib/node-ui-helpers");

class CodexAgentTool {
	description = {
		displayName: "Codex Agent Tool",
		name: "codexAgentTool",
		icon: { light: "file:codex.svg", dark: "file:codex.svg" },
		group: ["transform"],
		version: 1,
		description: "Codex를 AI Tool로 노출하여 다른 n8n AI Agent가 서브에이전트로 호출할 수 있게 합니다.",
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
		credentials: [{ name: "codexChatgptAccount", required: true }],
		properties: [
			{
				displayName:
					'이 tool이 호출될 때 사용할 실제 ChatGPT 로그인 주체를 분리하려면 <strong>Codex ChatGPT Account</strong> credential을 선택하세요.',
				name: "credentialModeNotice",
				type: "notice",
				default: "",
			},
			{
				displayName:
					"서브 에이전트 용도라면 Session Strategy는 Always New로, Ephemeral은 켠 상태로 두는 것을 권장합니다. 명시적으로 같은 Codex thread를 이어야 할 때만 바꾸세요.",
				name: "recommendedToolSetupNotice",
				type: "notice",
				default: "",
			},
			{
				displayName: "Agent Profile Key",
				name: "agentProfileKey",
				type: "string",
				default: "",
				description:
					"Agent Registry에 등록된 프로필 키를 입력하면 기본 모델, 시스템 프롬프트, 샌드박스, MCP 서버 설정을 자동으로 불러옵니다. 비워 두면 수동 설정을 사용합니다.",
			},
			{
				displayName: "Name",
				name: "name",
				type: "string",
				default: "",
				placeholder: "codex_worker",
				validateType: "string-alphanumeric",
				description:
					"부모 AI 에이전트에게 노출되는 tool 이름입니다. 영문자, 숫자, 밑줄만 사용할 수 있습니다.",
			},
			{
				displayName: "Description",
				name: "description",
				type: "string",
				typeOptions: { rows: 3 },
				default:
					"Use this tool when you need a code-aware sub-agent that can inspect files, use Codex MCP servers, and return a focused result.",
				description:
					"부모 에이전트가 이 tool을 언제 써야 하는지 설명합니다.",
			},
			{
				displayName: "System Prompt",
				name: "systemInstructions",
				type: "string",
				typeOptions: { rows: 4 },
				default: "",
				description:
					"부모 에이전트가 이 tool을 호출할 때 항상 적용할 추가 지침입니다.",
			},
			{
				displayName: "Model Preset",
				name: "modelPreset",
				type: "options",
				default: "",
				description:
					"자주 쓰는 Codex/OpenAI 모델 프리셋을 선택합니다. 예전 모델명이나 직접 입력이 필요하면 Custom Override를 사용하세요.",
				options: [
					{
						name: "Default (Environment Default)",
						value: "",
					},
					{
						name: "GPT-5.4 (Current)",
						value: "gpt-5.4",
					},
					{
						name: "GPT-5.4 Mini",
						value: "gpt-5.4-mini",
					},
					{
						name: "GPT-5.3 Codex",
						value: "gpt-5.3-codex",
					},
					{
						name: "GPT-5.2 Codex",
						value: "gpt-5.2-codex",
					},
					{
						name: "GPT-5.2",
						value: "gpt-5.2",
					},
					{
						name: "GPT-5.1 Codex Max",
						value: "gpt-5.1-codex-max",
					},
					{
						name: "GPT-5.1 Codex Mini",
						value: "gpt-5.1-codex-mini",
					},
					{
						name: "Custom Override",
						value: "__custom__",
					},
				],
			},
			{
				displayName: "Custom Model",
				name: "model",
				type: "string",
				default: "",
				description:
					"Model Preset이 Custom Override일 때만 사용합니다. 예전 워크플로에 직접 저장된 모델명을 유지할 때도 사용됩니다.",
				displayOptions: {
					show: {
						modelPreset: ["__custom__"],
					},
				},
			},
			{
				displayName: "Working Directory",
				name: "workingDirectory",
				type: "string",
				default: "",
				description:
					"절대 경로나 워크스페이스 기준 상대 경로를 입력합니다. 비워 두면 현재 n8n 프로세스의 작업 디렉터리를 사용합니다.",
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
					"부모 에이전트 간 상태가 섞이지 않도록 서브 에이전트 용도에서는 Always New를 권장합니다.",
			},
			{
				displayName: "Default Session ID",
				name: "sessionId",
				type: "string",
				default: "={{ $json.sessionId }}",
				description:
					"tool 입력에서 sessionId를 주지 않았고 Session Strategy가 Auto Resume일 때만 사용됩니다.",
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
					"이어갈 정확한 Codex thread ID를 이미 알고 있을 때만 사용하세요.",
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
					"최종 응답 형식을 강제할 선택형 JSON Schema입니다. 가능하면 파싱된 JSON 결과도 함께 반환합니다.",
			},
			...buildSharedOptionFields({
				sandboxDescription:
					"Codex 서브 에이전트가 파일을 읽기만 할지, 워크스페이스 안에서 쓰기까지 할지, 더 넓은 시스템 접근을 허용할지 정합니다.",
				approvalDescription:
					"민감한 작업 전에 언제 사용자 승인을 요청할지 정합니다.",
				webSearchDescription:
					"부모 에이전트를 처리하는 동안 웹 검색을 사용할 수 있는지 정합니다.",
				ephemeralDefault: true,
				ephemeralDescription:
					"기본적으로 격리 실행을 사용해 이 tool이 독립된 서브 에이전트처럼 동작하게 합니다.",
				parseFinalResponseAsJsonDefault: true,
				parseFinalResponseAsJsonDescription:
					"최종 응답을 JSON으로 파싱해 parsed 결과와 함께 반환합니다.",
			}),
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
			const mcpConfigured = describeConfiguredMcpToolsets(toolsets);
			const memory = await getConnectedCodexMemory(context);
			const toolHooks = wrapHooksWithBridge(
				null,
				memory?.loggingBridge || null,
			);
			assertSavedMcpServerConfig(toolsets, base.codexHome);

			// Load agent profile from registry if specified
			const agentProfileKey = context.getNodeParameter(
				"agentProfileKey",
				itemIndex,
				"",
			);
			let agentProfile = null;
			if (agentProfileKey) {
				try {
					agentProfile = await getAgentByKey(agentProfileKey);
				} catch {
					// Registry not available yet — use manual settings
				}
			}

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
			// Merge profile system instructions with node-level and per-call instructions
			const profileSystemInstructions = agentProfile?.defaultSystemInstructions || "";
			const effectiveSystemInstructions = [
				profileSystemInstructions,
				defaultSystemPrompt,
				query.systemInstructions,
			].filter(Boolean).join("\n\n");
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

			// Apply profile defaults — node-level settings take precedence
			const effectiveModel = resolveModelField(context, itemIndex) || agentProfile?.defaultModel || "";
			const effectiveOptions = { ...options };
			if (agentProfile?.defaultSandbox && !options.sandbox) {
				effectiveOptions.sandbox = agentProfile.defaultSandbox;
			}

			// Merge registry MCP servers with node-connected MCP toolsets
			const codexConfig = buildCodexMcpConfig(toolsets);
			if (agentProfile?.defaultMcpServers?.length) {
				if (!codexConfig.mcp_servers) codexConfig.mcp_servers = {};
				for (const server of agentProfile.defaultMcpServers) {
					if (server.serverName && !codexConfig.mcp_servers[server.serverName]) {
						codexConfig.mcp_servers[server.serverName] = {
							command: server.command || "",
							args: server.args || [],
						};
					}
				}
			}

			const result = await executeAgentRun({
				resource: "agent",
				operation: "exec",
				workflowId: base.workflowId,
				nodeId: base.nodeId,
				executionId: base.executionId,
				credentialType: base.credentialType,
				resolvedCredentialId: base.credentialRef?.id || null,
				credentials: base.credentials,
				codexHome: base.codexHome,
				profileKey: base.profileKey || null,
				authFingerprintAtRun: base.authFingerprint || null,
				env: base.env,
				workingDirectory: base.workingDirectory,
				prompt: query.prompt,
				systemInstructions: effectiveSystemInstructions,
				model: effectiveModel,
				options: effectiveOptions,
				sessionStrategy,
				sessionId,
				threadId,
				resumeLast: sessionStrategy === "lastThread",
				memory,
				mcpConfigured,
				codexConfig,
				agentKey: agentProfileKey || null,
				hooks: toolHooks || undefined,
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
				credentialType: base.credentialType,
				credentialId: base.credentialRef?.id || null,
				credentialName: base.credentialRef?.name || null,
				profileKey: base.profileKey || null,
				authFingerprint: base.authFingerprint || null,
				runtime: result.runtime,
				usage: result.usage || null,
				eventPayloadDetail: result.eventPayloadDetail || "summary",
				storedEventCount: result.storedEventCount,
				artifactsSummary: result.artifactsSummary,
				eventTypes: result.eventTypes || {},
				mcpConfigured: result.mcpConfigured || null,
				usedMcpServers: result.usedMcpServers || [],
				unusedMcpServers: result.unusedMcpServers || [],
				mcpCalls: result.mcpCalls || [],
				commands: result.commands || [],
				fileChanges: result.fileChanges || [],
				progressTimeline: result.progressTimeline || [],
				contextPressure: result.contextPressure || null,
				recommendedAction: result.recommendedAction || null,
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

exports.CodexAgentTool = CodexAgentTool;
