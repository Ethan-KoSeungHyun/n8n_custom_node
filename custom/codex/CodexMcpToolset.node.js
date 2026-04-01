"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexMcpToolset = void 0;

const { NodeConnectionTypes, NodeOperationError } = require("n8n-workflow");
const { parseOptionalJsonArray, parseOptionalJsonObject } = require("./lib/codex-cli");
const { parseDelimitedPaths } = require("./lib/node-runtime-helpers");

const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

class CodexMcpToolset {
	description = {
		displayName: "Codex MCP Toolset",
		name: "codexMcpToolset",
		icon: { light: "file:codex.svg", dark: "file:codex.svg" },
		group: ["transform"],
		version: 1,
		description: "Provide Codex-specific MCP server configuration to Codex Agent",
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
				displayName: "Server Name",
				name: "serverName",
				type: "string",
				default: "",
				required: true,
			},
			{
				displayName: "Server Source",
				name: "serverSource",
				type: "options",
				default: "saved",
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
			},
			{
				displayName: "Timeout (Seconds)",
				name: "timeout",
				type: "number",
				default: 120,
			},
			{
				displayName: "Include Tools",
				name: "includeTools",
				type: "string",
				typeOptions: { rows: 3 },
				default: "",
				description: "Comma or newline separated list of MCP tools to prefer",
			},
			{
				displayName: "Exclude Tools",
				name: "excludeTools",
				type: "string",
				typeOptions: { rows: 3 },
				default: "",
				description: "Comma or newline separated list of MCP tools to avoid",
			},
			{
				displayName: "Server URL",
				name: "serverUrl",
				type: "string",
				default: "",
				required: true,
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
