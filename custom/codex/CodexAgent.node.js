"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexAgent = void 0;

const { NodeConnectionTypes, NodeOperationError } = require("n8n-workflow");
const { executeAgentRun } = require("./runtime/codex-service");
const {
	assertSavedMcpServerConfig,
	buildCodexMcpConfig,
	buildModelFields,
	buildSharedOptionFields,
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
	wrapHooksWithBridge,
} = require("./lib/node-ui-helpers");

class CodexAgent {
	description = {
		displayName: "Codex Agent",
		name: "codexAgent",
		icon: { light: "file:codex.svg", dark: "file:codex.svg" },
		group: ["transform"],
		version: 1,
		description: "세션·메모리·MCP를 지원하는 SDK 기반 Codex AI 에이전트 메인 노드입니다.",
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
			...buildModelFields(),
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
			...buildSharedOptionFields({ includeOutputSchemaJson: true }),
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

				const wrappedHooks = wrapHooksWithBridge(
					uiState.hooks,
					memory?.loggingBridge || null,
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
					codexConfig: buildCodexMcpConfig(toolsets),
					hooks: wrappedHooks,
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

exports.CodexAgent = CodexAgent;
