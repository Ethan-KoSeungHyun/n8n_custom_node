"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexAgent = void 0;

const { NodeConnectionTypes, NodeOperationError } = require("n8n-workflow");
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
	resolvePromptValue,
	resolveSessionIdField,
	toConnectionArray,
} = require("./lib/node-runtime-helpers");
const {
	addCodexExecutionHints,
	createCodexUiHooks,
	emitCodexResultToUi,
} = require("./lib/node-ui-helpers");

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
		credentials: [{ name: "codexChatgptAccount", required: true }],
		properties: [
			{
				displayName:
					'워크플로마다 실제 ChatGPT 로그인 주체를 분리하려면 <strong>Codex ChatGPT Account</strong> credential을 선택하세요.',
				name: "credentialModeNotice",
				type: "notice",
				default: "",
			},
			{
				displayName:
					'채팅 워크플로에서는 <strong>Session Strategy = Auto Resume</strong>, <strong>Session ID = {{$json.sessionId}}</strong> 구성을 권장합니다.',
				name: "recommendedSetupNotice",
				type: "notice",
				default: "",
			},
			{
				displayName:
					"Codex Agent는 SDK 기반의 메인 대화형 노드입니다. 세션 연속성이 필요하면 Codex Memory를 연결하고, MCP 서버를 쓰려면 Codex MCP Toolset을 연결하세요.",
				name: "memoryAndToolNotice",
				type: "notice",
				default: "",
			},
			{
				displayName:
					'`n8n chat`에서 실시간 스트리밍을 보려면 앞단 `When chat message received` 트리거에서 <strong>Response Mode = Streaming</strong>을 사용해야 합니다. `Last Node` 또는 `Response Nodes` 모드에서는 내부적으로 스트리밍하더라도 UI에는 최종 결과만 보입니다.',
				name: "streamingModeNotice",
				type: "notice",
				default: "",
			},
			{
				displayName: "Prompt",
				name: "prompt",
				type: "string",
				typeOptions: { rows: 6 },
				default:
					"={{ $json.chatInput || $json.prompt || $json.text || $json.message || $json.query || $json.input || '' }}",
				required: true,
				description: "Codex에 전달할 메인 요청 또는 작업 내용입니다.",
			},
			{
				displayName: "System Instructions",
				name: "systemInstructions",
				type: "string",
				typeOptions: { rows: 4 },
				default: "",
				description:
					"Prompt 앞에 항상 붙는 추가 지침입니다. 응답 스타일, 작업 범위, 금지 사항 등을 넣을 때 사용합니다.",
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
				default: "autoResume",
				options: [
					{ name: "Auto Resume", value: "autoResume" },
					{ name: "Always New", value: "alwaysNew" },
					{ name: "Specific Thread ID", value: "specificThreadId" },
					{ name: "Last Thread", value: "lastThread" },
				],
				description:
					"채팅형 워크플로에서는 같은 세션을 이어가기 쉽도록 Auto Resume을 권장합니다.",
			},
			{
				displayName: "Session ID",
				name: "sessionId",
				type: "string",
				default: "={{ $json.sessionId }}",
				description:
					"채팅 또는 사용자 세션을 구분하는 고정 키입니다. Auto Resume일 때 저장된 Codex thread와 자동으로 연결됩니다.",
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
				const uiState = createCodexUiHooks(this, itemIndex, options);
				const toolsets = await getConnectedCodexToolsets(this);
				const mcpConfigured = describeConfiguredMcpToolsets(toolsets);
				const memory = await getConnectedCodexMemory(this);
				assertSavedMcpServerConfig(toolsets, base.codexHome);
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
				const prompt = resolvePromptValue(
					this.getNodeParameter("prompt", itemIndex, ""),
					items[itemIndex]?.json,
				);

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
					prompt,
					systemInstructions: this.getNodeParameter(
						"systemInstructions",
						itemIndex,
						"",
					),
					model: resolveModelField(this, itemIndex),
					options,
					sessionStrategy,
					sessionId,
					threadId,
					resumeLast: sessionStrategy === "lastThread",
					memory,
					mcpConfigured,
					codexConfig: buildCodexMcpConfig(toolsets, base.codexHome),
					hooks: uiState.hooks,
				});
				emitCodexResultToUi(this, result);
				addCodexExecutionHints(
					this,
					options,
					result,
					uiState.liveStreamingEnabled,
				);

				returnData.push({
						json: {
							resource: "agent",
							operation: "exec",
							credentialType: base.credentialType,
							credentialId: base.credentialRef?.id || null,
							credentialName: base.credentialRef?.name || null,
							profileKey: base.profileKey || null,
							authFingerprint: base.authFingerprint || null,
							codexHome: base.codexHome || null,
							workingDirectory: base.workingDirectory,
							ignoredToolCount,
						streamingRequested: Boolean(options.streaming),
						liveStreamingActive: uiState.liveStreamingEnabled,
						chatResponseMode: uiState.chatResponseMode,
						liveStreamingReason: uiState.liveStreamingReason,
						eventsIncludedInOutput: Boolean(options.includeEvents),
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
				"Codex가 파일을 읽기만 할지, 워크스페이스 안에서 쓰기까지 할지, 더 넓은 시스템 접근을 허용할지 정합니다.",
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
				"민감한 작업 전에 언제 멈추고 사용자 승인을 요청할지 정합니다.",
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
				"실행 중 웹 검색을 사용할 수 있는지 정합니다.",
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
			displayName: "Ephemeral",
			name: "ephemeral",
			type: "boolean",
			default: false,
			description:
				"가능한 경우, 지속 상태를 재사용하는 대신 일회성 격리 실행을 사용합니다.",
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
			default: false,
			description:
				"최종 응답을 JSON으로 파싱해 parsedFinalResponse에 함께 반환합니다.",
		},
		{
			displayName: "Output Schema JSON",
			name: "outputSchemaJson",
			type: "string",
			typeOptions: { rows: 6 },
			default: "",
			description:
				"Codex에게 구조화된 최종 응답을 요청할 때 사용하는 선택형 JSON Schema입니다.",
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

exports.CodexAgent = CodexAgent;
