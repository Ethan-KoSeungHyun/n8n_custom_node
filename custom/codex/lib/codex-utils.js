"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

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

async function ensureDirectory(directoryPath) {
	if (!directoryPath) {
		return;
	}

	await fsp.mkdir(directoryPath, { recursive: true });
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
	resolvePathMaybeRelative,
	setConfigValue,
};
