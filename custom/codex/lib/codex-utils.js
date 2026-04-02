"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const WORKSPACE_CODEX_HOME_SEGMENTS = ["data", "codex-home"];
const DEFAULT_CODEX_HOME_DIRNAME = ".codex";

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

function resolveSystemCodexHome() {
	return path.join(os.homedir(), DEFAULT_CODEX_HOME_DIRNAME);
}

async function ensureDirectory(directoryPath) {
	if (!directoryPath) {
		return;
	}

	await fsp.mkdir(directoryPath, { recursive: true });
}

async function syncSavedAuthToCodexHome(codexHome) {
	if (!codexHome) return false;

	const sourcePath = path.join(resolveSystemCodexHome(), "auth.json");
	const targetPath = path.join(codexHome, "auth.json");

	if (sourcePath === targetPath) return false;
	if (!fs.existsSync(sourcePath)) return false;
	if (fs.existsSync(targetPath)) return false;

	let sourceContent = "";
	try {
		sourceContent = await fsp.readFile(sourcePath, "utf8");
	} catch {
		return false;
	}

	await ensureDirectory(codexHome);
	await fsp.writeFile(targetPath, sourceContent, { mode: 0o600 });
	return true;
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

function setConfigValue(config, key, value) {
	if (value === undefined || value === null || value === "") {
		return;
	}

	config[key] = value;
}

module.exports = {
	ensureDirectory,
	parseJsonOutput,
	parseOptionalJsonArray,
	parseOptionalJsonObject,
	parseStringList,
	resolveCodexHome,
	resolvePathMaybeRelative,
	resolveSystemCodexHome,
	setConfigValue,
	syncSavedAuthToCodexHome,
};
