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

const DEFAULT_HOST = process.env.CODEX_AUTH_BRIDGE_HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.CODEX_AUTH_BRIDGE_PORT || 3481);
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
	const text = chunk.toString("utf8");
	appendLog(session, text);

	if (!session.verificationUrl) {
		const urlMatch = text.match(/https?:\/\/[^\s)]+/i);
		if (urlMatch) {
			session.verificationUrl = urlMatch[0];
		}
	}

	if (!session.userCode) {
		const codeMatch =
			text.match(/(?:code|enter this code)[^A-Z0-9-]*([A-Z0-9-]{4,})/i) ||
			text.match(/\b([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\b/);
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
		session.message = "Codex 계정 연결이 완료되었습니다. n8n으로 돌아갑니다.";
		completeSession(session, { connected: true });
		return;
	}

	if (session.status === "connected") {
		const preferredProfileKey = deriveProfileKeyFromIdentity({
			email: session.email,
			fallbackPrefix: session.profileKey,
		});
		if (preferredProfileKey && preferredProfileKey !== session.profileKey) {
			session.profileKey = await renameProfileKey(
				session.profileKey,
				preferredProfileKey,
			);
			await refreshSessionProfileState(session, { clearCompletion: true });
		}
		session.message = "Codex 계정 연결이 완료되었습니다. n8n으로 돌아갑니다.";
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
	completeSession(session, {
		connected: false,
		status: profileState.status,
		message: session.message,
	});
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
	const lines = String(text || "")
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
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Codex ChatGPT Account</title>
	<style>
		:root {
			font-family: "Segoe UI", Arial, sans-serif;
			color-scheme: light;
			--bg: #f6f7fb;
			--panel: #ffffff;
			--text: #17191c;
			--muted: #5f6570;
			--border: #d7dbe4;
			--accent: #101828;
			--accentText: #ffffff;
			--warn: #7a2e0b;
			--warnBg: #fff0e8;
			--ok: #1f6b3b;
			--okBg: #edf9f0;
		}
		body {
			margin: 0;
			padding: 24px;
			background: linear-gradient(180deg, #eef2f9 0%, var(--bg) 100%);
			color: var(--text);
		}
		.card {
			max-width: 860px;
			margin: 0 auto;
			background: var(--panel);
			border: 1px solid var(--border);
			border-radius: 18px;
			box-shadow: 0 14px 32px rgba(16, 24, 40, 0.08);
			padding: 24px;
		}
		h1 {
			margin: 0 0 8px;
			font-size: 24px;
		}
		p {
			margin: 0 0 12px;
			color: var(--muted);
			line-height: 1.5;
		}
		.grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
			gap: 12px;
			margin: 18px 0 22px;
		}
		.meta {
			border: 1px solid var(--border);
			border-radius: 12px;
			padding: 12px 14px;
			background: #fbfcff;
		}
		.meta strong {
			display: block;
			font-size: 12px;
			letter-spacing: 0.04em;
			text-transform: uppercase;
			color: var(--muted);
			margin-bottom: 6px;
		}
		.toolbar {
			display: flex;
			flex-wrap: wrap;
			gap: 10px;
			margin: 18px 0;
		}
		button, a.button {
			border: 1px solid var(--accent);
			background: var(--accent);
			color: var(--accentText);
			border-radius: 999px;
			padding: 10px 16px;
			font-size: 14px;
			font-weight: 600;
			cursor: pointer;
			text-decoration: none;
		}
		button.secondary, a.button.secondary {
			background: white;
			color: var(--accent);
		}
		button.danger {
			border-color: #b42318;
			background: #b42318;
		}
		button:disabled {
			opacity: 0.55;
			cursor: wait;
		}
		.status {
			display: inline-flex;
			align-items: center;
			padding: 6px 10px;
			border-radius: 999px;
			font-weight: 600;
			font-size: 13px;
		}
		.status.connected {
			color: var(--ok);
			background: var(--okBg);
		}
		.status.pending, .status.idle {
			color: #7a5a00;
			background: #fff7dd;
		}
		.status.error, .status.needs_reconnect, .status.disconnected {
			color: var(--warn);
			background: var(--warnBg);
		}
		.message {
			margin-top: 10px;
			padding: 12px 14px;
			border-radius: 12px;
			border: 1px solid var(--border);
			background: #fbfcff;
			color: var(--text);
		}
		pre {
			margin: 16px 0 0;
			padding: 14px;
			border-radius: 14px;
			background: #101828;
			color: #d0d5dd;
			font-size: 12px;
			line-height: 1.5;
			white-space: pre-wrap;
			word-break: break-word;
			min-height: 120px;
			max-height: 320px;
			overflow: auto;
		}
		.small {
			font-size: 13px;
		}
		.code-box {
			font-family: Consolas, "Courier New", monospace;
			font-size: 18px;
			font-weight: 700;
			letter-spacing: 0.08em;
		}
	</style>
</head>
<body>
	<div class="card">
		<h1>Codex ChatGPT Account</h1>
		<p>
			이 credential을 전용 Codex ChatGPT 로그인에 연결합니다. 기본 경로는 Device Code입니다.
			그 방식이 깔끔하게 끝나지 않을 때만 이 컴퓨터에서 브라우저를 여는 로컬 브라우저 방식을 사용하세요.
		</p>
		<div class="grid">
			<div class="meta"><strong>상태</strong><span id="statusBadge" class="status">불러오는 중</span></div>
			<div class="meta"><strong>프로필 키</strong><span id="profileKey">${escapeHtml(
				session.profileKey || "처음 연결할 때 생성됩니다",
			)}</span></div>
			<div class="meta"><strong>Codex ID</strong><span id="accountHint">-</span></div>
			<div class="meta"><strong>워크스페이스</strong><span id="workspaceHint">-</span></div>
			<div class="meta"><strong>로그인 방식</strong><span id="loginMethod">-</span></div>
			<div class="meta"><strong>마지막 로그인</strong><span id="lastLoginAt">-</span></div>
		</div>
		<div class="toolbar">
			<button id="deviceBtn" onclick="runAction('device')">Device Code로 연결</button>
			<button id="browserBtn" class="secondary" onclick="runAction('browser')">서버 브라우저에서 연결 (Admin)</button>
			<button id="refreshBtn" class="secondary" onclick="runAction('refresh')">상태 새로고침</button>
			<button id="disconnectBtn" class="secondary" onclick="runAction('disconnect')">연결 해제</button>
			<button id="purgeBtn" class="danger" onclick="runAction('purge')">인증 캐시 비우기</button>
		</div>
		<div class="message">
			<div id="messageText">${escapeHtml(session.message)}</div>
			<div id="deviceInfo" class="small" style="margin-top:10px; display:none;">
				<div><strong>인증 URL</strong>: <a id="verificationUrl" target="_blank" rel="noreferrer"></a></div>
				<div style="margin-top:6px;"><strong>사용자 코드</strong>: <span id="userCode" class="code-box"></span></div>
			</div>
		</div>
		<pre id="logOutput">업데이트를 기다리는 중...</pre>
	</div>
	<script>
		const state = ${JSON.stringify(session.state)};
		let redirecting = false;
		let busy = false;
		const initialState = ${JSON.stringify(sessionToClient(session))};

		function setBusy(nextBusy) {
			busy = nextBusy;
			for (const id of ['deviceBtn', 'browserBtn', 'refreshBtn', 'disconnectBtn', 'purgeBtn']) {
				document.getElementById(id).disabled = nextBusy;
			}
		}

		function statusClass(status) {
			return ['status', status || 'disconnected'].join(' ');
		}

		function formatValue(value, fallback = '-') {
			return value && String(value).trim() ? value : fallback;
		}

		function formatCodexId(data) {
			const email = String(data.email || '').trim();
			if (email.includes('@')) {
				return email.split('@')[0];
			}
			return formatValue(data.accountHint || email);
		}

		function render(data) {
			document.getElementById('statusBadge').className = statusClass(data.status);
			document.getElementById('statusBadge').textContent = formatValue(data.status, 'unknown');
			document.getElementById('profileKey').textContent = formatValue(data.profileKey, '처음 연결할 때 생성됩니다');
			document.getElementById('accountHint').textContent = formatCodexId(data);
			document.getElementById('workspaceHint').textContent = formatValue(data.workspaceHint);
			document.getElementById('loginMethod').textContent = formatValue(data.loginMethod);
			document.getElementById('lastLoginAt').textContent = formatValue(data.lastLoginAt);
			document.getElementById('messageText').textContent = formatValue(data.message, 'Waiting for updates...');

			const hasDeviceData = Boolean(data.verificationUrl || data.userCode);
			const deviceInfo = document.getElementById('deviceInfo');
			deviceInfo.style.display = hasDeviceData ? 'block' : 'none';
			document.getElementById('verificationUrl').textContent = data.verificationUrl || '';
			document.getElementById('verificationUrl').href = data.verificationUrl || '#';
			document.getElementById('userCode').textContent = data.userCode || '';
			document.getElementById('logOutput').textContent = (data.logs && data.logs.length ? data.logs.join('\\n') : '업데이트를 기다리는 중...');

			if (data.callbackUrl && !redirecting) {
				redirecting = true;
				window.location.href = data.callbackUrl;
			}
		}

		async function fetchState() {
			const response = await fetch('/oauth/session?state=' + encodeURIComponent(state), {
				cache: 'no-store',
			});
			if (!response.ok) {
				throw new Error('현재 상태를 불러오지 못했습니다.');
			}
			const data = await response.json();
			render(data);
			if (!redirecting) {
				window.setTimeout(fetchState, data.currentlyRunning ? 1500 : 3000);
			}
		}

		async function runAction(action) {
			if (busy || redirecting) return;
			setBusy(true);
			try {
				const endpoint = {
					device: '/oauth/device/start',
					browser: '/oauth/browser/start',
					refresh: '/oauth/refresh',
					disconnect: '/oauth/disconnect',
					purge: '/oauth/purge',
				}[action];
				const response = await fetch(endpoint, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
					},
					body: JSON.stringify({ state }),
				});
				const data = await response.json();
				if (!response.ok) {
					throw new Error(data.message || data.error || '요청에 실패했습니다.');
				}
				render(data);
			} catch (error) {
				document.getElementById('messageText').textContent = error.message;
			} finally {
				setBusy(false);
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
