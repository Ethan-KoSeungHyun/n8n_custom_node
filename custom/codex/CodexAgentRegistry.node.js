"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexAgentRegistry = void 0;

const { NodeConnectionTypes, NodeOperationError } = require("n8n-workflow");
const {
	registerAgent,
	getAgentByKey,
	updateAgent,
	deleteAgent,
	listAgents,
	lookupByCapability,
} = require("./store/codex-agent-registry-store");

class CodexAgentRegistry {
	description = {
		displayName: "Codex Agent Registry",
		name: "codexAgentRegistry",
		icon: { light: "file:codex.svg", dark: "file:codex.svg" },
		group: ["transform"],
		version: 1,
		description:
			"에이전트 프로필을 등록·조회·갱신·삭제합니다. 오케스트레이터가 적합한 에이전트를 선택할 때 사용합니다.",
		defaults: {
			name: "Codex Agent Registry",
			color: "#404040",
		},
		codex: {
			categories: ["AI"],
			subcategories: { AI: ["Agents"] },
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		properties: [
			{
				displayName: "Operation",
				name: "operation",
				type: "options",
				default: "list",
				noDataExpression: true,
				options: [
					{ name: "Register", value: "register" },
					{ name: "Get", value: "get" },
					{ name: "Update", value: "update" },
					{ name: "Delete", value: "delete" },
					{ name: "List", value: "list" },
					{ name: "Lookup (by Capability)", value: "lookup" },
				],
			},
			{
				displayName: "Agent Key",
				name: "agentKey",
				type: "string",
				default: "",
				required: true,
				description: "에이전트 고유 식별자 (예: code-reviewer, test-writer)",
				displayOptions: {
					show: { operation: ["register", "get", "update", "delete"] },
				},
			},
			{
				displayName: "Display Name",
				name: "displayName",
				type: "string",
				default: "",
				description: "사람이 읽을 수 있는 에이전트 이름",
				displayOptions: {
					show: { operation: ["register", "update"] },
				},
			},
			{
				displayName: "Description",
				name: "description",
				type: "string",
				typeOptions: { rows: 3 },
				default: "",
				description: "에이전트의 역할과 전문 분야를 설명합니다. 오케스트레이터가 적합한 에이전트를 선택하는 데 사용됩니다.",
				displayOptions: {
					show: { operation: ["register", "update"] },
				},
			},
			{
				displayName: "Capabilities (comma separated)",
				name: "capabilities",
				type: "string",
				default: "",
				description: "이 에이전트가 수행할 수 있는 기능 목록 (예: code-review, testing, documentation)",
				displayOptions: {
					show: { operation: ["register", "update"] },
				},
			},
			{
				displayName: "Default Model",
				name: "defaultModel",
				type: "string",
				default: "gpt-5.4-mini",
				description: "이 에이전트가 기본으로 사용할 모델입니다. AgentTool에서 프로필을 로드하면 자동 적용됩니다.",
				displayOptions: {
					show: { operation: ["register", "update"] },
				},
			},
			{
				displayName: "Default System Instructions",
				name: "defaultSystemInstructions",
				type: "string",
				typeOptions: { rows: 5 },
				default: "",
				description: "에이전트의 기본 시스템 지침입니다. AgentTool에서 프로필 로드 시 노드·호출 수준 지침과 병합됩니다.",
				displayOptions: {
					show: { operation: ["register", "update"] },
				},
			},
			{
				displayName: "Default Sandbox",
				name: "defaultSandbox",
				type: "options",
				default: "workspace-write",
				description: "에이전트의 기본 샌드박스 모드입니다. 파일 시스템 접근 범위를 제한합니다.",
				options: [
					{ name: "Read Only", value: "read-only" },
					{ name: "Workspace Write", value: "workspace-write" },
					{ name: "Danger Full Access", value: "danger-full-access" },
				],
				displayOptions: {
					show: { operation: ["register", "update"] },
				},
			},
			{
				displayName: "Memory Scope",
				name: "memoryScope",
				type: "options",
				default: "agent",
				description: "Persistent Memory 사용 시 이 에이전트의 기본 메모리 범위입니다.",
				options: [
					{ name: "Session", value: "session" },
					{ name: "Agent", value: "agent" },
					{ name: "Project", value: "project" },
					{ name: "User", value: "user" },
				],
				displayOptions: {
					show: { operation: ["register", "update"] },
				},
			},
			{
				displayName: "Priority",
				name: "priority",
				type: "number",
				default: 0,
				description: "높을수록 우선 선택됩니다.",
				displayOptions: {
					show: { operation: ["register", "update"] },
				},
			},
			{
				displayName: "Enabled",
				name: "enabled",
				type: "boolean",
				default: true,
				description: "비활성화하면 Lookup 결과에서 제외되지만 레지스트리에는 남아 있습니다.",
				displayOptions: {
					show: { operation: ["register", "update"] },
				},
			},
			{
				displayName: "Capability Query",
				name: "capabilityQuery",
				type: "string",
				default: "",
				description: "이 기능을 수행할 수 있는 에이전트를 검색합니다.",
				displayOptions: {
					show: { operation: ["lookup"] },
				},
			},
			{
				displayName: "Only Enabled",
				name: "onlyEnabled",
				type: "boolean",
				default: true,
				description: "활성화된 에이전트만 목록에 표시합니다.",
				displayOptions: {
					show: { operation: ["list"] },
				},
			},
		],
	};

	async execute() {
		const items = this.getInputData();
		const returnData = [];

		for (let i = 0; i < items.length; i++) {
			const operation = this.getNodeParameter("operation", i, "list");
			try {
				let result;

				switch (operation) {
					case "register": {
						const caps = String(
							this.getNodeParameter("capabilities", i, ""),
						)
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
						result = await registerAgent({
							agentKey: this.getNodeParameter("agentKey", i, ""),
							displayName: this.getNodeParameter("displayName", i, ""),
							description: this.getNodeParameter("description", i, ""),
							capabilities: caps,
							defaultModel: this.getNodeParameter("defaultModel", i, ""),
							defaultSystemInstructions: this.getNodeParameter(
								"defaultSystemInstructions",
								i,
								"",
							),
							defaultSandbox: this.getNodeParameter("defaultSandbox", i, "workspace-write"),
							memoryScope: this.getNodeParameter("memoryScope", i, "agent"),
							priority: this.getNodeParameter("priority", i, 0),
							enabled: this.getNodeParameter("enabled", i, true),
						});
						break;
					}
					case "get": {
						const key = this.getNodeParameter("agentKey", i, "");
						result = await getAgentByKey(key);
						if (!result) {
							throw new NodeOperationError(
								this.getNode(),
								`Agent '${key}' not found`,
								{ itemIndex: i },
							);
						}
						break;
					}
					case "update": {
						const key = this.getNodeParameter("agentKey", i, "");
						const patch = {};
						const dn = this.getNodeParameter("displayName", i, "");
						if (dn) patch.displayName = dn;
						const desc = this.getNodeParameter("description", i, "");
						if (desc) patch.description = desc;
						const caps = String(this.getNodeParameter("capabilities", i, ""))
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
						if (caps.length) patch.capabilities = caps;
						const model = this.getNodeParameter("defaultModel", i, "");
						if (model) patch.defaultModel = model;
						const si = this.getNodeParameter("defaultSystemInstructions", i, "");
						if (si) patch.defaultSystemInstructions = si;
						patch.defaultSandbox = this.getNodeParameter("defaultSandbox", i, "workspace-write");
						patch.memoryScope = this.getNodeParameter("memoryScope", i, "agent");
						patch.priority = this.getNodeParameter("priority", i, 0);
						patch.enabled = this.getNodeParameter("enabled", i, true);
						result = await updateAgent(key, patch);
						break;
					}
					case "delete": {
						const key = this.getNodeParameter("agentKey", i, "");
						await deleteAgent(key);
						result = { deleted: true, agentKey: key };
						break;
					}
					case "list": {
						const onlyEnabled = this.getNodeParameter("onlyEnabled", i, true);
						result = await listAgents(
							onlyEnabled ? { enabled: true } : {},
						);
						break;
					}
					case "lookup": {
						const query = this.getNodeParameter("capabilityQuery", i, "");
						result = await lookupByCapability(query);
						break;
					}
					default:
						throw new NodeOperationError(
							this.getNode(),
							`Unknown operation: ${operation}`,
						);
				}

				const outputItems = Array.isArray(result)
					? result.map((r) => ({ json: r }))
					: [{ json: result || {} }];
				returnData.push(...outputItems);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: error.message },
						pairedItem: { item: i },
					});
				} else {
					throw error;
				}
			}
		}
		return [returnData];
	}
}

exports.CodexAgentRegistry = CodexAgentRegistry;
