"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexMcpToolset = void 0;

const { NodeConnectionTypes, NodeOperationError } = require("n8n-workflow");
const {
	parseOptionalJsonArray,
	parseOptionalJsonObject,
} = require("./lib/codex-utils");
const { parseDelimitedPaths } = require("./lib/node-runtime-helpers");

const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

class CodexMcpToolset {
	description = {
		displayName: "Codex MCP Toolset",
		name: "codexMcpToolset",
		icon: { light: "file:codex.svg", dark: "file:codex.svg" },
		group: ["transform"],
		version: 1,
		description: "Codex Agent에 MCP 서버 설정을 제공합니다.",
		defaults: {
			name: "Codex MCP Toolset",
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
						url: "https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/",
					},
				],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiTool],
		outputNames: ["Toolset"],
		properties: [
			{
				displayName:
					"Codex MCP Toolset은 설정 제공자이며 직접 실행하지 않습니다. 실제 MCP 호출은 Codex Agent 내부에서 수행되므로, 런타임 로그와 사용된 tool 정보는 Codex Agent 출력에서 확인하세요.",
				name: "toolsetBehaviorNotice",
				type: "notice",
				default: "",
			},
			{
				displayName: "Server Name",
				name: "serverName",
				type: "string",
				default: "",
				required: true,
				description:
					"MCP 서버 고유 이름입니다. 영문자, 숫자, 하이픈, 밑줄만 사용할 수 있습니다.",
			},
			{
				displayName: "Server Source",
				name: "serverSource",
				type: "options",
				default: "saved",
				description:
					"MCP 서버 설정 출처를 선택합니다. Saved는 CODEX_HOME config.toml에 등록된 서버, Inline은 이 노드에서 직접 정의합니다.",
				options: [
					{ name: "Saved CODEX_HOME Server", value: "saved" },
					{ name: "Inline HTTP Server", value: "http" },
					{ name: "Inline stdio Server", value: "stdio" },
				],
			},
			{
				displayName: "Required",
				name: "required",
				type: "boolean",
				default: true,
				description:
					"true이면 이 MCP 서버 연결이 실패할 경우 에이전트 실행도 중단됩니다.",
			},
			{
				displayName: "Timeout (Seconds)",
				name: "timeout",
				type: "number",
				default: 120,
				description:
					"MCP 서버 시작 및 tool 호출 타임아웃(초)입니다.",
			},
			{
				displayName: "Include Tools",
				name: "includeTools",
				type: "string",
				typeOptions: { rows: 3 },
				default: "",
				description:
					"사용할 MCP tool 이름을 쉼표 또는 줄바꿈으로 구분합니다 (예: jira_get_issue). 서버 파일 경로가 아닌 tool 이름을 입력하세요.",
			},
			{
				displayName: "Exclude Tools",
				name: "excludeTools",
				type: "string",
				typeOptions: { rows: 3 },
				default: "",
				description:
					"제외할 MCP tool 이름을 쉼표 또는 줄바꿈으로 구분합니다 (예: jira_transition_issue).",
			},
			{
				displayName: "Server URL",
				name: "serverUrl",
				type: "string",
				default: "",
				required: true,
				description:
					"HTTP MCP 서버의 streamable-http 엔드포인트 URL입니다.",
				displayOptions: {
					show: {
						serverSource: ["http"],
					},
				},
			},
			{
				displayName: "Bearer Token Env Var",
				name: "bearerTokenEnvVar",
				type: "string",
				default: "",
				description:
					"Bearer 토큰이 저장된 환경변수 이름입니다. 인증이 필요 없으면 비워 두세요.",
				displayOptions: {
					show: {
						serverSource: ["http"],
					},
				},
			},
			{
				displayName: "Command",
				name: "stdioCommand",
				type: "string",
				default: "",
				required: true,
				description:
					"stdio MCP 서버를 실행할 명령어입니다 (예: npx, python, node).",
				displayOptions: {
					show: {
						serverSource: ["stdio"],
					},
				},
			},
			{
				displayName: "Arguments JSON",
				name: "stdioArgsJson",
				type: "string",
				typeOptions: { rows: 4 },
				default: "",
				description:
					'명령어에 전달할 인자 배열을 JSON 형식으로 입력합니다 (예: ["-y", "@modelcontextprotocol/server-filesystem"]).',
				displayOptions: {
					show: {
						serverSource: ["stdio"],
					},
				},
			},
			{
				displayName: "Command Env JSON",
				name: "commandEnvJson",
				type: "string",
				typeOptions: { rows: 4 },
				default: "",
				description:
					'MCP 서버 프로세스에 전달할 환경변수를 JSON 객체로 입력합니다 (예: {"API_KEY": "xxx"}).',
				displayOptions: {
					show: {
						serverSource: ["stdio"],
					},
				},
			},
		],
	};

	async supplyData(itemIndex) {
		return {
			response: {
				__codexMcpToolset: true,
				servers: [buildServerConfig(this, itemIndex)],
			},
		};
	}

	async execute() {
		const inputData = this.getInputData();
		return [
			inputData.map((_, itemIndex) => ({
				json: buildServerConfig(this, itemIndex),
				pairedItem: { item: itemIndex },
			})),
		];
	}
}

function buildServerConfig(context, itemIndex) {
	const serverName = String(
		context.getNodeParameter("serverName", itemIndex),
	).trim();
	if (!serverName) {
		throw new NodeOperationError(context.getNode(), "Server Name is required", {
			itemIndex,
		});
	}
	if (!MCP_SERVER_NAME_PATTERN.test(serverName)) {
		throw new NodeOperationError(
			context.getNode(),
			`Server Name "${serverName}" is invalid. Use only letters, numbers, hyphens, and underscores.`,
			{ itemIndex },
		);
	}

	const serverSource = context.getNodeParameter("serverSource", itemIndex, "saved");
	const base = {
		serverName,
		serverSource,
		required: context.getNodeParameter("required", itemIndex, true),
		timeout: context.getNodeParameter("timeout", itemIndex, 120),
		includeTools: parseDelimitedPaths(
			context.getNodeParameter("includeTools", itemIndex, ""),
		),
		excludeTools: parseDelimitedPaths(
			context.getNodeParameter("excludeTools", itemIndex, ""),
		),
	};

	if (serverSource === "http") {
		return {
			...base,
			serverUrl: context.getNodeParameter("serverUrl", itemIndex, ""),
			bearerTokenEnvVar: context.getNodeParameter(
				"bearerTokenEnvVar",
				itemIndex,
				"",
			),
		};
	}

	if (serverSource === "stdio") {
		const stdioArgs = parseOptionalJsonArray(
			context.getNodeParameter("stdioArgsJson", itemIndex, ""),
			"Arguments JSON",
		);
		const commandEnv = parseOptionalJsonObject(
			context.getNodeParameter("commandEnvJson", itemIndex, ""),
			"Command Env JSON",
		);
		return {
			...base,
			stdioCommand: context.getNodeParameter("stdioCommand", itemIndex, ""),
			stdioArgs,
			commandEnv,
		};
	}

	return base;
}

exports.CodexMcpToolset = CodexMcpToolset;
