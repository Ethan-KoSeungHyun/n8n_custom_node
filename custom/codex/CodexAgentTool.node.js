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
	describeConfiguredMcpToolsets,
	getBaseNodeContext,
	getConnectedCodexMemory,
	getConnectedCodexToolsets,
	readCommonOptions,
	resolveModelField,
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
			const mcpConfigured = describeConfiguredMcpToolsets(toolsets);
			const memory = await getConnectedCodexMemory(context);
			assertSavedMcpServerConfig(toolsets, base.codexHome);
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
				model: resolveModelField(context, itemIndex),
				options,
				sessionStrategy,
				sessionId,
				threadId,
				resumeLast: sessionStrategy === "lastThread",
				memory,
				mcpConfigured,
				codexConfig: buildCodexMcpConfig(toolsets, base.codexHome),
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

function buildToolOptionFields() {
	return [
		{
			displayName: "Sandbox",
			name: "sandbox",
			type: "options",
			default: "workspace-write",
			description:
				"Codex 서브 에이전트가 파일을 읽기만 할지, 워크스페이스 안에서 쓰기까지 할지, 더 넓은 시스템 접근을 허용할지 정합니다.",
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
				"민감한 작업 전에 언제 사용자 승인을 요청할지 정합니다.",
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
				"부모 에이전트를 처리하는 동안 웹 검색을 사용할 수 있는지 정합니다.",
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
			displayName: "Ephemeral",
			name: "ephemeral",
			type: "boolean",
			default: true,
			description:
				"기본적으로 격리 실행을 사용해 이 tool이 독립된 서브 에이전트처럼 동작하게 합니다.",
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
				'디버깅용으로 SDK thread 이벤트 원문을 반환 payload에 포함합니다. n8n의 Logs 패널을 채우는 것은 아니고, 반환 결과에만 추가됩니다.',
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
			displayOptions: {
				show: {
					includeEvents: [true],
				},
			},
		},
		{
			displayName: "Event Content Max Length",
			name: "eventContentMaxLength",
			type: "number",
			default: 400,
			description:
				'Event Payload Detail이 Summary일 때 긴 이벤트 텍스트와 MCP payload를 이 길이까지 잘라서 반환합니다.',
			displayOptions: {
				show: {
					includeEvents: [true],
					eventPayloadDetail: ["summary"],
				},
			},
		},
		{
			displayName: "Streaming",
			name: "streaming",
			type: "boolean",
			default: false,
			description:
				"SDK 스트리밍 경로를 사용합니다. 현재 n8n 실행 UI가 실시간 청크 표시를 지원하면 응답이 진행 중에 바로 보이고, 그렇지 않으면 내부적으로만 스트리밍한 뒤 마지막에 한 번에 반환합니다.",
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
			default: true,
			description:
				"최종 응답을 JSON으로 파싱해 parsed 결과와 함께 반환합니다.",
		},
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
	];
}

exports.CodexAgentTool = CodexAgentTool;
