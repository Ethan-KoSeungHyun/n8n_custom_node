"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ensureDirectory } = require("./codex-utils");

const PROFILE_ROOT_SEGMENTS = ["data", "codex-profiles"];
const REQUIRED_CONFIG_VALUES = {
	cli_auth_credentials_store: '"file"',
	forced_login_method: '"chatgpt"',
};
const DEFAULT_STATUS_TIMEOUT_MS = 10_000;
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365;

function sanitizeProfileKey(value) {
	const normalized = String(value || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");

	return normalized || "";
}

function createProfileKey(prefix = "codex-profile") {
	const safePrefix = sanitizeProfileKey(prefix) || "codex-profile";
	return `${safePrefix}-${Date.now().toString(36)}-${crypto
		.randomBytes(4)
		.toString("hex")}`;
}

function deriveProfileKeyFromIdentity({ email, fallbackPrefix } = {}) {
	const emailLocalPart = String(email || "")
		.split("@")[0]
		.trim();
	return (
		sanitizeProfileKey(emailLocalPart) ||
		sanitizeProfileKey(fallbackPrefix) ||
		""
	);
}

function getProfilesRoot(workspaceRoot = process.cwd()) {
	return path.join(workspaceRoot, ...PROFILE_ROOT_SEGMENTS);
}

function getProfileRoot(profileKey, workspaceRoot = process.cwd()) {
	return path.join(getProfilesRoot(workspaceRoot), sanitizeProfileKey(profileKey));
}

function getProfileCodexHome(profileKey, workspaceRoot = process.cwd()) {
	return path.join(getProfileRoot(profileKey, workspaceRoot), "codex-home");
}

function getProfileAuthPath(profileKey, workspaceRoot = process.cwd()) {
	return path.join(getProfileCodexHome(profileKey, workspaceRoot), "auth.json");
}

function getProfileConfigPath(profileKey, workspaceRoot = process.cwd()) {
	return path.join(getProfileCodexHome(profileKey, workspaceRoot), "config.toml");
}

function getProfileMetadataPath(profileKey, workspaceRoot = process.cwd()) {
	return path.join(getProfileRoot(profileKey, workspaceRoot), "profile.json");
}

async function ensureProfileStructure(profileKey, workspaceRoot = process.cwd()) {
	const normalizedProfileKey = sanitizeProfileKey(profileKey);
	if (!normalizedProfileKey) {
		throw new Error("Profile key is required.");
	}

	const profileRoot = getProfileRoot(normalizedProfileKey, workspaceRoot);
	const codexHome = getProfileCodexHome(normalizedProfileKey, workspaceRoot);
	await ensureDirectory(profileRoot);
	await ensureDirectory(codexHome);
	await ensureProfileConfig(normalizedProfileKey, workspaceRoot);

	return {
		profileKey: normalizedProfileKey,
		profileRoot,
		codexHome,
		authPath: getProfileAuthPath(normalizedProfileKey, workspaceRoot),
		configPath: getProfileConfigPath(normalizedProfileKey, workspaceRoot),
		metadataPath: getProfileMetadataPath(normalizedProfileKey, workspaceRoot),
	};
}

async function renameProfileKey(profileKey, nextProfileKey, workspaceRoot = process.cwd()) {
	const currentKey = sanitizeProfileKey(profileKey);
	const desiredKey = sanitizeProfileKey(nextProfileKey);
	if (!currentKey || !desiredKey || currentKey === desiredKey) {
		return currentKey || desiredKey || "";
	}

	const currentRoot = getProfileRoot(currentKey, workspaceRoot);
	const resolvedKey = desiredKey;
	const destinationRoot = getProfileRoot(resolvedKey, workspaceRoot);

	if (destinationRoot === currentRoot) {
		return currentKey;
	}

	if (fs.existsSync(destinationRoot)) {
		await fsp.rm(destinationRoot, { recursive: true, force: true });
	}

	await ensureDirectory(path.dirname(destinationRoot));
	await fsp.rename(currentRoot, destinationRoot);
	return resolvedKey;
}

async function ensureProfileConfig(profileKey, workspaceRoot = process.cwd()) {
	const configPath = getProfileConfigPath(profileKey, workspaceRoot);
	let existingText = "";
	try {
		existingText = await fsp.readFile(configPath, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}

	const normalizedText = String(existingText)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
	const lines = normalizedText
		.split("\n")
		.filter((line) => line.trim() !== "");

	for (const [key, literalValue] of Object.entries(REQUIRED_CONFIG_VALUES)) {
		const line = `${key} = ${literalValue}`;
		const existingIndex = lines.findIndex((entry) =>
			new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(entry),
		);
		if (existingIndex >= 0) {
			lines[existingIndex] = line;
		} else {
			lines.push(line);
		}
	}

	const nextText = `${lines.join("\n").trimEnd()}\n`;

	if (nextText !== existingText) {
		await ensureDirectory(path.dirname(configPath));
		await fsp.writeFile(configPath, nextText, "utf8");
	}

	return configPath;
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveCodexExecutable(codexExecutable) {
	const resolved = (
		String(
			codexExecutable ||
				process.env.CODEX_BINARY_PATH ||
				process.env.CODEX_EXECUTABLE_PATH ||
				"codex",
		).trim() || "codex"
	);
	if (/[;&|`$(){}]/.test(resolved)) {
		throw new Error(
			`Codex 실행 파일 경로에 허용되지 않는 문자가 포함되어 있습니다: "${resolved}"`,
		);
	}
	return resolved;
}

function shouldUseShellForCommand(command) {
	if (process.platform !== "win32") return false;
	const extension = path.extname(String(command || "")).toLowerCase();
	return extension === "" || extension === ".cmd" || extension === ".bat";
}

function spawnCodexCommand({
	args,
	codexExecutable,
	env,
	cwd,
	stdio = "pipe",
}) {
	const command = resolveCodexExecutable(codexExecutable);
	return spawn(command, args, {
		cwd: cwd || process.cwd(),
		env: {
			...process.env,
			...env,
		},
		stdio,
		shell: shouldUseShellForCommand(command),
		windowsHide: true,
	});
}

async function runCodexCommand({
	args,
	codexExecutable,
	env,
	cwd,
	timeoutMs = DEFAULT_STATUS_TIMEOUT_MS,
}) {
	return await new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let finished = false;
		let timedOut = false;
		let timeoutHandle;

		let child;
		try {
			child = spawnCodexCommand({
				args,
				codexExecutable,
				env,
				cwd,
				stdio: "pipe",
			});
		} catch (error) {
			reject(error);
			return;
		}

		const finish = (result) => {
			if (finished) return;
			finished = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			resolve(result);
		};

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (exitCode, signal) => {
			finish({
				exitCode,
				signal,
				stdout,
				stderr,
				timedOut,
			});
		});

		if (timeoutMs > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				child.kill();
			}, timeoutMs);
		}
	});
}

async function readJsonFile(filePath) {
	try {
		return JSON.parse(await fsp.readFile(filePath, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

function decodeJwtPayload(token) {
	if (!token || typeof token !== "string") return null;
	const parts = token.split(".");
	if (parts.length < 2) return null;

	try {
		const payload = parts[1]
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
		return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
	} catch {
		return null;
	}
}

function computeFingerprint(input) {
	return crypto.createHash("sha256").update(String(input || "")).digest("hex");
}

async function computeFileFingerprint(filePath) {
	try {
		const content = await fsp.readFile(filePath);
		return computeFingerprint(content);
	} catch (error) {
		if (error.code === "ENOENT") return "";
		throw error;
	}
}

function deriveAccountHints(authData) {
	const idTokenPayload = decodeJwtPayload(authData?.tokens?.id_token);
	const accessTokenPayload = decodeJwtPayload(authData?.tokens?.access_token);
	const authClaims =
		idTokenPayload?.["https://api.openai.com/auth"] ||
		accessTokenPayload?.["https://api.openai.com/auth"] ||
		{};
	const profileClaims =
		accessTokenPayload?.["https://api.openai.com/profile"] || {};
	const organizations = Array.isArray(authClaims.organizations)
		? authClaims.organizations
		: [];
	const defaultOrganization =
		organizations.find((entry) => entry && entry.is_default) || organizations[0] || null;
	const email =
		profileClaims.email || idTokenPayload?.email || authClaims.email || "";
	const accountId =
		authData?.tokens?.account_id ||
		authClaims.chatgpt_account_id ||
		authClaims.account_id ||
		"";

	return {
		email,
		displayName: idTokenPayload?.name || "",
		accountId,
		accountHint: email || shortenIdentifier(accountId),
		workspaceHint: defaultOrganization?.title || "",
		planType: authClaims.chatgpt_plan_type || "",
		userId: authClaims.chatgpt_user_id || authClaims.user_id || "",
	};
}

function shortenIdentifier(value) {
	const text = String(value || "").trim();
	if (!text) return "";
	if (text.length <= 12) return text;
	return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

async function readProfileState({
	profileKey,
	workspaceRoot = process.cwd(),
	codexExecutable,
}) {
	const normalizedProfileKey = sanitizeProfileKey(profileKey);
	if (!normalizedProfileKey) {
		return createDisconnectedState({ workspaceRoot });
	}

	const structure = await ensureProfileStructure(normalizedProfileKey, workspaceRoot);
	const authData = await readJsonFile(structure.authPath);
	const authFingerprint = await computeFileFingerprint(structure.authPath);
	const hints = authData ? deriveAccountHints(authData) : {};
	const env = {
		CODEX_HOME: structure.codexHome,
	};

	let statusOutput = "";
	let statusError = "";
	let timedOut = false;
	let exitCode = null;

	try {
		const result = await runCodexCommand({
			args: ["login", "status"],
			codexExecutable,
			env,
			cwd: structure.profileRoot,
		});
		statusOutput = String(result.stdout || "").trim();
		statusError = String(result.stderr || "").trim();
		timedOut = Boolean(result.timedOut);
		exitCode = result.exitCode;
	} catch (error) {
		statusError = error.message;
	}

	const combinedStatusText = [statusOutput, statusError].filter(Boolean).join("\n");
	let status = "disconnected";
	// "Not logged in" 도 /logged in/i 에 매칭되므로 부정 문구를 먼저 걸러냄
	const hasLoggedIn = /logged in/i.test(combinedStatusText) && !/not logged in/i.test(combinedStatusText);
	if (hasLoggedIn) {
		status = "connected";
	} else if (authData) {
		status = timedOut ? "needs_reconnect" : "needs_reconnect";
	}

	return {
		status,
		connected: status === "connected",
		profileKey: normalizedProfileKey,
		profileRoot: structure.profileRoot,
		codexHome: structure.codexHome,
		authPath: structure.authPath,
		authFingerprint,
		hasAuthFile: Boolean(authData),
		lastLoginAt:
			authData?.last_refresh ||
			(readStatIso(structure.authPath) || readStatIso(structure.configPath)),
		lastRefreshAt: authData?.last_refresh || "",
		authMode: authData?.auth_mode || "",
		accountHint: hints.accountHint || "",
		accountId: hints.accountId || "",
		email: hints.email || "",
		displayName: hints.displayName || "",
		workspaceHint: hints.workspaceHint || "",
		planType: hints.planType || "",
		userId: hints.userId || "",
		message:
			combinedStatusText ||
			(status === "connected"
				? "연결됨"
				: "이 프로필에는 아직 Codex 로그인이 없습니다."),
		exitCode,
	};
}

function createDisconnectedState({ workspaceRoot = process.cwd() } = {}) {
	return {
		status: "disconnected",
		connected: false,
		profileKey: "",
		profileRoot: "",
		codexHome: "",
		authPath: "",
		authFingerprint: "",
		hasAuthFile: false,
		lastLoginAt: "",
		lastRefreshAt: "",
		authMode: "",
		accountHint: "",
		accountId: "",
		email: "",
		displayName: "",
		workspaceHint: "",
		planType: "",
		userId: "",
		message: "이 credential에는 아직 연결된 Codex 계정이 없습니다.",
		workspaceRoot,
		exitCode: null,
	};
}

function readStatIso(filePath) {
	try {
		return fs.statSync(filePath).mtime.toISOString();
	} catch {
		return "";
	}
}

async function disconnectProfile({
	profileKey,
	workspaceRoot = process.cwd(),
	codexExecutable,
}) {
	const normalizedProfileKey = sanitizeProfileKey(profileKey);
	if (!normalizedProfileKey) {
		return createDisconnectedState({ workspaceRoot });
	}

	const structure = await ensureProfileStructure(normalizedProfileKey, workspaceRoot);
	const env = {
		CODEX_HOME: structure.codexHome,
	};

	try {
		await runCodexCommand({
			args: ["logout"],
			codexExecutable,
			env,
			cwd: structure.profileRoot,
		});
	} catch {}

	// auth.json을 삭제해서 status가 정확히 disconnected로 반영되도록 함
	// (codex logout만으로는 로컬 캐시가 남아 status가 여전히 connected로 표시되는 버그 방지)
	try {
		await fsp.rm(structure.authPath, { force: true });
	} catch {}

	return await readProfileState({
		profileKey: normalizedProfileKey,
		workspaceRoot,
		codexExecutable,
	});
}

async function purgeProfileAuthCache({
	profileKey,
	workspaceRoot = process.cwd(),
	codexExecutable,
}) {
	const normalizedProfileKey = sanitizeProfileKey(profileKey);
	if (!normalizedProfileKey) {
		return createDisconnectedState({ workspaceRoot });
	}

	await disconnectProfile({
		profileKey: normalizedProfileKey,
		workspaceRoot,
		codexExecutable,
	});

	const codexHome = getProfileCodexHome(normalizedProfileKey, workspaceRoot);
	const removableEntries = [
		path.join(codexHome, "auth.json"),
		path.join(codexHome, "cache"),
		path.join(codexHome, ".tmp"),
		path.join(codexHome, "tmp"),
	];

	for (const targetPath of removableEntries) {
		await fsp.rm(targetPath, { recursive: true, force: true });
	}

	return await readProfileState({
		profileKey: normalizedProfileKey,
		workspaceRoot,
		codexExecutable,
	});
}

function buildOauthTokenData(profileState, overrides = {}) {
	const connected = Boolean(overrides.connected ?? profileState.connected);
	const profileKey = sanitizeProfileKey(
		overrides.profileKey || profileState.profileKey || "",
	);
	return {
		access_token: connected ? `codex-local-${profileKey}` : "",
		refresh_token: connected ? `codex-local-refresh-${profileKey}` : "",
		token_type: "bearer",
		expires_in: DEFAULT_TOKEN_TTL_SECONDS,
		profile_key: profileKey,
		status: overrides.status || profileState.status || "disconnected",
		auth_fingerprint:
			overrides.authFingerprint ?? profileState.authFingerprint ?? "",
		last_login_method:
			overrides.lastLoginMethod || profileState.lastLoginMethod || "",
		last_login_at: overrides.lastLoginAt || profileState.lastLoginAt || "",
		account_hint: overrides.accountHint || profileState.accountHint || "",
		account_id: overrides.accountId || profileState.accountId || "",
		email: overrides.email || profileState.email || "",
		display_name: overrides.displayName || profileState.displayName || "",
		workspace_hint:
			overrides.workspaceHint || profileState.workspaceHint || "",
		plan_type: overrides.planType || profileState.planType || "",
		codex_home: overrides.codexHome || profileState.codexHome || "",
		message: overrides.message || profileState.message || "",
	};
}

module.exports = {
	DEFAULT_STATUS_TIMEOUT_MS,
	PROFILE_ROOT_SEGMENTS,
	buildOauthTokenData,
	createDisconnectedState,
	createProfileKey,
	deriveProfileKeyFromIdentity,
	disconnectProfile,
	ensureProfileConfig,
	ensureProfileStructure,
	getProfileAuthPath,
	getProfileCodexHome,
	getProfileConfigPath,
	getProfileMetadataPath,
	getProfileRoot,
	getProfilesRoot,
	purgeProfileAuthCache,
	readProfileState,
	renameProfileKey,
	resolveCodexExecutable,
	runCodexCommand,
	sanitizeProfileKey,
	spawnCodexCommand,
};
