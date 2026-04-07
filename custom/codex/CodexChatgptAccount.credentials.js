"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexChatgptAccount = void 0;

const { startAuthBridgeInBackground } = require("./lib/codex-auth-bridge");

startAuthBridgeInBackground();

class CodexChatgptAccount {
	name = "codexChatgptAccount";

	extends = ["oAuth2Api"];

	displayName = "Codex ChatGPT Account";

	icon = { light: "file:codex.svg", dark: "file:codex.svg" };

	documentationUrl = "https://developers.openai.com/codex/auth";

	properties = [
		{
			displayName:
				'<strong>Connect</strong>를 누르면 Codex 계정 연결 창이 열립니다. 먼저 <strong>Device Code로 연결</strong>을 사용하고, 그 방식이 깔끔하게 끝나지 않을 때만 같은 창에서 <strong>서버 브라우저에서 연결 (Admin)</strong>을 사용하세요.',
			name: "connectNotice",
			type: "notice",
			default: "",
		},
		{
			displayName: "Codex ID",
			name: "codexId",
			type: "string",
			default: "",
			placeholder: "연결 후 자동으로 채워집니다",
			description: "현재 연결된 Codex 계정입니다.",
			noDataExpression: true,
			disabledOptions: {
				show: {
					codexIdReadonly: [true],
				},
			},
		},
		{
			displayName: "Codex ID Readonly",
			name: "codexIdReadonly",
			type: "hidden",
			default: true,
		},
		{
			displayName: "Advanced Settings",
			name: "showAdvancedSettings",
			type: "boolean",
			default: false,
			description:
				"브리지 주소나 Codex 실행 파일 경로를 직접 바꿔야 할 때만 켜세요.",
		},
		{
			displayName: "Bridge Base URL",
			name: "bridgeBaseUrl",
			type: "string",
			default: "http://127.0.0.1:3481",
			displayOptions: {
				show: {
					showAdvancedSettings: [true],
				},
			},
			description:
				"로컬 Codex 인증 bridge 주소입니다. 별도 포트나 주소를 쓰는 경우가 아니면 기본값을 그대로 두세요.",
		},
		{
			displayName: "Base URL",
			name: "baseUrl",
			type: "string",
			default: "",
			displayOptions: {
				show: {
					showAdvancedSettings: [true],
				},
			},
			description:
				"기본 OpenAI Codex 주소 대신 다른 호환 endpoint를 써야 할 때만 입력하세요. 보통은 비워 둡니다.",
		},
		{
			displayName: "Codex Executable Path (Optional)",
			name: "codexExecutable",
			type: "string",
			default: "",
			displayOptions: {
				show: {
					showAdvancedSettings: [true],
				},
			},
			description:
				"Codex CLI 경로를 직접 지정해야 할 때만 입력하세요. 보통은 비워 둡니다.",
		},
		{
			displayName: "Grant Type",
			name: "grantType",
			type: "hidden",
			default: "authorizationCode",
		},
		{
			displayName: "Authorization URL",
			name: "authUrl",
			type: "hidden",
			required: true,
			default:
				'={{($self["bridgeBaseUrl"] || $env.CODEX_AUTH_BRIDGE_BASE_URL || ("http://127.0.0.1:" + ($env.CODEX_AUTH_BRIDGE_PORT || "3481"))).replace(/\\/$/, "") + "/oauth/authorize"}}',
		},
		{
			displayName: "Access Token URL",
			name: "accessTokenUrl",
			type: "hidden",
			required: true,
			default:
				'={{($self["bridgeBaseUrl"] || $env.CODEX_AUTH_BRIDGE_BASE_URL || ("http://127.0.0.1:" + ($env.CODEX_AUTH_BRIDGE_PORT || "3481"))).replace(/\\/$/, "") + "/oauth/token"}}',
		},
		{
			displayName: "Client ID",
			name: "clientId",
			type: "hidden",
			required: true,
			default: "codex-local-client",
		},
		{
			displayName: "Client Secret",
			name: "clientSecret",
			type: "hidden",
			required: true,
			typeOptions: {
				password: true,
			},
			default: "codex-local-secret",
		},
		{
			displayName: "Scope",
			name: "scope",
			type: "hidden",
			default: "openid profile email offline_access",
		},
		{
			displayName: "Auth URI Query Parameters",
			name: "authQueryParameters",
			type: "hidden",
			default:
				'={{"profileKey=" + encodeURIComponent((($self["oauthTokenData"] || {})["profile_key"]) || "") + "&codexExecutable=" + encodeURIComponent($self["codexExecutable"] || "")}}',
		},
		{
			displayName: "Authentication",
			name: "authentication",
			type: "hidden",
			default: "body",
		},
		{
			displayName: "Ignore SSL Issues (Insecure)",
			name: "ignoreSSLIssues",
			type: "hidden",
			default: false,
		},
	];

	test = {
		request: {
			baseURL:
				'={{($credentials.bridgeBaseUrl || $env.CODEX_AUTH_BRIDGE_BASE_URL || ("http://127.0.0.1:" + ($env.CODEX_AUTH_BRIDGE_PORT || "3481"))).replace(/\\/$/, "")}}',
			url:
				'={{"/oauth/status?profileKey=" + encodeURIComponent((($credentials.oauthTokenData || {})["profile_key"]) || "") + "&codexExecutable=" + encodeURIComponent($credentials.codexExecutable || "")}}',
			ignoreHttpStatusErrors: true,
		},
		rules: [
			{
				type: "responseSuccessBody",
				properties: {
					key: "status",
					value: "disconnected",
					message:
						"아직 Codex 계정이 연결되지 않았습니다. Connect를 눌러 로그인하세요.",
				},
			},
			{
				type: "responseSuccessBody",
				properties: {
					key: "status",
					value: "needs_reconnect",
					message:
						"Codex 계정을 다시 연결해야 합니다. Connect를 눌러 로그인 과정을 다시 완료하세요.",
				},
			},
		],
	};
}

exports.CodexChatgptAccount = CodexChatgptAccount;
