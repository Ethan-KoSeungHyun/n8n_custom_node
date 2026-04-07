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
				'연결 환경을 선택한 뒤 <strong>Connect</strong>를 누르세요.<br>• <strong>로컬 (개발용)</strong>: Mac/로컬 서버에서 직접 테스트할 때 사용합니다.<br>• <strong>프로덕션</strong>: 실제 배포 서버(seunghyun.space)로 연결합니다.',
			name: "connectNotice",
			type: "notice",
			default: "",
		},
		{
			displayName: "연결 환경",
			name: "bridgeEnvironment",
			type: "options",
			default: "local",
			noDataExpression: true,
			options: [
				{
					name: "로컬 (개발용) — http://localhost:3481",
					value: "local",
				},
				{
					name: "프로덕션 — codex-bridge.seunghyun.space",
					value: "remote",
				},
			],
			description:
				"로컬 테스트는 '로컬'을, 실서버 배포 환경은 '프로덕션'을 선택하세요.",
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
			displayName: "Local Bridge URL",
			name: "bridgeBaseUrl",
			type: "string",
			default: "http://localhost:3481",
			displayOptions: {
				show: {
					showAdvancedSettings: [true],
					bridgeEnvironment: ["local"],
				},
			},
			description:
				"로컬 Codex 인증 bridge 주소입니다. 별도 포트나 주소를 쓰는 경우가 아니면 기본값을 그대로 두세요.",
		},
		{
			displayName: "Production Bridge URL",
			name: "remoteBridgeUrl",
			type: "string",
			default: "https://codex-bridge.seunghyun.space",
			displayOptions: {
				show: {
					showAdvancedSettings: [true],
					bridgeEnvironment: ["remote"],
				},
			},
			description:
				"프로덕션 Codex 인증 bridge 주소입니다. 배포 도메인이 바뀐 경우에만 수정하세요.",
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
				'={{($self["bridgeEnvironment"] === "remote" ? ($self["remoteBridgeUrl"] || $env.CODEX_AUTH_BRIDGE_BASE_URL || "https://codex-bridge.seunghyun.space") : ($self["bridgeBaseUrl"] || ("http://localhost:" + ($env.CODEX_AUTH_BRIDGE_PORT || "3481")))).replace(/\\/$/, "") + "/oauth/authorize"}}',
		},
		{
			displayName: "Access Token URL",
			name: "accessTokenUrl",
			type: "hidden",
			required: true,
			default:
				'={{($self["bridgeEnvironment"] === "remote" ? ($self["remoteBridgeUrl"] || $env.CODEX_AUTH_BRIDGE_BASE_URL || "https://codex-bridge.seunghyun.space") : ($self["bridgeBaseUrl"] || ("http://localhost:" + ($env.CODEX_AUTH_BRIDGE_PORT || "3481")))).replace(/\\/$/, "") + "/oauth/token"}}',
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
				'={{($credentials.bridgeEnvironment === "remote" ? ($credentials.remoteBridgeUrl || $env.CODEX_AUTH_BRIDGE_BASE_URL || "https://codex-bridge.seunghyun.space") : ($credentials.bridgeBaseUrl || ("http://localhost:" + ($env.CODEX_AUTH_BRIDGE_PORT || "3481")))).replace(/\\/$/, "")}}',
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
