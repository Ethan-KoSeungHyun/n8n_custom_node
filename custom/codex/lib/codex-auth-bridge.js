"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const http = require("node:http");
const { URL, URLSearchParams } = require("node:url");
const {
	buildOauthTokenData,
	createProfileKey,
	createDisconnectedState,
	deriveProfileKeyFromIdentity,
	disconnectProfile,
	ensureProfileStructure,
	getProfileCodexHome,
	getProfileRoot,
	purgeProfileAuthCache,
	readProfileState,
	renameProfileKey,
	sanitizeProfileKey,
	spawnCodexCommand,
} = require("./codex-profile-utils");

const DEFAULT_HOST = process.env.CODEX_AUTH_BRIDGE_HOST || "localhost";
const DEFAULT_PORT = Number(process.env.CODEX_AUTH_BRIDGE_PORT || 3481);

function stripAnsi(text) {
	return String(text || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}
const SESSION_TTL_MS = 30 * 60 * 1000;
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const LOG_LINE_LIMIT = 200;

const authSessions = new Map();
const authCodes = new Map();

let serverPromise;
let cleanupStarted = false;

function getBridgeBaseUrl() {
	const configuredBaseUrl = String(
		process.env.CODEX_AUTH_BRIDGE_BASE_URL || "",
	).trim();
	if (configuredBaseUrl) {
		return configuredBaseUrl.replace(/\/$/, "");
	}

	return `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
}

function decodeN8nOauthState(encodedState) {
	try {
		const { Container } = require("@n8n/di");
		const { Cipher } = require("n8n-core");
		const cipher = Container.get(Cipher);
		const decodedState = JSON.parse(
			Buffer.from(String(encodedState || ""), "base64").toString("utf8"),
		);
		const decryptedData = JSON.parse(cipher.decrypt(decodedState.data));
		return {
			...decodedState,
			...decryptedData,
		};
	} catch {
		return null;
	}
}

function deriveCodexId(profileState, session) {
	const candidateEmail =
		String(profileState?.email || "").trim() ||
		String(session?.email || "").trim() ||
		String(profileState?.accountHint || "").trim();
	const localPart = candidateEmail.includes("@")
		? candidateEmail.split("@")[0]
		: candidateEmail;
	return sanitizeProfileKey(localPart);
}

// disconnect/purge 후 n8n credential을 OAuth callback 없이 직접 업데이트
// (OAuth state 재사용에 따른 "invalid state" 에러 방지)
async function directUpdateN8nCredential(session, { connected, status, message }) {
	const decodedState = decodeN8nOauthState(session.state);
	const credentialId = String(decodedState?.cid || "").trim();
	if (!credentialId) return;

	try {
		const { Container } = require("@n8n/di");
		const { CredentialsRepository } = require("@n8n/db");
		const { Credentials } = require("n8n-core");
		const credentialsRepository = Container.get(CredentialsRepository);
		const credential = await credentialsRepository.findOneBy({ id: credentialId });
		if (!credential || credential.type !== "codexChatgptAccount") return;

		const coreCredential = new Credentials(credential, credential.type, credential.data);
		// connected: false 시 oauthTokenData를 null로 지워야 n8n이 "Connect" 버튼을 표시함.
		// 값이 있으면 access_token이 비어있어도 n8n은 "Account connected"로 표시.
		const tokenData = connected
			? buildOauthTokenData(
					{ ...session, status, message },
					{ connected: true, status, message, lastLoginMethod: "" },
			  )
			: null;
		coreCredential.updateData({ oauthTokenData: tokenData });
		await credentialsRepository.update(credential.id, {
			...coreCredential.getDataToSave(),
			updatedAt: new Date(),
		});
		appendLog(session, `n8n credential updated directly (connected=${connected}).`);
	} catch (error) {
		appendLog(session, `Direct credential update skipped: ${error.message || String(error)}`);
	}
}

async function syncCredentialCodexIdForSession(session, profileState) {
	const decodedState = decodeN8nOauthState(session.state);
	const credentialId = String(decodedState?.cid || "").trim();
	const codexId = deriveCodexId(profileState, session);
	if (!credentialId || !codexId) return;

	try {
		const { Container } = require("@n8n/di");
		const { CredentialsRepository } = require("@n8n/db");
		const { Credentials } = require("n8n-core");
		const credentialsRepository = Container.get(CredentialsRepository);
		const credential = await credentialsRepository.findOneBy({ id: credentialId });
		if (!credential || credential.type !== "codexChatgptAccount") return;

		const coreCredential = new Credentials(
			credential,
			credential.type,
			credential.data,
		);
		const existingData = coreCredential.getData();
		if (existingData.codexId === codexId) return;

		coreCredential.updateData({ codexId });
		await credentialsRepository.update(credential.id, {
			...coreCredential.getDataToSave(),
			updatedAt: new Date(),
		});
		appendLog(session, `Codex ID field synced to "${codexId}".`);
	} catch (error) {
		appendLog(
			session,
			`Codex ID sync skipped: ${error.message || String(error)}`,
		);
	}
}

function startAuthBridgeInBackground() {
	void ensureAuthBridgeStarted().catch((error) => {
		console.error("[codex-auth-bridge] failed to start:", error.message);
	});
}

async function ensureAuthBridgeStarted() {
	if (serverPromise) return await serverPromise;

	serverPromise = new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			void handleRequest(req, res).catch((error) => {
				console.error("[codex-auth-bridge] request failed:", error);
				writeJson(res, 500, {
					error: "internal_error",
					message: error.message,
				});
			});
		});

		const onError = async (error) => {
			if (error?.code === "EADDRINUSE") {
				const healthy = await probeExistingBridge();
				if (healthy) {
					resolve(null);
					return;
				}
			}
			reject(error);
		};
		server.once("error", onError);
		server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
			server.off("error", onError);
			server.unref?.();
			if (!cleanupStarted) {
				const handle = setInterval(cleanupExpiredEntries, 5 * 60 * 1000);
				handle.unref?.();
				cleanupStarted = true;
			}
			resolve(server);
		});
	});

	return await serverPromise;
}

async function probeExistingBridge() {
	try {
		const response = await fetch(`${getBridgeBaseUrl()}/health`, {
			method: "GET",
		});
		return response.ok;
	} catch {
		return false;
	}
}

async function handleRequest(req, res) {
	const url = new URL(req.url, getBridgeBaseUrl());
	const method = String(req.method || "GET").toUpperCase();

	if (method === "GET" && url.pathname === "/health") {
		writeJson(res, 200, {
			status: "ok",
			baseUrl: getBridgeBaseUrl(),
		});
		return;
	}

	if (method === "GET" && url.pathname === "/oauth/authorize") {
		const session = await getOrCreateSession(url.searchParams);
		writeHtml(res, 200, renderAuthorizePage(session));
		return;
	}

	if (method === "GET" && url.pathname === "/oauth/session") {
		const session = await getOrCreateSession(url.searchParams, {
			requireRedirectUri: false,
		});
		writeJson(res, 200, sessionToClient(session));
		return;
	}

	if (method === "GET" && url.pathname === "/oauth/status") {
		const status = await readProfileState({
			profileKey: url.searchParams.get("profileKey"),
			codexExecutable: url.searchParams.get("codexExecutable") || "",
		});
		writeJson(res, 200, {
			status: status.status,
			connected: status.connected,
			message: status.message,
			profileKey: status.profileKey,
			accountHint: status.accountHint,
			workspaceHint: status.workspaceHint,
			planType: status.planType,
			authFingerprint: status.authFingerprint,
			lastLoginAt: status.lastLoginAt,
			displayName: status.displayName,
			email: status.email,
		});
		return;
	}

	if (url.pathname === "/oauth/token" && (method === "POST" || method === "GET")) {
		const body = method === "POST" ? await parseRequestBody(req) : {};
		const code = body.code || url.searchParams.get("code");
		const clientId = body.client_id || url.searchParams.get("client_id");
		const clientSecret =
			body.client_secret || url.searchParams.get("client_secret");
		const authCode = authCodes.get(String(code || ""));
		if (!authCode) {
			writeJson(res, 400, {
				error: "invalid_grant",
				error_description: "Unknown or expired authorization code.",
			});
			return;
		}
		if (authCode.clientId && clientId && authCode.clientId !== clientId) {
			writeJson(res, 400, {
				error: "invalid_client",
				error_description: "client_id did not match the authorization request.",
			});
			return;
		}
		if (
			authCode.clientSecret &&
			clientSecret &&
			authCode.clientSecret !== clientSecret
		) {
			writeJson(res, 400, {
				error: "invalid_client",
				error_description: "client_secret did not match the authorization request.",
			});
			return;
		}

		authCodes.delete(String(code));
		writeJson(res, 200, authCode.tokenData);
		return;
	}

	if (method === "POST" && url.pathname === "/oauth/device/start") {
		const session = await updateSessionFromBody(req);
		await startLoginFlow(session, "device");
		writeJson(res, 200, sessionToClient(session));
		return;
	}

	if (method === "POST" && url.pathname === "/oauth/browser/start") {
		const session = await updateSessionFromBody(req);
		await startLoginFlow(session, "local_browser");
		writeJson(res, 200, sessionToClient(session));
		return;
	}

	if (method === "POST" && url.pathname === "/oauth/refresh") {
		const session = await updateSessionFromBody(req);
		await refreshSessionProfileState(session, { clearCompletion: true });
		writeJson(res, 200, sessionToClient(session));
		return;
	}

	if (method === "POST" && url.pathname === "/oauth/disconnect") {
		const session = await updateSessionFromBody(req);
		await applySessionAction(session, "disconnect");
		writeJson(res, 200, sessionToClient(session));
		return;
	}

	if (method === "POST" && url.pathname === "/oauth/purge") {
		const session = await updateSessionFromBody(req);
		await applySessionAction(session, "purge");
		writeJson(res, 200, sessionToClient(session));
		return;
	}

	writeJson(res, 404, {
		error: "not_found",
		message: `No route for ${method} ${url.pathname}`,
	});
}

async function updateSessionFromBody(req) {
	const body = await parseRequestBody(req);
	const session = await getOrCreateSession(
		new URLSearchParams({
			state: String(body.state || ""),
		}),
		{ requireRedirectUri: false },
	);
	return session;
}

async function parseRequestBody(req) {
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}

	const rawBody = Buffer.concat(chunks).toString("utf8");
	if (!rawBody.trim()) return {};

	const contentType = String(req.headers["content-type"] || "").toLowerCase();
	if (contentType.includes("application/json")) {
		return JSON.parse(rawBody);
	}

	return Object.fromEntries(new URLSearchParams(rawBody));
}

async function getOrCreateSession(searchParams, options = {}) {
	const state = String(searchParams.get("state") || "").trim();
	if (!state) {
		throw new Error("Missing OAuth state.");
	}

	const redirectUri = String(searchParams.get("redirect_uri") || "").trim();
	if (options.requireRedirectUri !== false && !redirectUri) {
		throw new Error("Missing redirect_uri.");
	}

	const profileKey = sanitizeProfileKey(searchParams.get("profileKey"));
	const codexExecutable = String(
		searchParams.get("codexExecutable") || "",
	).trim();

	let session = authSessions.get(state);
	if (!session) {
		session = {
			state,
			redirectUri,
			clientId: String(searchParams.get("client_id") || "").trim(),
			clientSecret: "codex-local-secret",
			profileKey,
			codexExecutable,
			status: "idle",
			message: "이 credential에 연결할 로그인 방식을 선택하세요.",
			loginMethod: "",
			accountHint: "",
			workspaceHint: "",
			planType: "",
			authFingerprint: "",
			lastLoginAt: "",
			displayName: "",
			email: "",
			userCode: "",
			verificationUrl: "",
			logs: [],
			lastError: "",
			currentChild: null,
			callbackUrl: "",
			completedCode: "",
			closePopup: false,
			closeMessage: "",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		authSessions.set(state, session);
	} else {
		session.redirectUri = redirectUri || session.redirectUri;
		session.profileKey = profileKey || session.profileKey;
		session.codexExecutable = codexExecutable || session.codexExecutable;
		session.clientId =
			String(searchParams.get("client_id") || "").trim() || session.clientId;
	}

	session.updatedAt = Date.now();
	await refreshSessionProfileState(session, { clearCompletion: false });
	return session;
}

async function refreshSessionProfileState(session, options = {}) {
	if (session.profileKey && session.email) {
		const preferredProfileKey = deriveProfileKeyFromIdentity({
			email: session.email,
			fallbackPrefix: session.profileKey,
		});
		if (
			preferredProfileKey &&
			preferredProfileKey !== session.profileKey &&
			!fs.existsSync(getProfileRoot(session.profileKey)) &&
			fs.existsSync(getProfileRoot(preferredProfileKey))
		) {
			session.profileKey = preferredProfileKey;
		}
	}

	let profileState = session.profileKey
		? await readProfileState({
				profileKey: session.profileKey,
				codexExecutable: session.codexExecutable,
		  })
		: createDisconnectedState();

	if (profileState.connected) {
		const preferredProfileKey = deriveProfileKeyFromIdentity({
			email: profileState.email,
			fallbackPrefix: profileState.profileKey,
		});
		if (
			preferredProfileKey &&
			preferredProfileKey !== profileState.profileKey
		) {
			try {
				session.profileKey = await renameProfileKey(
					profileState.profileKey,
					preferredProfileKey,
				);
				appendLog(
					session,
					`Profile key normalized to ${session.profileKey}.`,
				);
				profileState = await readProfileState({
					profileKey: session.profileKey,
					codexExecutable: session.codexExecutable,
				});
			} catch (error) {
				session.lastError = error.message;
				appendLog(
					session,
					`Profile key normalization failed: ${error.message}`,
				);
			}
		}
	}

	session.status = profileState.status;
	session.message = profileState.message;
	session.accountHint = profileState.accountHint;
	session.workspaceHint = profileState.workspaceHint;
	session.planType = profileState.planType;
	session.authFingerprint = profileState.authFingerprint;
	session.lastLoginAt = profileState.lastLoginAt;
	session.displayName = profileState.displayName;
	session.email = profileState.email;
	await syncCredentialCodexIdForSession(session, profileState);
	session.updatedAt = Date.now();

	if (options.clearCompletion) {
		session.callbackUrl = "";
		session.completedCode = "";
		session.closePopup = false;
		session.closeMessage = "";
	}

	return session;
}

async function startLoginFlow(session, loginMethod) {
	if (session.currentChild) {
		throw new Error("A Codex login is already running for this credential.");
	}

	if (!session.profileKey) {
		session.profileKey = createProfileKey("codex-account-temp");
	}

	const profile = await ensureProfileStructure(session.profileKey);
	session.callbackUrl = "";
	session.completedCode = "";
	session.userCode = "";
	session.verificationUrl = "";
	session.lastError = "";
	session.status = "pending";
	session.loginMethod = loginMethod;
	session.message =
		loginMethod === "device"
			? "Device Code 로그인이 완료되기를 기다리는 중입니다."
			: "이 컴퓨터에서 브라우저 로그인이 완료되기를 기다리는 중입니다.";
	session.updatedAt = Date.now();
	appendLog(
		session,
		loginMethod === "device"
			? "Starting `codex login --device-auth`..."
			: "Starting `codex login` for local browser sign-in...",
	);

	const env = {
		CODEX_HOME: profile.codexHome,
	};

	const child = spawnCodexCommand({
		args:
			loginMethod === "device" ? ["login", "--device-auth"] : ["login"],
		codexExecutable: session.codexExecutable,
		env,
		cwd: profile.profileRoot,
		stdio: "pipe",
	});
	session.currentChild = child;

	child.stdout?.on("data", (chunk) => {
		handleLoginOutput(session, chunk);
	});
	child.stderr?.on("data", (chunk) => {
		handleLoginOutput(session, chunk);
	});
	child.on("error", (error) => {
		session.lastError = error.message;
		session.status = "error";
		session.message = error.message;
		session.currentChild = null;
		session.updatedAt = Date.now();
		appendLog(session, `Process error: ${error.message}`);
	});
	child.on("close", (exitCode, signal) => {
		void finalizeLoginFlow(session, exitCode, signal);
	});
}

function handleLoginOutput(session, chunk) {
	const rawText = chunk.toString("utf8");
	appendLog(session, rawText);

	const text = stripAnsi(rawText);

	if (!session.verificationUrl) {
		// "navigate to this URL" 패턴 뒤의 URL을 우선 추출 (codex browser login 출력 형식)
		const navigateMatch = text.match(/navigate to this URL[^:]*:\s*(https?:\/\/\S+)/i);
		if (navigateMatch) {
			session.verificationUrl = navigateMatch[1].replace(/[).,;:]+$/, "");
		} else {
			// fallback: URL 호스트가 localhost/127.0.0.1이 아닌 첫 번째 URL 캡처
			const urlMatches = [...text.matchAll(/https?:\/\/([^\s/]+)/gi)];
			const externalMatch = urlMatches.find(
				(m) => !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(m[1]),
			);
			if (externalMatch) {
				const fullMatch = text.match(
					new RegExp(
						`https?://${externalMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\S*`,
						"i",
					),
				);
				if (fullMatch) {
					session.verificationUrl = fullMatch[0].replace(/[).,;:]+$/, "");
				}
			}
		}
	}

	if (!session.userCode) {
		// 하이픈 포함 대문자 코드 패턴 우선 (예: 4BYW-ERHZ5)
		const codeMatch =
			text.match(/\b([A-Z0-9]{4,}(?:-[A-Z0-9]{2,})+)\b/) ||
			// "one-time code" 또는 "Enter this code" 다음 줄의 코드
			text.match(/(?:one-time code|enter this code|your code)[^\n]*\n\s*([A-Z0-9][A-Z0-9-]{3,})/i);
		if (codeMatch) {
			session.userCode = codeMatch[1];
		}
	}

	session.updatedAt = Date.now();
}

async function finalizeLoginFlow(session, exitCode, signal) {
	session.currentChild = null;
	appendLog(
		session,
		`Codex login process exited with code ${exitCode ?? "null"}${
			signal ? ` (signal: ${signal})` : ""
		}.`,
	);
	await refreshSessionProfileState(session, { clearCompletion: true });

	if (session.status === "connected") {
		// profileKey 정규화 시도
		const preferredProfileKey = deriveProfileKeyFromIdentity({
			email: session.email,
			fallbackPrefix: session.profileKey,
		});
		if (preferredProfileKey && preferredProfileKey !== session.profileKey) {
			try {
				session.profileKey = await renameProfileKey(
					session.profileKey,
					preferredProfileKey,
				);
				await refreshSessionProfileState(session, { clearCompletion: true });
			} catch {}
		}
		session.message = "Codex 계정 연결이 완료되었습니다. n8n으로 돌아갑니다.";
		// 1) DB 직접 업데이트 (OAuth popup callback 실패 시 fallback)
		await directUpdateN8nCredential(session, {
			connected: true,
			status: session.status,
			message: session.message,
		});
		// 2) popup 리다이렉트용 callback URL 생성 (정상 popup 흐름 지원)
		completeSession(session, { connected: true });
		return;
	}

	if (exitCode === 0) {
		session.status = "needs_reconnect";
		session.message =
			"Codex 로그인은 끝났지만 아직 연결 상태로 확인되지 않았습니다. 다시 상태를 확인하거나 재연결해 주세요.";
	} else if (!session.lastError) {
		session.status = "error";
		session.message = "Codex 로그인이 정상적으로 완료되지 않았습니다.";
	}
	session.updatedAt = Date.now();
}

async function applySessionAction(session, action) {
	if (!session.profileKey) {
		throw new Error("이 credential에는 아직 Codex 프로필이 없습니다.");
	}
	if (session.currentChild) {
		throw new Error(
			"현재 진행 중인 Codex 로그인 시도가 끝난 뒤에 Disconnect 또는 Purge를 실행해 주세요.",
		);
	}

	session.callbackUrl = "";
	session.completedCode = "";
	session.lastError = "";
	session.updatedAt = Date.now();

	let profileState;
	if (action === "disconnect") {
		appendLog(session, "이 credential의 Codex 인증을 해제하는 중...");
		profileState = await disconnectProfile({
			profileKey: session.profileKey,
			codexExecutable: session.codexExecutable,
		});
		session.message = "Codex 인증이 해제되었습니다. n8n으로 돌아갑니다.";
	} else {
		appendLog(session, "이 credential의 Codex 인증 캐시를 정리하는 중...");
		profileState = await purgeProfileAuthCache({
			profileKey: session.profileKey,
			codexExecutable: session.codexExecutable,
		});
		session.message = "Codex 인증 캐시를 정리했습니다. n8n으로 돌아갑니다.";
	}

	session.status = profileState.status;
	session.accountHint = profileState.accountHint;
	session.workspaceHint = profileState.workspaceHint;
	session.planType = profileState.planType;
	session.authFingerprint = profileState.authFingerprint;
	session.lastLoginAt = profileState.lastLoginAt;
	session.displayName = profileState.displayName;
	session.email = profileState.email;

	// OAuth callback redirect 없이 n8n credential을 직접 업데이트
	// (이미 소진된 OAuth state 재사용으로 인한 "invalid state" 에러 방지)
	await directUpdateN8nCredential(session, {
		connected: false,
		status: profileState.status,
		message: session.message,
	});

	// 팝업을 자동으로 닫도록 신호 전송
	session.closePopup = true;
	session.closeMessage =
		action === "disconnect"
			? "연결이 해제되었습니다. 이 창을 닫아도 됩니다."
			: "인증이 초기화되었습니다. 이 창을 닫아도 됩니다.";
	session.updatedAt = Date.now();
}

function completeSession(session, overrides = {}) {
	if (!session.redirectUri) {
		return;
	}

	const tokenData = buildOauthTokenData(
		{
			status: session.status,
			connected: overrides.connected ?? session.status === "connected",
			profileKey: session.profileKey,
			authFingerprint: session.authFingerprint,
			lastLoginAt: session.lastLoginAt,
			accountHint: session.accountHint,
			accountId: "",
			email: session.email,
			displayName: session.displayName,
			workspaceHint: session.workspaceHint,
			planType: session.planType,
			codexHome: session.profileKey ? getProfileCodexHome(session.profileKey) : "",
			message: overrides.message || session.message,
		},
		{
			connected: overrides.connected ?? session.status === "connected",
			status: overrides.status || session.status,
			lastLoginMethod:
				overrides.lastLoginMethod ||
				session.loginMethod ||
				(session.status === "connected" ? "device" : ""),
			message: overrides.message || session.message,
		},
	);

	const code = crypto.randomUUID();
	authCodes.set(code, {
		clientId: session.clientId,
		clientSecret: session.clientSecret,
		createdAt: Date.now(),
		tokenData,
	});
	session.completedCode = code;
	session.callbackUrl = buildCallbackUrl(session.redirectUri, session.state, code);
	session.updatedAt = Date.now();
}

function buildCallbackUrl(redirectUri, state, code) {
	const callbackUrl = new URL(redirectUri);
	callbackUrl.searchParams.set("code", code);
	callbackUrl.searchParams.set("state", state);
	return callbackUrl.toString();
}

function sessionToClient(session) {
	return {
		status: session.status,
		message: session.message,
		closePopup: session.closePopup || false,
		closeMessage: session.closeMessage || "",
		profileKey: session.profileKey,
		loginMethod: session.loginMethod,
		accountHint: session.accountHint,
		workspaceHint: session.workspaceHint,
		planType: session.planType,
		authFingerprint: session.authFingerprint,
		lastLoginAt: session.lastLoginAt,
		displayName: session.displayName,
		email: session.email,
		userCode: session.userCode,
		verificationUrl: session.verificationUrl,
		logs: session.logs,
		callbackUrl: session.callbackUrl,
		lastError: session.lastError,
		currentlyRunning: Boolean(session.currentChild),
	};
}

function appendLog(session, text) {
	const lines = stripAnsi(String(text || ""))
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter(Boolean);

	if (lines.length === 0) return;
	session.logs.push(...lines);
	if (session.logs.length > LOG_LINE_LIMIT) {
		session.logs = session.logs.slice(-LOG_LINE_LIMIT);
	}
}

function cleanupExpiredEntries() {
	const now = Date.now();
	for (const [state, session] of authSessions.entries()) {
		if (now - session.updatedAt > SESSION_TTL_MS && !session.currentChild) {
			authSessions.delete(state);
		}
	}

	for (const [code, entry] of authCodes.entries()) {
		if (now - entry.createdAt > AUTH_CODE_TTL_MS) {
			authCodes.delete(code);
		}
	}
}

function writeJson(res, statusCode, payload) {
	res.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(JSON.stringify(payload));
}

function writeHtml(res, statusCode, html) {
	res.writeHead(statusCode, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(html);
}

function renderAuthorizePage(session) {
	return `<!doctype html>
<html lang="ko">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Codex ChatGPT 계정 연결</title>
	<style>
		:root {
			font-family: "Segoe UI", "Apple SD Gothic Neo", Arial, sans-serif;
			color-scheme: light;
			--bg: #f5f7fa;
			--panel: #ffffff;
			--text: #17191c;
			--muted: #6b7280;
			--border: #e5e7eb;
			--accent: #111827;
			--accentHover: #374151;
			--accentText: #ffffff;
			--danger: #dc2626;
			--dangerHover: #b91c1c;
			--warn: #92400e;
			--warnBg: #fffbeb;
			--warnBorder: #fcd34d;
			--ok: #065f46;
			--okBg: #ecfdf5;
			--okBorder: #6ee7b7;
			--info: #1e40af;
			--infoBg: #eff6ff;
			--infoBorder: #93c5fd;
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			padding: 32px 24px;
			min-height: 100vh;
			background: var(--bg);
			color: var(--text);
			display: flex;
			align-items: flex-start;
			justify-content: center;
		}
		.card {
			width: 100%;
			max-width: 560px;
			background: var(--panel);
			border: 1px solid var(--border);
			border-radius: 16px;
			box-shadow: 0 4px 24px rgba(0,0,0,0.07);
			overflow: hidden;
		}
		.card-header {
			padding: 20px 24px 16px;
			border-bottom: 1px solid var(--border);
		}
		.card-header h1 {
			margin: 0 0 4px;
			font-size: 17px;
			font-weight: 700;
			letter-spacing: -0.01em;
		}
		.card-header p {
			margin: 0;
			font-size: 13px;
			color: var(--muted);
			line-height: 1.5;
		}
		.card-body { padding: 20px 24px; }
		/* 상태 배너 */
		.status-banner {
			display: flex;
			align-items: center;
			gap: 10px;
			padding: 12px 16px;
			border-radius: 10px;
			border: 1px solid var(--border);
			margin-bottom: 16px;
			font-size: 14px;
			font-weight: 600;
		}
		.status-banner.connected { background: var(--okBg); border-color: var(--okBorder); color: var(--ok); }
		.status-banner.needs_reconnect, .status-banner.error { background: var(--warnBg); border-color: var(--warnBorder); color: var(--warn); }
		.status-banner.disconnected { background: #fef2f2; border-color: #fca5a5; color: #991b1b; }
		.status-banner.pending, .status-banner.idle { background: var(--infoBg); border-color: var(--infoBorder); color: var(--info); }
		.status-icon { font-size: 16px; flex-shrink: 0; }
		.status-text-wrap { flex: 1; min-width: 0; }
		.status-label { font-weight: 700; }
		.status-sub { font-size: 12px; font-weight: 400; opacity: 0.85; margin-top: 1px; }
		/* 계정 정보 */
		.account-info {
			background: #f9fafb;
			border: 1px solid var(--border);
			border-radius: 10px;
			padding: 12px 16px;
			margin-bottom: 16px;
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 10px 16px;
			font-size: 13px;
		}
		.info-row { display: flex; flex-direction: column; gap: 2px; }
		.info-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
		.info-value { font-weight: 500; color: var(--text); word-break: break-all; }
		/* Device Code 박스 */
		.device-box {
			background: var(--infoBg);
			border: 1px solid var(--infoBorder);
			border-radius: 10px;
			padding: 14px 16px;
			margin-bottom: 16px;
			font-size: 13px;
		}
		.device-box .code {
			font-family: "Consolas", "Courier New", monospace;
			font-size: 22px;
			font-weight: 800;
			letter-spacing: 0.1em;
			color: var(--info);
			margin: 8px 0 4px;
		}
		.device-box a { color: var(--info); font-weight: 600; }
		/* 버튼 */
		.btn-group { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
		.btn {
			display: inline-flex; align-items: center; gap: 6px;
			border-radius: 8px; padding: 9px 16px;
			font-size: 14px; font-weight: 600; cursor: pointer;
			border: 1px solid transparent; transition: background 0.15s, opacity 0.15s;
			line-height: 1;
		}
		.btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
		.btn-primary:hover:not(:disabled) { background: var(--accentHover); border-color: var(--accentHover); }
		.btn-secondary { background: #fff; color: var(--accent); border-color: var(--border); }
		.btn-secondary:hover:not(:disabled) { background: #f9fafb; }
		.btn-admin { color: var(--muted); border-color: #d1d5db; font-size: 12px; }
		.btn-admin:hover:not(:disabled) { background: #f3f4f6; color: var(--text); }
		.btn-danger { background: var(--danger); color: #fff; border-color: var(--danger); }
		.btn-danger:hover:not(:disabled) { background: var(--dangerHover); border-color: var(--dangerHover); }
		.btn:disabled { opacity: 0.45; cursor: not-allowed; }
		.btn-sm { padding: 7px 12px; font-size: 12px; }
		/* 로그 */
		.log-toggle {
			font-size: 12px; color: var(--muted); background: none; border: none;
			cursor: pointer; padding: 0; text-decoration: underline; margin-bottom: 8px;
		}
		.log-toggle:hover { color: var(--text); }
		pre#logOutput {
			display: none;
			margin: 0;
			padding: 12px;
			border-radius: 8px;
			background: #1f2937;
			color: #d1d5db;
			font-size: 11.5px;
			line-height: 1.55;
			white-space: pre-wrap;
			word-break: break-word;
			max-height: 240px;
			overflow: auto;
		}
		pre#logOutput.visible { display: block; }
		/* 닫기 성공 화면 */
		.close-screen {
			display: none;
			flex-direction: column;
			align-items: center;
			text-align: center;
			padding: 32px 24px;
			gap: 12px;
		}
		.close-screen.visible { display: flex; }
		.close-icon { font-size: 48px; }
		.close-title { font-size: 18px; font-weight: 700; }
		.close-sub { font-size: 14px; color: var(--muted); }
		.main-content { }
	</style>
</head>
<body>
	<div class="card">
		<!-- 닫기 완료 화면 (disconnect/purge 후 표시) -->
		<div id="closeScreen" class="close-screen">
			<div class="close-icon">✅</div>
			<div class="close-title" id="closeTitle">완료</div>
			<div class="close-sub" id="closeSub">이 창을 닫아도 됩니다.</div>
		</div>

		<!-- 메인 UI -->
		<div id="mainContent">
			<div class="card-header">
				<h1>Codex ChatGPT 계정 연결</h1>
				<p id="headerDesc">ChatGPT 계정으로 이 credential을 연결합니다.</p>
			</div>
			<div class="card-body">
				<!-- 상태 배너 -->
				<div id="statusBanner" class="status-banner idle">
					<span class="status-icon" id="statusIcon">⟳</span>
					<div class="status-text-wrap">
						<div class="status-label" id="statusLabel">확인 중...</div>
						<div class="status-sub" id="statusSub"></div>
					</div>
				</div>

				<!-- 계정 정보 (연결됨 or needs_reconnect 때만 표시) -->
				<div id="accountInfo" class="account-info" style="display:none">
					<div class="info-row">
						<span class="info-label">계정</span>
						<span class="info-value" id="infoEmail">-</span>
					</div>
					<div class="info-row">
						<span class="info-label">워크스페이스</span>
						<span class="info-value" id="infoWorkspace">-</span>
					</div>
					<div class="info-row">
						<span class="info-label">마지막 로그인</span>
						<span class="info-value" id="infoLastLogin">-</span>
					</div>
					<div class="info-row">
						<span class="info-label">프로필 키</span>
						<span class="info-value" id="infoProfileKey" style="font-size:11px;color:#6b7280">${escapeHtml(session.profileKey || "-")}</span>
					</div>
				</div>

				<!-- Device Code 정보 박스 -->
				<div id="deviceBox" class="device-box" style="display:none">
					<div style="font-weight:600;margin-bottom:4px;">🔐 Device Code 로그인</div>
					<div>아래 URL을 어느 기기에서든 열어 코드를 입력하세요.</div>
					<div class="code" id="deviceCode"></div>
					<div><a id="deviceUrl" href="#" target="_blank" rel="noreferrer">인증 페이지 열기 →</a></div>
				</div>

				<!-- 버튼 그룹: 연결된 상태 -->
				<div id="btnGroupConnected" class="btn-group" style="display:none">
					<button class="btn btn-primary" id="btnRelogin" onclick="runAction('browser')">↺ 재로그인</button>
					<button class="btn btn-secondary" id="btnRefreshConn" onclick="runAction('refresh')">상태 확인</button>
					<button class="btn btn-danger btn-sm" id="btnReset" onclick="confirmReset()">초기화</button>
				</div>

				<!-- 버튼 그룹: 연결 안 된 상태 -->
				<div id="btnGroupDisconnected" class="btn-group" style="display:none">
					<button class="btn btn-primary" id="btnDevice" onclick="runAction('device')">🔑 Device Code 로그인</button>
					<button class="btn btn-secondary btn-admin" id="btnBrowser" onclick="runAction('browser')" title="서버 머신에서 직접 브라우저를 열어 로그인합니다. 서버에 직접 접근 가능한 관리자만 사용하세요.">🖥 서버 브라우저 로그인 <span style="font-size:10px;opacity:0.75;">(관리자)</span></button>
					<button class="btn btn-secondary" id="btnRefreshDisc" onclick="runAction('refresh')">상태 확인</button>
				</div>

				<!-- 로그 토글 -->
				<button class="log-toggle" onclick="toggleLog()">▸ 상세 로그 보기</button>
				<pre id="logOutput">업데이트를 기다리는 중...</pre>
			</div>
		</div>
	</div>
	<script>
		const state = ${JSON.stringify(session.state)};
		let redirecting = false;
		let busy = false;
		let logVisible = false;
		const initialState = ${JSON.stringify(sessionToClient(session))};

		const ALL_BTNS = ['btnRelogin','btnRefreshConn','btnReset','btnBrowser','btnDevice','btnRefreshDisc'];

		function setBusy(nextBusy) {
			busy = nextBusy;
			for (const id of ALL_BTNS) {
				const el = document.getElementById(id);
				if (el) el.disabled = nextBusy;
			}
		}

		function toggleLog() {
			logVisible = !logVisible;
			const log = document.getElementById('logOutput');
			const btn = document.querySelector('.log-toggle');
			log.classList.toggle('visible', logVisible);
			btn.textContent = logVisible ? '▾ 상세 로그 숨기기' : '▸ 상세 로그 보기';
		}

		function fv(v, fallback = '-') {
			return v && String(v).trim() ? String(v).trim() : fallback;
		}

		function statusConfig(status) {
			const map = {
				connected:       { icon: '✓', label: '연결됨',       sub: 'Codex 계정이 정상 연결되어 있습니다.', cls: 'connected' },
				needs_reconnect: { icon: '⚠', label: '재연결 필요',  sub: '저장된 인증 정보가 있지만 재확인이 필요합니다.', cls: 'needs_reconnect' },
				disconnected:    { icon: '✕', label: '연결 안 됨',   sub: 'ChatGPT 계정을 연결해 주세요.', cls: 'disconnected' },
				pending:         { icon: '⟳', label: '로그인 진행 중…', sub: '완료될 때까지 기다려 주세요.', cls: 'pending' },
				idle:            { icon: '○', label: '대기 중',       sub: '로그인 방식을 선택하세요.', cls: 'idle' },
				error:           { icon: '✕', label: '오류 발생',     sub: '로그인에 실패했습니다. 다시 시도해 주세요.', cls: 'error' },
			};
			return map[status] || { icon: '○', label: status || '알 수 없음', sub: '', cls: 'idle' };
		}

		function render(data) {
			if (redirecting) return;

			// 닫기 신호
			if (data.closePopup) {
				redirecting = true;
				document.getElementById('mainContent').style.display = 'none';
				const cs = document.getElementById('closeScreen');
				cs.classList.add('visible');
				document.getElementById('closeTitle').textContent = data.closeMessage || '완료';
				document.getElementById('closeSub').textContent = '이 창을 닫아도 됩니다.';
				setTimeout(() => {
					try { window.close(); } catch(e) {}
				}, 2500);
				return;
			}

			// OAuth 리다이렉트 (로그인 완료)
			if (data.callbackUrl) {
				redirecting = true;
				window.location.href = data.callbackUrl;
				return;
			}

			const st = statusConfig(data.status);

			// 상태 배너
			const banner = document.getElementById('statusBanner');
			banner.className = 'status-banner ' + st.cls;
			document.getElementById('statusIcon').textContent = st.icon;
			document.getElementById('statusLabel').textContent = st.label;

			// sub 텍스트: 진행 중일 때는 message 사용
			const isActive = ['pending'].includes(data.status);
			document.getElementById('statusSub').textContent = isActive
				? fv(data.message, st.sub)
				: (data.email ? data.email : st.sub);

			// 계정 정보
			const hasAccount = Boolean(data.email || data.accountHint || data.workspaceHint);
			const acctInfo = document.getElementById('accountInfo');
			acctInfo.style.display = hasAccount ? 'grid' : 'none';
			if (hasAccount) {
				document.getElementById('infoEmail').textContent = fv(data.email || data.accountHint);
				document.getElementById('infoWorkspace').textContent = fv(data.workspaceHint);
				document.getElementById('infoLastLogin').textContent = fv(data.lastLoginAt);
				document.getElementById('infoProfileKey').textContent = fv(data.profileKey);
			}

			// Device Code 박스
			const hasDevice = Boolean(data.verificationUrl || data.userCode);
			const devBox = document.getElementById('deviceBox');
			devBox.style.display = hasDevice ? 'block' : 'none';
			if (hasDevice) {
				document.getElementById('deviceCode').textContent = fv(data.userCode);
				const urlEl = document.getElementById('deviceUrl');
				urlEl.href = data.verificationUrl || '#';
				urlEl.textContent = data.verificationUrl ? '인증 페이지 열기 →' : '-';
				if (!logVisible) toggleLog();
			}

			// 버튼 그룹
			const isConnected = data.status === 'connected';
			const isRunning = Boolean(data.currentlyRunning);
			document.getElementById('btnGroupConnected').style.display = (isConnected && !isRunning) ? 'flex' : 'none';
			document.getElementById('btnGroupDisconnected').style.display = (!isConnected && !isRunning) ? 'flex' : 'none';

			// 로그
			const logs = data.logs && data.logs.length ? data.logs.join('\\n') : '';
			if (logs) {
				document.getElementById('logOutput').textContent = logs;
				if (isActive && !logVisible) toggleLog();
			}
		}

		function confirmReset() {
			if (busy || redirecting) return;
			if (confirm('인증을 완전히 초기화합니다.\\n로그아웃되며 저장된 토큰이 삭제됩니다.\\n계속하시겠습니까?')) {
				runAction('purge');
			}
		}

		async function fetchState() {
			try {
				const response = await fetch('/oauth/session?state=' + encodeURIComponent(state), { cache: 'no-store' });
				if (!response.ok) return;
				const data = await response.json();
				render(data);
				if (!redirecting) {
					window.setTimeout(fetchState, data.currentlyRunning ? 1500 : 4000);
				}
			} catch {
				if (!redirecting) window.setTimeout(fetchState, 5000);
			}
		}

		async function runAction(action) {
			if (busy || redirecting) return;
			setBusy(true);
			const endpoint = {
				device:    '/oauth/device/start',
				browser:   '/oauth/browser/start',
				refresh:   '/oauth/refresh',
				disconnect:'/oauth/disconnect',
				purge:     '/oauth/purge',
			}[action];
			if (!endpoint) { setBusy(false); return; }
			try {
				const response = await fetch(endpoint, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ state }),
				});
				const data = await response.json();
				if (!response.ok) throw new Error(data.message || data.error || '요청에 실패했습니다.');
				render(data);
			} catch (error) {
				document.getElementById('statusSub').textContent = error.message;
			} finally {
				if (!redirecting) setBusy(false);
			}
		}

		render(initialState);
		void fetchState();
	</script>
</body>
</html>`;
}

function escapeHtml(value) {
	return String(value || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

module.exports = {
	ensureAuthBridgeStarted,
	getBridgeBaseUrl,
	startAuthBridgeInBackground,
};
