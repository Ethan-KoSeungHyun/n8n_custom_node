"use strict";

const crypto = require("node:crypto");
const { Container } = require("@n8n/di");
const { DataSource } = require("@n8n/typeorm");

const TABLE = "codex_agent_registry";

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
		agentKey: row.agent_key,
		displayName: row.display_name,
		description: row.description,
		capabilities: jsonParse(row.capabilities_json, []),
		defaultModel: row.default_model,
		defaultSystemInstructions: row.default_system_instructions,
		defaultSandbox: row.default_sandbox,
		defaultMcpServers: jsonParse(row.default_mcp_servers_json, []),
		memoryScope: row.memory_scope,
		maxConcurrent: Number(row.max_concurrent ?? 0),
		priority: Number(row.priority ?? 0),
		enabled: Boolean(Number(row.enabled ?? 1)),
		metadata: jsonParse(row.metadata_json, {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

async function ensureRegistrySchema() {
	if (!schemaReady) {
		schemaReady = (async () => {
			const ds = getDataSource();
			await ds.query(`
				CREATE TABLE IF NOT EXISTS ${TABLE} (
					id TEXT PRIMARY KEY,
					agent_key TEXT NOT NULL UNIQUE,
					display_name TEXT NOT NULL,
					description TEXT,
					capabilities_json TEXT,
					default_model TEXT,
					default_system_instructions TEXT,
					default_sandbox TEXT DEFAULT 'workspace-write',
					default_mcp_servers_json TEXT,
					memory_scope TEXT DEFAULT 'agent',
					max_concurrent INTEGER NOT NULL DEFAULT 0,
					priority INTEGER NOT NULL DEFAULT 0,
					enabled INTEGER NOT NULL DEFAULT 1,
					metadata_json TEXT,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
			await ds.query(
				`CREATE INDEX IF NOT EXISTS idx_registry_key ON ${TABLE} (agent_key)`,
			);
			await ds.query(
				`CREATE INDEX IF NOT EXISTS idx_registry_enabled ON ${TABLE} (enabled, priority DESC)`,
			);
		})();
	}
	return schemaReady;
}

// ─── CRUD ───────────────────────────────────────────────────────

async function registerAgent(input) {
	await ensureRegistrySchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);
	const id = createId();
	const now = nowIso();

	const values = [
		id,
		input.agentKey,
		input.displayName,
		input.description || null,
		jsonStringify(input.capabilities || []),
		input.defaultModel || null,
		input.defaultSystemInstructions || null,
		input.defaultSandbox || "workspace-write",
		jsonStringify(input.defaultMcpServers || []),
		input.memoryScope || "agent",
		input.maxConcurrent ?? 0,
		input.priority ?? 0,
		input.enabled !== false ? 1 : 0,
		jsonStringify(input.metadata || {}),
		now,
		now,
	];

	await ds.query(
		`INSERT INTO ${TABLE} (
			id, agent_key, display_name, description, capabilities_json,
			default_model, default_system_instructions, default_sandbox,
			default_mcp_servers_json, memory_scope, max_concurrent, priority,
			enabled, metadata_json, created_at, updated_at
		) VALUES (${values.map((_, i) => ph(dk, i + 1)).join(", ")})`,
		values,
	);
	return getAgentByKey(input.agentKey);
}

async function getAgent(id) {
	await ensureRegistrySchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);
	const rows = await ds.query(
		`SELECT * FROM ${TABLE} WHERE id = ${ph(dk, 1)}`,
		[id],
	);
	return mapRow(rows[0]);
}

async function getAgentByKey(agentKey) {
	await ensureRegistrySchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);
	const rows = await ds.query(
		`SELECT * FROM ${TABLE} WHERE agent_key = ${ph(dk, 1)}`,
		[agentKey],
	);
	return mapRow(rows[0]);
}

async function updateAgent(agentKey, patch) {
	await ensureRegistrySchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);
	const now = nowIso();

	const sets = [];
	const values = [];
	let idx = 1;

	const fieldMap = {
		displayName: "display_name",
		description: "description",
		defaultModel: "default_model",
		defaultSystemInstructions: "default_system_instructions",
		defaultSandbox: "default_sandbox",
		memoryScope: "memory_scope",
		maxConcurrent: "max_concurrent",
		priority: "priority",
	};

	for (const [key, col] of Object.entries(fieldMap)) {
		if (patch[key] !== undefined) {
			sets.push(`${col} = ${ph(dk, idx++)}`);
			values.push(patch[key]);
		}
	}
	if (patch.capabilities !== undefined) {
		sets.push(`capabilities_json = ${ph(dk, idx++)}`);
		values.push(jsonStringify(patch.capabilities));
	}
	if (patch.defaultMcpServers !== undefined) {
		sets.push(`default_mcp_servers_json = ${ph(dk, idx++)}`);
		values.push(jsonStringify(patch.defaultMcpServers));
	}
	if (patch.enabled !== undefined) {
		sets.push(`enabled = ${ph(dk, idx++)}`);
		values.push(patch.enabled ? 1 : 0);
	}
	if (patch.metadata !== undefined) {
		sets.push(`metadata_json = ${ph(dk, idx++)}`);
		values.push(jsonStringify(patch.metadata));
	}

	if (sets.length === 0) return getAgentByKey(agentKey);

	sets.push(`updated_at = ${ph(dk, idx++)}`);
	values.push(now);
	values.push(agentKey);

	await ds.query(
		`UPDATE ${TABLE} SET ${sets.join(", ")} WHERE agent_key = ${ph(dk, idx)}`,
		values,
	);
	return getAgentByKey(agentKey);
}

async function deleteAgent(agentKey) {
	await ensureRegistrySchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);
	await ds.query(
		`DELETE FROM ${TABLE} WHERE agent_key = ${ph(dk, 1)}`,
		[agentKey],
	);
}

async function listAgents(filters = {}) {
	await ensureRegistrySchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);

	const where = [];
	const values = [];
	let idx = 1;

	if (filters.enabled !== undefined) {
		where.push(`enabled = ${ph(dk, idx++)}`);
		values.push(filters.enabled ? 1 : 0);
	}

	const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const rows = await ds.query(
		`SELECT * FROM ${TABLE} ${clause} ORDER BY priority DESC, display_name ASC`,
		values,
	);
	return rows.map(mapRow);
}

// ─── Capability matching ────────────────────────────────────────

async function lookupByCapability(capability) {
	const agents = await listAgents({ enabled: true });
	return agents.filter((a) =>
		(a.capabilities || []).some(
			(c) => c.toLowerCase().includes(capability.toLowerCase()),
		),
	);
}

module.exports = {
	registerAgent,
	getAgent,
	getAgentByKey,
	updateAgent,
	deleteAgent,
	listAgents,
	lookupByCapability,
	ensureRegistrySchema,
};
