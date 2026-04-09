"use strict";

const crypto = require("node:crypto");
const { Container } = require("@n8n/di");
const { DataSource } = require("@n8n/typeorm");

const TABLE = "codex_agent_messages";

let schemaReady;

function nowIso() {
	return new Date().toISOString();
}

function createId() {
	return crypto.randomUUID();
}

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

function getDataSource() {
	const ds = Container.get(DataSource);
	if (!ds || !ds.isInitialized) {
		throw new Error("n8n DataSource is not available.");
	}
	return ds;
}

function getDriverKind(ds) {
	const type = String(ds.options?.type || "").toLowerCase();
	return type.includes("postgres") ? "postgres" : "sqlite";
}

function ph(dk, i) {
	return dk === "postgres" ? `$${i}` : "?";
}

function mapRow(row) {
	if (!row) return null;
	return {
		id: row.id,
		orchestrationId: row.orchestration_id,
		fromAgent: row.from_agent,
		toAgent: row.to_agent,
		messageType: row.message_type,
		content: row.content,
		metadata: jsonParse(row.metadata_json, {}),
		parentMessageId: row.parent_message_id,
		status: row.status,
		createdAt: row.created_at,
	};
}

async function ensureMessageSchema() {
	if (!schemaReady) {
		schemaReady = (async () => {
			const ds = getDataSource();
			await ds.query(`
				CREATE TABLE IF NOT EXISTS ${TABLE} (
					id TEXT PRIMARY KEY,
					orchestration_id TEXT NOT NULL,
					from_agent TEXT NOT NULL,
					to_agent TEXT NOT NULL,
					message_type TEXT NOT NULL DEFAULT 'task',
					content TEXT NOT NULL,
					metadata_json TEXT,
					parent_message_id TEXT,
					status TEXT NOT NULL DEFAULT 'pending',
					created_at TEXT NOT NULL
				)
			`);
			await ds.query(
				`CREATE INDEX IF NOT EXISTS idx_msg_orch ON ${TABLE} (orchestration_id, created_at)`,
			);
			await ds.query(
				`CREATE INDEX IF NOT EXISTS idx_msg_to ON ${TABLE} (to_agent, status)`,
			);
			await ds.query(
				`CREATE INDEX IF NOT EXISTS idx_msg_from ON ${TABLE} (from_agent, orchestration_id)`,
			);
		})();
	}
	return schemaReady;
}

// ─── Send ──────────────────────────────────────────────────────

async function sendMessage(input) {
	await ensureMessageSchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);
	const id = createId();
	const now = nowIso();

	const values = [
		id,
		input.orchestrationId,
		input.fromAgent,
		input.toAgent,
		input.messageType || "task",
		input.content,
		jsonStringify(input.metadata || {}),
		input.parentMessageId || null,
		input.status || "pending",
		now,
	];

	await ds.query(
		`INSERT INTO ${TABLE} (
			id, orchestration_id, from_agent, to_agent, message_type,
			content, metadata_json, parent_message_id, status, created_at
		) VALUES (${values.map((_, i) => ph(dk, i + 1)).join(", ")})`,
		values,
	);
	return { id, createdAt: now };
}

// ─── Read ──────────────────────────────────────────────────────

async function getMessage(id) {
	await ensureMessageSchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);
	const rows = await ds.query(
		`SELECT * FROM ${TABLE} WHERE id = ${ph(dk, 1)}`,
		[id],
	);
	return mapRow(rows[0]);
}

async function getOrchestrationMessages(orchestrationId, filters = {}) {
	await ensureMessageSchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);

	const where = [`orchestration_id = ${ph(dk, 1)}`];
	const values = [orchestrationId];
	let idx = 2;

	if (filters.messageType) {
		where.push(`message_type = ${ph(dk, idx++)}`);
		values.push(filters.messageType);
	}
	if (filters.fromAgent) {
		where.push(`from_agent = ${ph(dk, idx++)}`);
		values.push(filters.fromAgent);
	}
	if (filters.toAgent) {
		where.push(`to_agent = ${ph(dk, idx++)}`);
		values.push(filters.toAgent);
	}
	if (filters.status) {
		where.push(`status = ${ph(dk, idx++)}`);
		values.push(filters.status);
	}

	const rows = await ds.query(
		`SELECT * FROM ${TABLE} WHERE ${where.join(" AND ")} ORDER BY created_at ASC`,
		values,
	);
	return rows.map(mapRow);
}

async function getAgentInbox(agentKey, filters = {}) {
	await ensureMessageSchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);

	const where = [`to_agent = ${ph(dk, 1)}`];
	const values = [agentKey];
	let idx = 2;

	if (filters.orchestrationId) {
		where.push(`orchestration_id = ${ph(dk, idx++)}`);
		values.push(filters.orchestrationId);
	}
	if (filters.status) {
		where.push(`status = ${ph(dk, idx++)}`);
		values.push(filters.status);
	}
	if (filters.messageType) {
		where.push(`message_type = ${ph(dk, idx++)}`);
		values.push(filters.messageType);
	}

	const limit = filters.limit || 50;
	const rows = await ds.query(
		`SELECT * FROM ${TABLE} WHERE ${where.join(" AND ")}
		 ORDER BY created_at DESC LIMIT ${limit}`,
		values,
	);
	return rows.map(mapRow);
}

// ─── Update status ─────────────────────────────────────────────

async function updateMessageStatus(id, status) {
	await ensureMessageSchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);
	await ds.query(
		`UPDATE ${TABLE} SET status = ${ph(dk, 1)} WHERE id = ${ph(dk, 2)}`,
		[status, id],
	);
	return getMessage(id);
}

async function markDelivered(id) {
	return updateMessageStatus(id, "delivered");
}

async function markProcessed(id) {
	return updateMessageStatus(id, "processed");
}

// ─── Context builder ───────────────────────────────────────────

async function buildSharedContext(orchestrationId, forAgent) {
	const messages = await getOrchestrationMessages(orchestrationId, {
		status: "processed",
	});

	if (messages.length === 0) return "";

	const lines = [];
	for (const msg of messages) {
		if (msg.toAgent === forAgent || msg.fromAgent === forAgent) continue;
		const prefix = `[${msg.fromAgent} → ${msg.toAgent}]`;
		const typeTag = msg.messageType !== "task" ? ` (${msg.messageType})` : "";
		lines.push(`${prefix}${typeTag}: ${msg.content}`);
	}

	if (lines.length === 0) return "";
	return `\n\nOrchestration context (other agents):\n${lines.join("\n")}`;
}

async function buildDelegationContext(orchestrationId, forAgent) {
	const messages = await getOrchestrationMessages(orchestrationId, {
		toAgent: forAgent,
	});

	if (messages.length === 0) return "";

	const lines = messages.map((msg) => {
		const prefix = `[${msg.fromAgent}]`;
		const typeTag = msg.messageType !== "task" ? ` (${msg.messageType})` : "";
		return `${prefix}${typeTag}: ${msg.content}`;
	});

	return `\n\nDelegated instructions:\n${lines.join("\n")}`;
}

// ─── Cleanup ───────────────────────────────────────────────────

async function cleanupOrchestration(orchestrationId) {
	await ensureMessageSchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);
	await ds.query(
		`DELETE FROM ${TABLE} WHERE orchestration_id = ${ph(dk, 1)}`,
		[orchestrationId],
	);
}

module.exports = {
	sendMessage,
	getMessage,
	getOrchestrationMessages,
	getAgentInbox,
	updateMessageStatus,
	markDelivered,
	markProcessed,
	buildSharedContext,
	buildDelegationContext,
	cleanupOrchestration,
	ensureMessageSchema,
};
