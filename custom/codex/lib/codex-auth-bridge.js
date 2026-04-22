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

const BRIDGE_CLIENT_SECRET =
	process.env.CODEX_AUTH_BRIDGE_SECRET || crypto.randomBytes(32).toString("hex");

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
		if (connected) {
			// connected: true 시 oauthTokenData를 채워 n8n이 "Account connected"로 표시함.
			const tokenData = buildOauthTokenData(
				{ ...session, status, message },
				{ connected: true, status, message, lastLoginMethod: "" },
			);
			coreCredential.updateData({ oauthTokenData: tokenData });
		} else {
			// connected: false 시 oauthTokenData 필드 자체를 삭제해야 n8n이 "Connect" 버튼을 표시함.
			// null로 저장하면 n8n 로딩 시 "Cannot read properties of null (reading 'toString')" 에러 발생.
			const data = coreCredential.getData();
			delete data.oauthTokenData;
			coreCredential.setData(data);
		}
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

function isOriginAllowed(req) {
	const origin = String(req.headers.origin || req.headers.referer || "").trim();
	if (!origin) return true; // allow non-browser clients (n8n internal calls)
	const allowed = [
		"http://localhost",
		"https://n8n.seunghyun.space",
		"https://codex-bridge.seunghyun.space",
	];
	return allowed.some((prefix) => origin.startsWith(prefix));
}

async function handleRequest(req, res) {
	const url = new URL(req.url, getBridgeBaseUrl());
	const method = String(req.method || "GET").toUpperCase();

	// CSRF protection: block POST requests from unknown origins
	if (method === "POST" && !isOriginAllowed(req)) {
		writeJson(res, 403, { error: "forbidden", error_description: "Origin not allowed" });
		return;
	}

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
			clientSecret: BRIDGE_CLIENT_SECRET,
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
			} catch {
				// rename 실패 시 (대상 디렉토리가 이미 존재하는 등): preferredProfileKey가
				// 이미 connected 상태라면 그쪽으로 세션을 전환한다.
				// 이렇게 하지 않으면 임시 profileKey가 credential에 저장되어
				// 이후 팝업이 올바른 프로파일을 찾지 못하는 버그가 발생한다.
				const preferred = await readProfileState({
					profileKey: preferredProfileKey,
					codexExecutable: session.codexExecutable,
				});
				if (preferred.connected) {
					session.profileKey = preferredProfileKey;
					await refreshSessionProfileState(session, { clearCompletion: true });
				}
			}
		}
		session.message = "Codex 계정 연결이 완료되었습니다. n8n으로 돌아갑니다.";
		// popup OAuth callback 흐름으로 n8n이 credential을 업데이트하도록 함
		// (directUpdateN8nCredential을 connected=true에서 먼저 호출하면
		//  n8n의 OAuth callback postMessage 처리가 달라져 UI가 초록으로 갱신되지 않는 문제)
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

const SECURITY_HEADERS = {
	"x-frame-options": "DENY",
	"x-content-type-options": "nosniff",
	"content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
	"referrer-policy": "strict-origin-when-cross-origin",
	"cache-control": "no-store",
};

function writeJson(res, statusCode, payload) {
	res.writeHead(statusCode, {
		...SECURITY_HEADERS,
		"content-type": "application/json; charset=utf-8",
	});
	res.end(JSON.stringify(payload));
}

function writeHtml(res, statusCode, html) {
	res.writeHead(statusCode, {
		...SECURITY_HEADERS,
		"content-type": "text/html; charset=utf-8",
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
			--bg: #18181b;
			--surface: #ffffff;
			--surface-2: #fafafa;
			--surface-3: #f4f4f5;
			--border: #e4e4e7;
			--border-2: #d4d4d8;
			--ink: #09090b;
			--muted: #71717a;
			--muted-2: #a1a1aa;
			--accent: #18181b;
			--accent-fg: #ffffff;
			--ok: #15803d;
			--ok-bg: #f0fdf4;
			--err: #b91c1c;
			--err-bg: #fef2f2;
			--err-border: #fecaca;
		}
		* { box-sizing: border-box; }
		html, body { margin: 0; color: var(--ink); }
		body {
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif;
			-webkit-font-smoothing: antialiased;
			-moz-osx-font-smoothing: grayscale;
			letter-spacing: -0.005em;
			min-height: 100vh;
			background: var(--bg);
			background-image: radial-gradient(ellipse at top, #27272a, #0b0c0e 70%);
			padding: 36px 28px;
			display: flex;
			align-items: flex-start;
			justify-content: center;
		}

		/* card */
		.card {
			width: 100%;
			max-width: 440px;
			background: var(--surface);
			border: 1px solid var(--border);
			border-radius: 12px;
			box-shadow: 0 0 0 1px rgba(0,0,0,0.02), 0 1px 2px rgba(0,0,0,0.06), 0 8px 24px -8px rgba(0,0,0,0.22);
			overflow: hidden;
		}
		.card-head {
			padding: 18px 20px 14px;
			border-bottom: 1px solid var(--border);
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 12px;
		}
		.card-head h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; color: var(--ink); }
		.card-head p { margin: 3px 0 0; font-size: 12.5px; color: var(--muted); font-weight: 400; line-height: 1.5; }
		.card-body { padding: 16px 20px 18px; }
		.head-left { display: flex; gap: 10px; align-items: flex-start; }
		.brand {
			width: 24px; height: 24px;
			border-radius: 6px;
			background: var(--ink);
			color: #fff;
			display: inline-flex; align-items: center; justify-content: center;
			font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
			font-weight: 600;
			font-size: 12px;
			flex-shrink: 0;
		}

		/* status */
		.status {
			display: flex; align-items: center; gap: 12px;
			padding: 12px 14px;
			border: 1px solid var(--border);
			border-radius: 10px;
			background: var(--surface-2);
		}
		.indicator {
			width: 8px; height: 8px; border-radius: 50%;
			flex-shrink: 0;
			background: var(--muted-2);
			position: relative;
		}
		.indicator.ok { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,0.18); }
		.indicator.pend { background: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.18); }
		.indicator.pend::after {
			content: ''; position: absolute; inset: -6px; border-radius: 50%;
			border: 1px solid #3b82f6; opacity: 0.4;
			animation: ping 1.6s cubic-bezier(0,0,0.2,1) infinite;
		}
		.indicator.warn { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,0.18); }
		.indicator.err { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,0.18); }
		@keyframes ping {
			0% { transform: scale(0.6); opacity: 0.6; }
			80% { transform: scale(1.4); opacity: 0; }
			100% { opacity: 0; }
		}
		.st-text { flex: 1; min-width: 0; }
		.st-label { font-size: 13.5px; font-weight: 600; color: var(--ink); letter-spacing: -0.005em; }
		.st-sub {
			font-size: 12px; color: var(--muted); margin-top: 2px; line-height: 1.45;
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}

		/* info grid */
		.info {
			margin-top: 14px;
			border: 1px solid var(--border);
			border-radius: 10px;
			overflow: hidden;
		}
		.info-row {
			display: grid; grid-template-columns: 120px 1fr;
			padding: 10px 14px;
			font-size: 12.5px;
			align-items: center;
		}
		.info-row + .info-row { border-top: 1px solid var(--border); }
		.info-row .k {
			color: var(--muted); font-size: 11px; font-weight: 500;
			letter-spacing: 0.02em; text-transform: uppercase;
			font-feature-settings: 'tnum';
		}
		.info-row .v { color: var(--ink); font-weight: 500; word-break: break-all; }
		.info-row .v.mono {
			font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
			font-size: 11.5px; font-weight: 400; color: var(--muted); letter-spacing: 0;
		}

		/* device */
		.device {
			margin-top: 14px;
			border: 1px solid var(--border);
			border-radius: 10px;
			padding: 14px;
			background: var(--surface-2);
		}
		.device-label {
			font-size: 10.5px; color: var(--muted);
			text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;
			margin-bottom: 8px;
			display: flex; justify-content: space-between; align-items: center; gap: 8px;
		}
		.device-url-ref {
			font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
			font-size: 10.5px; color: var(--muted); text-transform: none;
			letter-spacing: 0; font-weight: 400;
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%;
		}
		.code {
			font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, "Courier New", monospace;
			font-size: 26px; font-weight: 600; letter-spacing: 0.1em;
			color: var(--ink);
			text-align: center;
			padding: 10px 8px;
			background: #fff;
			border: 1px solid var(--border);
			border-radius: 8px;
			user-select: all;
		}
		.device-actions { display: flex; gap: 8px; margin-top: 10px; }
		.device-actions .btn { flex: 1; justify-content: center; }
		.progress {
			margin-top: 10px;
			height: 2px;
			background: var(--border);
			border-radius: 999px;
			overflow: hidden;
			position: relative;
		}
		.progress::after {
			content: ''; position: absolute; inset: 0;
			background: linear-gradient(90deg, transparent, #3b82f6, transparent);
			width: 40%;
			animation: slide 1.8s ease-in-out infinite;
		}
		@keyframes slide {
			0% { transform: translateX(-100%); }
			100% { transform: translateX(350%); }
		}
		.progress-label {
			margin-top: 8px;
			font-size: 11.5px;
			color: var(--muted);
			text-align: center;
		}

		/* buttons */
		.actions { margin-top: 14px; display: flex; gap: 8px; }
		.btn {
			display: inline-flex; align-items: center; justify-content: center; gap: 6px;
			font-family: inherit;
			font-size: 13px; font-weight: 500;
			letter-spacing: -0.005em;
			padding: 9px 14px;
			border-radius: 8px;
			border: 1px solid var(--border-2);
			background: #fff;
			color: var(--ink);
			cursor: pointer;
			transition: background 120ms, border-color 120ms, transform 120ms;
			text-decoration: none;
			line-height: 1;
			white-space: nowrap;
		}
		.btn:hover:not(:disabled) { background: var(--surface-3); border-color: var(--muted-2); }
		.btn:active:not(:disabled) { transform: translateY(0.5px); }
		.btn:disabled { opacity: 0.5; cursor: not-allowed; }
		.btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
		.btn.primary:hover:not(:disabled) { background: #27272a; border-color: #27272a; }
		.btn.wide { flex: 1; }
		.btn.sm { padding: 7px 10px; font-size: 12px; }
		.btn svg { flex-shrink: 0; }

		/* kebab */
		.kebab-wrap { position: relative; }
		.kebab {
			width: 28px; height: 28px;
			border-radius: 6px;
			border: 1px solid transparent;
			background: transparent;
			color: var(--muted);
			cursor: pointer;
			display: inline-flex; align-items: center; justify-content: center;
			transition: background 120ms, border-color 120ms;
		}
		.kebab:hover { background: var(--surface-3); border-color: var(--border); color: var(--ink); }
		.kebab svg { width: 16px; height: 16px; }
		.menu-pop {
			position: absolute; right: 0; top: calc(100% + 4px);
			min-width: 220px;
			background: #fff;
			border: 1px solid var(--border);
			border-radius: 10px;
			box-shadow: 0 4px 12px -2px rgba(0,0,0,0.08), 0 2px 4px -1px rgba(0,0,0,0.06);
			padding: 4px;
			z-index: 5;
			font-size: 12.5px;
			display: none;
		}
		.menu-pop.open { display: block; }
		.menu-item {
			display: flex; align-items: center; justify-content: space-between; gap: 10px;
			padding: 7px 10px;
			border-radius: 6px;
			cursor: pointer;
			color: var(--ink);
			border: none;
			background: transparent;
			width: 100%;
			font-family: inherit;
			font-size: 12.5px;
			text-align: left;
		}
		.menu-item:hover:not(:disabled) { background: var(--surface-3); }
		.menu-item:disabled { opacity: 0.5; cursor: not-allowed; }
		.menu-item.danger { color: var(--err); }
		.menu-item.danger:hover:not(:disabled) { background: var(--err-bg); }
		.mi-tag {
			font-size: 10px;
			color: var(--muted);
			font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
			letter-spacing: 0.04em;
		}
		.menu-divider { height: 1px; background: var(--border); margin: 4px 2px; }

		/* inline error */
		.inline-err {
			margin-top: 12px;
			padding: 10px 12px;
			background: var(--err-bg);
			border: 1px solid var(--err-border);
			border-radius: 8px;
			font-size: 12.5px;
			color: var(--err);
			line-height: 1.5;
		}
		.inline-err .t { font-weight: 600; margin-bottom: 2px; }

		/* reset confirm */
		.reset-confirm {
			margin-top: 12px;
			padding: 12px 14px;
			background: var(--err-bg);
			border: 1px solid var(--err-border);
			border-radius: 10px;
			font-size: 13px;
		}
		.reset-confirm .rc-title { font-weight: 600; color: var(--err); margin-bottom: 8px; }
		.reset-confirm .rc-msg { color: #7f1d1d; margin-bottom: 10px; line-height: 1.5; }
		.reset-confirm .rc-actions { display: flex; gap: 8px; }
		.reset-confirm .btn.primary { background: var(--err); border-color: var(--err); color: #fff; }
		.reset-confirm .btn.primary:hover:not(:disabled) { background: #991b1b; border-color: #991b1b; }

		/* hint */
		.hint {
			font-size: 11.5px;
			color: var(--muted);
			text-align: center;
			margin-top: 10px;
			line-height: 1.5;
		}

		/* logs */
		details.logs {
			margin-top: 14px;
			border-top: 1px solid var(--border);
			padding-top: 12px;
		}
		details.logs summary {
			cursor: pointer;
			font-size: 11.5px;
			color: var(--muted);
			font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
			list-style: none;
			display: flex;
			align-items: center;
			gap: 4px;
			letter-spacing: 0.02em;
		}
		details.logs summary::-webkit-details-marker { display: none; }
		details.logs summary::before {
			content: '▸';
			font-family: sans-serif;
			font-size: 9px;
			transition: transform 120ms;
		}
		details[open].logs summary::before { transform: rotate(90deg); }
		details.logs pre {
			margin: 10px 0 0;
			background: #0b0c0e;
			color: #a1a1aa;
			border-radius: 8px;
			padding: 10px 12px;
			font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
			font-size: 11px;
			line-height: 1.55;
			max-height: 180px;
			overflow: auto;
			white-space: pre-wrap;
			word-break: break-word;
		}

		/* close screen */
		.close-screen {
			display: none;
			flex-direction: column;
			align-items: center;
			text-align: center;
			padding: 40px 24px;
			gap: 12px;
		}
		.close-screen.visible { display: flex; }
		.close-icon {
			width: 44px; height: 44px;
			border-radius: 50%;
			background: var(--ok-bg);
			color: var(--ok);
			display: flex; align-items: center; justify-content: center;
		}
		.close-icon svg { width: 24px; height: 24px; }
		.close-title { font-size: 16px; font-weight: 600; color: var(--ink); margin-top: 4px; }
		.close-sub { font-size: 13px; color: var(--muted); }

		.hidden { display: none !important; }
	</style>
</head>
<body>
	<div class="card">
		<!-- 닫기 완료 화면 (disconnect/purge 후 표시) -->
		<div id="closeScreen" class="close-screen">
			<div class="close-icon">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="20 6 9 17 4 12"></polyline>
				</svg>
			</div>
			<div class="close-title" id="closeTitle">완료</div>
			<div class="close-sub" id="closeSub">이 창을 닫아도 됩니다.</div>
		</div>

		<!-- 메인 UI -->
		<div id="mainContent">
			<div class="card-head">
				<div class="head-left">
					<div class="brand">C</div>
					<div>
						<h1>ChatGPT account</h1>
						<p>Codex credential · 이 credential에 연결된 계정</p>
					</div>
				</div>
				<div class="kebab-wrap" id="kebabWrap">
					<button class="kebab" id="kebabBtn" type="button" aria-label="더보기" onclick="toggleKebab(event)">
						<svg viewBox="0 0 16 16" fill="currentColor">
							<circle cx="8" cy="3" r="1.3"></circle>
							<circle cx="8" cy="8" r="1.3"></circle>
							<circle cx="8" cy="13" r="1.3"></circle>
						</svg>
					</button>
					<div class="menu-pop" id="menuPop" role="menu"></div>
				</div>
			</div>

			<div class="card-body">
				<div class="status">
					<span class="indicator" id="statusIndicator"></span>
					<div class="st-text">
						<div class="st-label" id="statusLabel">확인 중...</div>
						<div class="st-sub" id="statusSub"></div>
					</div>
				</div>

				<div class="info hidden" id="accountInfo">
					<div class="info-row"><span class="k">Account</span><span class="v" id="infoEmail">-</span></div>
					<div class="info-row"><span class="k">Workspace</span><span class="v" id="infoWorkspace">-</span></div>
					<div class="info-row"><span class="k">Last sign-in</span><span class="v" id="infoLastLogin">-</span></div>
					<div class="info-row"><span class="k">Profile key</span><span class="v mono" id="infoProfileKey">-</span></div>
				</div>

				<div class="device hidden" id="deviceBox">
					<div class="device-label">
						<span>One-time code</span>
						<span class="device-url-ref" id="deviceUrlRef">-</span>
					</div>
					<div class="code" id="deviceCode">------</div>
					<div class="device-actions">
						<button class="btn sm" id="btnCopy" type="button" onclick="copyCode()">
							<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
								<rect x="5" y="5" width="8" height="8" rx="1.5"></rect>
								<path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H4.5A1.5 1.5 0 0 0 3 3.5v6A1.5 1.5 0 0 0 4.5 11H5"></path>
							</svg>
							<span id="btnCopyLabel">코드 복사</span>
						</button>
						<a class="btn sm primary" id="btnOpenUrl" href="#" target="_blank" rel="noreferrer">
							<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
								<path d="M9 3h4v4"></path>
								<path d="M13 3L7 9"></path>
								<path d="M11 10v3H3V5h3"></path>
							</svg>
							인증 페이지 열기
						</a>
					</div>
					<div class="progress"></div>
					<div class="progress-label" id="progressLabel">브라우저에서 로그인을 기다리는 중…</div>
				</div>

				<div class="actions hidden" id="primaryActions">
					<button class="btn wide" id="primaryBtn" type="button" onclick="onPrimaryClick()">-</button>
				</div>

				<div class="hint hidden" id="hintText"></div>

				<div class="inline-err hidden" id="inlineErr">
					<div class="t">로그인 실패</div>
					<div id="errMsg">다시 시도하거나 인증 캐시를 초기화해 보세요.</div>
				</div>

				<div class="reset-confirm hidden" id="resetConfirm">
					<div class="rc-title">인증을 완전히 초기화합니다.</div>
					<div class="rc-msg">로그아웃되며 저장된 토큰이 삭제됩니다. 계속하시겠습니까?</div>
					<div class="rc-actions">
						<button class="btn primary sm" type="button" onclick="doReset()">초기화 확인</button>
						<button class="btn sm" type="button" onclick="hideResetConfirm()">취소</button>
					</div>
				</div>

				<details class="logs" id="logsDetails">
					<summary>Activity log</summary>
					<pre id="logOutput">업데이트를 기다리는 중...</pre>
				</details>
			</div>
		</div>
	</div>
	<script>
		const state = ${JSON.stringify(session.state)};
		let redirecting = false;
		let busy = false;
		const initialState = ${JSON.stringify(sessionToClient(session))};

		function fv(v, fallback) {
			if (fallback === undefined) fallback = '-';
			return v && String(v).trim() ? String(v).trim() : fallback;
		}

		function statusConfig(status) {
			const map = {
				connected:       { tone: 'ok',   label: 'Connected',      sub: 'Codex 계정이 정상 연결되어 있습니다.' },
				needs_reconnect: { tone: 'warn', label: '재연결 필요',     sub: '저장된 인증 정보 재확인이 필요합니다.' },
				pending:         { tone: 'pend', label: '로그인 대기 중',   sub: '브라우저에서 승인을 기다리는 중입니다.' },
				disconnected:    { tone: '',     label: 'Not connected',  sub: 'ChatGPT 계정을 연결해 주세요.' },
				idle:            { tone: '',     label: '대기 중',         sub: '로그인 방식을 선택하세요.' },
				error:           { tone: 'err',  label: 'Sign-in failed', sub: '로그인에 실패했습니다.' },
			};
			return map[status] || { tone: '', label: status || 'Unknown', sub: '' };
		}

		function toggleKebab(ev) {
			if (ev) ev.stopPropagation();
			document.getElementById('menuPop').classList.toggle('open');
		}
		function closeKebab() {
			document.getElementById('menuPop').classList.remove('open');
		}
		document.addEventListener('click', function(ev) {
			const wrap = document.getElementById('kebabWrap');
			if (wrap && !wrap.contains(ev.target)) closeKebab();
		});

		function buildKebabMenu(status, isRunning) {
			const isConnected = (status === 'connected' || status === 'needs_reconnect');
			const items = [];
			if (isConnected) {
				items.push({ label: '다른 계정으로 재로그인', tag: 'device', action: 'device' });
				items.push({ label: '상태 새로고침',         tag: '↻',      action: 'refresh' });
				items.push({ divider: true });
				items.push({ label: '연결 해제', danger: true, action: 'disconnect' });
				items.push({ label: '인증 캐시 초기화', danger: true, action: 'reset' });
			} else {
				items.push({ label: '서버 브라우저 로그인', tag: 'admin', action: 'browser' });
				items.push({ label: '상태 새로고침',       tag: '↻',     action: 'refresh' });
				items.push({ divider: true });
				items.push({ label: '인증 캐시 초기화', danger: true, action: 'reset' });
			}
			const pop = document.getElementById('menuPop');
			pop.innerHTML = '';
			for (const it of items) {
				if (it.divider) {
					const d = document.createElement('div');
					d.className = 'menu-divider';
					pop.appendChild(d);
					continue;
				}
				const b = document.createElement('button');
				b.type = 'button';
				b.className = 'menu-item' + (it.danger ? ' danger' : '');
				b.setAttribute('role', 'menuitem');
				b.disabled = isRunning;
				const tagHtml = it.tag ? '<span class="mi-tag">' + it.tag + '</span>' : '';
				b.innerHTML = '<span>' + it.label + '</span>' + tagHtml;
				b.onclick = function() {
					closeKebab();
					if (it.action === 'reset') showResetConfirm();
					else runAction(it.action);
				};
				pop.appendChild(b);
			}
		}

		async function copyCode() {
			const code = document.getElementById('deviceCode').textContent.trim();
			if (!code || code === '------') return;
			const lbl = document.getElementById('btnCopyLabel');
			const prev = lbl.textContent;
			try {
				await navigator.clipboard.writeText(code);
			} catch (e) {
				try {
					const r = document.createRange();
					r.selectNodeContents(document.getElementById('deviceCode'));
					const sel = window.getSelection();
					sel.removeAllRanges();
					sel.addRange(r);
					document.execCommand('copy');
					sel.removeAllRanges();
				} catch (e2) {
					lbl.textContent = '복사 실패';
					setTimeout(function() { lbl.textContent = prev; }, 1200);
					return;
				}
			}
			lbl.textContent = '복사됨';
			setTimeout(function() { lbl.textContent = prev; }, 1200);
		}

		let primaryAction = null;
		function onPrimaryClick() {
			if (!primaryAction) return;
			runAction(primaryAction);
		}

		function render(data) {
			if (redirecting) return;

			if (data.closePopup) {
				redirecting = true;
				document.getElementById('mainContent').style.display = 'none';
				const cs = document.getElementById('closeScreen');
				cs.classList.add('visible');
				document.getElementById('closeTitle').textContent = data.closeMessage || '완료';
				document.getElementById('closeSub').textContent = '이 창을 닫아도 됩니다.';
				setTimeout(function() { try { window.close(); } catch(e) {} }, 2500);
				return;
			}

			if (data.callbackUrl) {
				redirecting = true;
				window.location.href = data.callbackUrl;
				return;
			}

			const status = data.status || 'idle';
			const cfg = statusConfig(status);
			const isRunning = Boolean(data.currentlyRunning);

			// 상태
			const ind = document.getElementById('statusIndicator');
			ind.className = 'indicator' + (cfg.tone ? ' ' + cfg.tone : '');
			document.getElementById('statusLabel').textContent = cfg.label;
			const subEl = document.getElementById('statusSub');
			if (status === 'pending') {
				subEl.textContent = fv(data.message, cfg.sub);
			} else if (data.email && (status === 'connected' || status === 'needs_reconnect')) {
				subEl.textContent = data.email;
			} else {
				subEl.textContent = cfg.sub;
			}

			// 계정 정보
			const hasAccount = Boolean(data.email || data.accountHint || data.workspaceHint || data.profileKey);
			const showAccount = hasAccount && (status === 'connected' || status === 'needs_reconnect');
			const accountInfo = document.getElementById('accountInfo');
			accountInfo.classList.toggle('hidden', !showAccount);
			if (showAccount) {
				document.getElementById('infoEmail').textContent = fv(data.email || data.accountHint);
				document.getElementById('infoWorkspace').textContent = fv(data.workspaceHint || data.planType);
				document.getElementById('infoLastLogin').textContent = fv(data.lastLoginAt);
				document.getElementById('infoProfileKey').textContent = fv(data.profileKey);
			}

			// Device code
			const hasDevice = Boolean(data.verificationUrl || data.userCode) && status === 'pending';
			const devBox = document.getElementById('deviceBox');
			devBox.classList.toggle('hidden', !hasDevice);
			if (hasDevice) {
				document.getElementById('deviceCode').textContent = fv(data.userCode, '------');
				const ref = document.getElementById('deviceUrlRef');
				const url = data.verificationUrl || '';
				try {
					const parsed = new URL(url);
					ref.textContent = parsed.host + parsed.pathname;
				} catch { ref.textContent = url || '-'; }
				const openBtn = document.getElementById('btnOpenUrl');
				openBtn.href = url || '#';
				openBtn.classList.toggle('hidden', !url);
			}

			// 주요 액션 버튼 + hint + error
			const primary = document.getElementById('primaryActions');
			const primaryBtn = document.getElementById('primaryBtn');
			const hintText = document.getElementById('hintText');
			const inlineErr = document.getElementById('inlineErr');

			primary.classList.add('hidden');
			hintText.classList.add('hidden');
			inlineErr.classList.add('hidden');

			primaryBtn.classList.remove('primary');
			primaryBtn.disabled = isRunning;

			if (status === 'connected') {
				primary.classList.remove('hidden');
				primaryBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8a6 6 0 0 1 10.2-4.3L14 5"/><path d="M14 2v3h-3"/><path d="M14 8a6 6 0 0 1-10.2 4.3L2 11"/><path d="M2 14v-3h3"/></svg><span>상태 새로고침</span>';
				primaryAction = 'refresh';
			} else if (status === 'needs_reconnect') {
				primary.classList.remove('hidden');
				primaryBtn.classList.add('primary');
				primaryBtn.innerHTML = '<span>↺ 재로그인 (Device Code)</span>';
				primaryAction = 'device';
			} else if (status === 'disconnected' || status === 'idle') {
				primary.classList.remove('hidden');
				primaryBtn.classList.add('primary');
				primaryBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="11" r="3"/><path d="M7.1 8.9L14 2"/><path d="M11 5l2 2"/></svg><span>Device Code로 연결</span>';
				primaryAction = 'device';
				hintText.classList.remove('hidden');
				hintText.textContent = '다른 기기에서 코드를 입력해 로그인합니다. 가장 안전한 방법입니다.';
			} else if (status === 'error') {
				primary.classList.remove('hidden');
				primaryBtn.classList.add('primary');
				primaryBtn.innerHTML = '<span>↻ 다시 시도</span>';
				primaryAction = 'device';
				inlineErr.classList.remove('hidden');
				document.getElementById('errMsg').textContent = fv(data.lastError || data.message, '다시 시도하거나 인증 캐시를 초기화해 보세요.');
			}

			// Kebab 메뉴 재생성
			buildKebabMenu(status, isRunning);

			// pending 상태에서는 초기화 확인창 자동으로 닫기
			if (status === 'pending') hideResetConfirm();

			// 로그
			const logs = data.logs && data.logs.length ? data.logs.join('\\n') : '';
			const logsEl = document.getElementById('logOutput');
			const detailsEl = document.getElementById('logsDetails');
			if (logs) {
				logsEl.textContent = logs;
				if (status === 'pending' || status === 'error') detailsEl.open = true;
			}
		}

		function showResetConfirm() {
			if (busy || redirecting) return;
			document.getElementById('resetConfirm').classList.remove('hidden');
		}
		function hideResetConfirm() {
			document.getElementById('resetConfirm').classList.add('hidden');
		}
		function doReset() {
			hideResetConfirm();
			runAction('purge');
		}

		function setBusy(v) {
			busy = v;
			const pb = document.getElementById('primaryBtn');
			if (pb) pb.disabled = v;
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
				device:     '/oauth/device/start',
				browser:    '/oauth/browser/start',
				refresh:    '/oauth/refresh',
				disconnect: '/oauth/disconnect',
				purge:      '/oauth/purge',
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
