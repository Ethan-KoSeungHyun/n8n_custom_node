"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexMemory = void 0;

const { NodeConnectionTypes, NodeOperationError } = require("n8n-workflow");
const { queryMemories, buildMemoryPromptSection } = require("./store/codex-memory-store");

class CodexMemory {
	description = {
		displayName: "Codex Memory",
		name: "codexMemory",
		icon: { light: "file:codex.svg", dark: "file:codex.svg" },
		group: ["transform"],
		version: 1,
		description: "Codex Agent의 세션 바인딩 및 transcript 미러 메모리를 관리합니다.",
		defaults: {
			name: "Codex Memory",
			color: "#404040",
		},
		codex: {
			categories: ["AI"],
			subcategories: {
				AI: ["Memory"],
			},
			resources: {
				primaryDocumentation: [
					{
						url: "https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.memorymanager/",
					},
				],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiMemory],
		outputNames: ["Memory"],
		properties: [
			{
				displayName:
					"Codex Memory는 n8n Simple Memory와 다릅니다. sessionId → threadId 연속성을 관리하고, 새 thread 시작 시 최근 대화를 미러링하여 warm start를 지원합니다.",
				name: "memoryNotice",
				type: "notice",
				default: "",
			},
			{
				displayName: "Session ID Source",
				name: "sessionIdType",
				type: "options",
				default: "fromInput",
				options: [
					{
						name: "Connected Chat Trigger / Input",
						value: "fromInput",
					},
					{
						name: "Define Below",
						value: "customKey",
					},
				],
			},
			{
				displayName: "Session Key From Previous Node",
				name: "sessionKey",
				type: "string",
				default: "={{ $json.sessionId }}",
				description:
					"보통 Chat Trigger 또는 입력 데이터의 안정적인 세션 필드에서 가져옵니다.",
				displayOptions: {
					show: {
						sessionIdType: ["fromInput"],
					},
				},
			},
			{
				displayName: "Key",
				name: "sessionKey",
				type: "string",
				default: "",
				description:
					"입력 데이터에서 세션 ID를 받지 않을 때 사용할 고정 세션 ID입니다.",
				displayOptions: {
					show: {
						sessionIdType: ["customKey"],
					},
				},
			},
			{
				displayName: "Mirror Transcript",
				name: "mirrorTranscript",
				type: "boolean",
				default: true,
				description:
					"최근 프롬프트/응답 쌍을 Codex run 테이블에 저장합니다. 분석 및 새 thread warm start에 사용됩니다.",
			},
			{
				displayName: "Context Window Length",
				name: "contextWindowLength",
				type: "number",
				default: 5,
				description:
					"기존 세션에서 새 thread가 생성될 때 포함할 이전 대화 턴 수입니다.",
			},
			{
				displayName: "Enable Persistent Memory",
				name: "enablePersistentMemory",
				type: "boolean",
				default: false,
				description:
					"활성화하면 codex_agent_memories 테이블의 저장된 메모리를 프롬프트에 자동 주입합니다. 메모리는 평가·갱신·병합·삭제가 가능한 자산으로 관리됩니다.",
			},
			{
				displayName: "Memory Scope",
				name: "memoryScope",
				type: "options",
				default: "session",
				description:
					"어떤 범위의 메모리를 가져올지 선택합니다.",
				options: [
					{ name: "Session (현재 세션만)", value: "session" },
					{ name: "Agent (에이전트 전체)", value: "agent" },
					{ name: "Project (프로젝트 전체)", value: "project" },
					{ name: "User (사용자 전체)", value: "user" },
				],
				displayOptions: {
					show: { enablePersistentMemory: [true] },
				},
			},
			{
				displayName: "Memory Category Filter",
				name: "memoryCategoryFilter",
				type: "options",
				default: "",
				description:
					"특정 카테고리 메모리만 가져옵니다. 비어있으면 전체를 가져옵니다.",
				options: [
					{ name: "All (전체)", value: "" },
					{ name: "Fact (사실)", value: "fact" },
					{ name: "Preference (선호)", value: "preference" },
					{ name: "Instruction (지시)", value: "instruction" },
					{ name: "Context (문맥)", value: "context" },
				],
				displayOptions: {
					show: { enablePersistentMemory: [true] },
				},
			},
			{
				displayName: "Min Relevance Score",
				name: "minRelevanceScore",
				type: "number",
				default: 0.3,
				description:
					"이 점수 이상인 메모리만 프롬프트에 포함합니다 (0~1 범위).",
				displayOptions: {
					show: { enablePersistentMemory: [true] },
				},
			},
			{
				displayName: "Auto Save Memories",
				name: "autoSaveMemories",
				type: "boolean",
				default: true,
				description:
					"에이전트 응답에서 메모리 갱신 의도를 감지하면 자동으로 저장합니다.",
				displayOptions: {
					show: { enablePersistentMemory: [true] },
				},
			},
		],
	};

	async supplyData(itemIndex) {
		const sessionId = resolveSessionId(this, itemIndex);
		const enablePersistent = this.getNodeParameter(
			"enablePersistentMemory",
			itemIndex,
			false,
		);

		let persistentMemory = null;
		let memoryPromptSection = "";

		if (enablePersistent) {
			const scope = this.getNodeParameter("memoryScope", itemIndex, "session");
			const category = this.getNodeParameter("memoryCategoryFilter", itemIndex, "");
			const minRelevance = this.getNodeParameter("minRelevanceScore", itemIndex, 0.3);

			const filters = {
				scope,
				sessionId: scope === "session" ? sessionId : undefined,
				category: category || undefined,
				minRelevance,
			};

			try {
				persistentMemory = await queryMemories(filters);
				memoryPromptSection = await buildMemoryPromptSection(filters);
			} catch (e) {
				console.warn("[codex-memory] Persistent memory 조회 실패 (빈 메모리로 계속):", e.message);
				persistentMemory = [];
				memoryPromptSection = "";
			}
		}

		// Logging bridge: supplyData 컨텍스트의 addInputData/addOutputData를
		// 클로저로 캡처하여 Agent 실행 중 SDK 이벤트를 n8n Logs 트리에 기록합니다.
		// N8nNonEstimatingTracing (빌트인 LLM 노드)과 동일한 패턴입니다.
		const connectionType = NodeConnectionTypes.AiMemory;
		const supplyCtx = this;

		const loggingBridge = {
			logToolStart: (toolData) => {
				try {
					const { index } = supplyCtx.addInputData(
						connectionType,
						[[{ json: toolData }]],
					);
					return index;
				} catch (_e) {
					return -1;
				}
			},
			logToolEnd: (runIndex, resultData) => {
				try {
					if (runIndex < 0) return;
					supplyCtx.addOutputData(
						connectionType,
						runIndex,
						[[{ json: resultData }]],
					);
				} catch (_e) {
					// Bridge logging must never break execution
				}
			},
			logError: (runIndex, error) => {
				try {
					if (runIndex < 0) return;
					supplyCtx.addOutputData(
						connectionType,
						runIndex,
						[[{ json: { error: String(error?.message || error) } }]],
					);
				} catch (_e) {
					// Bridge logging must never break execution
				}
			},
		};
		return {
			response: {
				__codexMemory: true,
				sessionId,
				mirrorTranscript: this.getNodeParameter(
					"mirrorTranscript",
					itemIndex,
					true,
				),
				contextWindowLength: this.getNodeParameter(
					"contextWindowLength",
					itemIndex,
					5,
				),
				enablePersistentMemory: enablePersistent,
				memoryScope: enablePersistent
					? this.getNodeParameter("memoryScope", itemIndex, "session")
					: "session",
				persistentMemory,
				memoryPromptSection,
				autoSaveMemories: enablePersistent
					? this.getNodeParameter("autoSaveMemories", itemIndex, true)
					: false,
				loggingBridge,
			},
		};
	}

	async execute() {
		const inputData = this.getInputData();
		return [
			inputData.map((_, itemIndex) => ({
				json: {
					success: true,
					sessionId: resolveSessionId(this, itemIndex),
					mirrorTranscript: this.getNodeParameter(
						"mirrorTranscript",
						itemIndex,
						true,
					),
				},
				pairedItem: { item: itemIndex },
			})),
		];
	}
}

function resolveSessionId(context, itemIndex) {
	const sessionIdType = context.getNodeParameter(
		"sessionIdType",
		itemIndex,
		"fromInput",
	);

	if (sessionIdType === "customKey") {
		const sessionId = context.getNodeParameter("sessionKey", itemIndex, "");
		if (!sessionId) {
			throw new NodeOperationError(context.getNode(), "Session ID is empty", {
				itemIndex,
			});
		}
		return String(sessionId);
	}

	const sessionId = context.evaluateExpression("{{ $json.sessionId }}", itemIndex);
	if (!sessionId) {
		const fallback = context.getNodeParameter("sessionKey", itemIndex, "");
		if (!fallback) {
			throw new NodeOperationError(context.getNode(), "No session ID found", {
				description:
					"Expected to find a sessionId field in the incoming item. If you are not using a Chat Trigger, switch the Session ID Source to 'Define Below'.",
				itemIndex,
			});
		}
		return String(fallback);
	}

	return String(sessionId);
}

exports.CodexMemory = CodexMemory;
