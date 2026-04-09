"use strict";

/**
 * Store 모듈 간 공유 유틸리티.
 * 4개 store 파일(codex-store, codex-memory-store, codex-agent-registry-store,
 * codex-agent-message-store)에서 동일하게 사용하는 DB 접근·직렬화·ID 생성 헬퍼를
 * 한 곳에 모아 중복을 제거한다.
 */

const crypto = require("node:crypto");
const { Container } = require("@n8n/di");
const { DataSource } = require("@n8n/typeorm");

// ─── Timestamps & IDs ─────────────────────────────────────────

function nowIso() {
	return new Date().toISOString();
}

function createId() {
	return crypto.randomUUID();
}

// ─── JSON helpers ──────────────────────────────────────────────

function jsonStringify(value) {
	if (value === undefined) return null;
	return JSON.stringify(value);
}

function jsonParse(value, fallback = null) {
	if (!value) return fallback;
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

// ─── DataSource access ────────────────────────────────────────

function getDataSource() {
	const ds = Container.get(DataSource);
	if (!ds || !ds.isInitialized) {
		throw new Error(
			"n8n DataSource is not available yet. Start n8n before executing Codex nodes.",
		);
	}
	return ds;
}

function getDriverKind(ds) {
	const type = String(ds.options?.type || "").toLowerCase();
	return type.includes("postgres") ? "postgres" : "sqlite";
}

/**
 * SQL 파라미터 플레이스홀더를 반환한다.
 * - PostgreSQL: `$1`, `$2`, ...
 * - SQLite: `?`
 */
function ph(driverKind, index) {
	return driverKind === "postgres" ? `$${index}` : "?";
}

module.exports = {
	nowIso,
	createId,
	jsonStringify,
	jsonParse,
	getDataSource,
	getDriverKind,
	ph,
};
