"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexCliApi = void 0;

class CodexCliApi {
	name = "codexCliApi";

	displayName = "Codex CLI";

	documentationUrl = "https://developers.openai.com/codex/auth";

	properties = [
		{
			displayName: "Authentication Mode",
			name: "authMode",
			type: "options",
			default: "saved",
			description: "Use stored Codex auth or inject an API key for workflow runs",
			options: [
				{
					name: "Saved CLI Auth",
					value: "saved",
					description:
						"Use the auth already stored in the selected CODEX_HOME directory",
				},
				{
					name: "API Key",
					value: "apiKey",
					description:
						"Inject an API key for exec/review and optionally persist it with Auth > Login with API Key",
				},
			],
		},
		{
			displayName: "API Key",
			name: "apiKey",
			type: "string",
			typeOptions: {
				password: true,
			},
			default: "",
			displayOptions: {
				show: {
					authMode: ["apiKey"],
				},
			},
			description: "OpenAI API key used for Codex automation",
		},
		{
			displayName: "Base URL",
			name: "baseUrl",
			type: "string",
			default: "",
			description:
				"Optional Codex/OpenAI base URL override. Leave empty for the default service",
		},
		{
			displayName: "CA Bundle Path",
			name: "caCertificatePath",
			type: "string",
			default: "",
			description:
				"Optional PEM bundle path passed as CODEX_CA_CERTIFICATE for corporate/private CAs",
		},
		{
			displayName: "Codex Executable Path",
			name: "codexExecutable",
			type: "string",
			default: "",
			description:
				"Optional absolute path to the Codex CLI executable, for example codex, codex.exe, or codex.cmd. Leave empty to auto-detect it",
		},
	];
}

exports.CodexCliApi = CodexCliApi;
