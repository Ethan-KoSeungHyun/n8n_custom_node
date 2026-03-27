"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexMemory = void 0;

const { NodeConnectionTypes, NodeOperationError } = require("n8n-workflow");

class CodexMemory {
	description = {
		displayName: "Codex Memory",
		name: "codexMemory",
		icon: { light: "file:codex.svg", dark: "file:codex.svg" },
		group: ["transform"],
		version: 1,
		description: "Codex session binding and transcript mirror memory for Codex Agent",
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
					"Codex Memory is not the same as n8n Simple Memory. It manages sessionId -> threadId continuity for Codex and can mirror recent transcripts for warm starts.",
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
					"Usually this should come from a Chat Trigger or another stable session field in the incoming item",
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
					"The fixed session ID to use when you are not getting one from incoming data",
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
					"Store recent prompt/response pairs in the Codex run tables for analytics and new-thread warm starts",
			},
			{
				displayName: "Context Window Length",
				name: "contextWindowLength",
				type: "number",
				default: 5,
				description:
					"How many previous turns to expose when a new thread is created for an existing session",
			},
		],
	};

	async supplyData(itemIndex) {
		const sessionId = resolveSessionId(this, itemIndex);
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
