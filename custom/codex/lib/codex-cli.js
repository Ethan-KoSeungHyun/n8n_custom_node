"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const WORKSPACE_CODEX_HOME_SEGMENTS = ["data", "codex-home"];

function ensureObject(value, label) {
	if (value === null || Array.isArray(value) || typeof value !== "object") {
		throw new Error(`${label} must be a JSON object`);
	}

	return value;
}

function parseOptionalJsonObject(rawValue, label) {
	if (rawValue === undefined || rawValue === null || rawValue === "") {
		return {};
	}

	let parsed;
	try {
		parsed = JSON.parse(rawValue);
	} catch (error) {
		throw new Error(`${label} must be valid JSON: ${error.message}`);
	}

	return ensureObject(parsed, label);
}

function parseOptionalJsonArray(rawValue, label) {
	if (rawValue === undefined || rawValue === null || rawValue === "") {
		return [];
	}

	let parsed;
	try {
		parsed = JSON.parse(rawValue);
	} catch (error) {
		throw new Error(`${label} must be valid JSON: ${error.message}`);
	}

	if (!Array.isArray(parsed)) {
		throw new Error(`${label} must be a JSON array`);
	}

	return parsed;
}

function parseStringList(rawValue) {
	if (!rawValue) {
		return [];
	}

	return String(rawValue)
		.split(/\r?\n|,/)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function resolvePathMaybeRelative(baseDir, targetPath) {
	if (!targetPath) {
		return "";
	}

	return path.isAbsolute(targetPath)
		? targetPath
		: path.resolve(baseDir, targetPath);
}

function resolveCodexHome({ scope, customPath, workspaceRoot }) {
	if (scope === "systemDefault") {
		return "";
	}

	if (scope === "customPath") {
		return resolvePathMaybeRelative(workspaceRoot, customPath);
	}

	return path.join(workspaceRoot, ...WORKSPACE_CODEX_HOME_SEGMENTS);
}

async function ensureDirectory(directoryPath) {
	if (!directoryPath) {
		return;
	}

	await fsp.mkdir(directoryPath, { recursive: true });
}

function resolveCodexExecutable(customExecutable) {
	const candidates = [];

	if (customExecutable) {
		candidates.push(customExecutable);
	}

	if (process.env.APPDATA) {
		candidates.push(path.join(process.env.APPDATA, "npm", "codex.cmd"));
		candidates.push(path.join(process.env.APPDATA, "npm", "codex.exe"));
	}

	candidates.push("codex.cmd");
	candidates.push("codex");

	for (const candidate of candidates) {
		if (!candidate) {
			continue;
		}

		if (path.isAbsolute(candidate)) {
			if (fs.existsSync(candidate)) {
				return candidate;
			}
			continue;
		}

		return candidate;
	}

	return "codex";
}

function buildCommandError(executable, args, code, stdout, stderr) {
	const detail = stderr?.trim() || stdout?.trim() || "Unknown Codex CLI error";
	const error = new Error(
		`Codex CLI failed with exit code ${code ?? "unknown"}: ${detail}`,
	);
	error.details = {
		executable,
		args,
		exitCode: code,
		stdout,
		stderr,
	};
	return error;
}

function resolveSpawnCommand(executable, args) {
	const extension = path.extname(executable).toLowerCase();

	if (process.platform === "win32" && [".cmd", ".bat"].includes(extension)) {
		return {
			command: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
			args: ["/d", "/s", "/c", executable, ...args],
		};
	}

	return {
		command: executable,
		args,
	};
}

async function runCodexCommand({
	executable,
	args,
	stdin,
	cwd,
	env,
	allowedExitCodes = [],
}) {
	return await new Promise((resolve, reject) => {
		const spawnCommand = resolveSpawnCommand(executable, args);
		const child = spawn(spawnCommand.command, spawnCommand.args, {
			cwd,
			env,
			windowsHide: true,
			stdio: "pipe",
		});

		let stdout = "";
		let stderr = "";

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");

		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});

		child.on("error", (error) => {
			reject(error);
		});

		child.on("close", (code) => {
			if (code !== 0 && !allowedExitCodes.includes(code)) {
				reject(
					buildCommandError(
						spawnCommand.command,
						spawnCommand.args,
						code,
						stdout,
						stderr,
					),
				);
				return;
			}

			resolve({
				code: code ?? 0,
				stdout,
				stderr,
				executable: spawnCommand.command,
				args: spawnCommand.args,
			});
		});

		if (stdin !== undefined && stdin !== null) {
			child.stdin.write(stdin);
		}

		child.stdin.end();
	});
}

function parseJsonOutput(rawValue, label) {
	const trimmed = (rawValue || "").trim();
	if (!trimmed) {
		return null;
	}

	try {
		return JSON.parse(trimmed);
	} catch (error) {
		throw new Error(`${label} is not valid JSON: ${error.message}`);
	}
}

function parseJsonLines(rawValue) {
	const lines = String(rawValue || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	return lines.map((line, index) => {
		try {
			return JSON.parse(line);
		} catch (error) {
			throw new Error(
				`Failed to parse Codex JSONL output on line ${index + 1}: ${error.message}`,
			);
		}
	});
}

function extractExecSummary(events) {
	let threadId = "";
	let finalResponse = "";
	let usage = null;
	const agentMessages = [];
	const items = [];

	for (const event of events) {
		if (event?.type === "thread.started" && typeof event.thread_id === "string") {
			threadId = event.thread_id;
		}

		if (event?.type === "item.completed" && event.item) {
			items.push(event.item);
			if (
				event.item.type === "agent_message" &&
				typeof event.item.text === "string"
			) {
				finalResponse = event.item.text;
				agentMessages.push(event.item.text);
			}
		}

		if (event?.type === "turn.completed" && event.usage) {
			usage = event.usage;
		}
	}

	return {
		threadId,
		finalResponse,
		agentMessages,
		items,
		usage,
	};
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeConfigOverrides(configOverrides) {
	const overrides = [];
	flattenConfigOverrides(configOverrides, "", overrides);
	return overrides;
}

function flattenConfigOverrides(value, prefix, overrides) {
	if (!isPlainObject(value)) {
		if (!prefix) {
			throw new Error("Codex config overrides must be a plain object");
		}

		overrides.push(`${prefix}=${toTomlValue(value, prefix)}`);
		return;
	}

	const entries = Object.entries(value);

	if (!prefix && entries.length === 0) {
		return;
	}

	if (prefix && entries.length === 0) {
		overrides.push(`${prefix}={}`);
		return;
	}

	for (const [key, childValue] of entries) {
		if (!key) {
			throw new Error("Codex config override keys must be non-empty");
		}

		if (childValue === undefined) {
			continue;
		}

		const childPath = prefix ? `${prefix}.${key}` : key;

		if (isPlainObject(childValue)) {
			flattenConfigOverrides(childValue, childPath, overrides);
		} else {
			overrides.push(`${childPath}=${toTomlValue(childValue, childPath)}`);
		}
	}
}

function toTomlValue(value, keyPath) {
	if (typeof value === "string") {
		return JSON.stringify(value);
	}

	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`Config value at ${keyPath} must be a finite number`);
		}

		return `${value}`;
	}

	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}

	if (Array.isArray(value)) {
		return `[${value
			.map((entry, index) => toTomlValue(entry, `${keyPath}[${index}]`))
			.join(", ")}]`;
	}

	if (isPlainObject(value)) {
		const entries = Object.entries(value)
			.filter(([, entryValue]) => entryValue !== undefined)
			.map(
				([entryKey, entryValue]) =>
					`${formatTomlKey(entryKey)} = ${toTomlValue(
						entryValue,
						`${keyPath}.${entryKey}`,
					)}`,
			);

		return `{${entries.join(", ")}}`;
	}

	if (value === null) {
		throw new Error(`Config value at ${keyPath} cannot be null`);
	}

	throw new Error(
		`Unsupported config override type at ${keyPath}: ${typeof value}`,
	);
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

function formatTomlKey(key) {
	return TOML_BARE_KEY.test(key) ? key : JSON.stringify(key);
}

function setConfigValue(config, key, value) {
	if (value === undefined || value === null || value === "") {
		return;
	}

	config[key] = value;
}

async function writeJsonFile(directoryPath, prefix, payload) {
	await ensureDirectory(directoryPath);

	const filePath = path.join(
		directoryPath,
		`${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
	);

	await fsp.writeFile(filePath, payload, "utf8");
	return filePath;
}

module.exports = {
	ensureDirectory,
	extractExecSummary,
	parseJsonLines,
	parseJsonOutput,
	parseOptionalJsonArray,
	parseOptionalJsonObject,
	parseStringList,
	resolveCodexExecutable,
	resolveCodexHome,
	resolvePathMaybeRelative,
	runCodexCommand,
	serializeConfigOverrides,
	setConfigValue,
	writeJsonFile,
};
