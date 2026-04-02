"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexApi = void 0;

class CodexApi {
	name = "codexApi";

	displayName = "Codex";

	documentationUrl = "https://developers.openai.com/codex/auth";

	properties = [
		{
			displayName: "Authentication Mode",
			name: "authMode",
			type: "options",
			default: "saved",
			description: "Use saved Codex auth or inject an API key for workflow runs",
			options: [
				{
					name: "Saved Codex Auth",
					value: "saved",
					description:
						"Use the auth already stored in the selected CODEX_HOME directory",
				},
				{
					name: "API Key",
					value: "apiKey",
					description:
						"Inject an API key for SDK-based Codex runs without relying on saved auth",
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
			displayName: "Codex Executable Path (Optional)",
			name: "codexExecutable",
			type: "string",
			default: "",
			description:
				"Optional absolute path to the Codex binary used by the SDK. Leave empty to use the bundled platform binary",
		},
	];
}

exports.CodexApi = CodexApi;
