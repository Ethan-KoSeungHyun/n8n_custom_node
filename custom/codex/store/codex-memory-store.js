"use strict";

const {
	nowIso,
	createId,
	jsonStringify,
	jsonParse,
	getDataSource,
	getDriverKind,
	ph,
} = require("./codex-store-utils");

const TABLE = "codex_agent_memories";

let schemaReady;

function mapRow(row) {
	if (!row) return null;
	return {
		id: row.id,
		scope: row.scope,
		agentKey: row.agent_key,
		sessionId: row.session_id,
		profileKey: row.profile_key,
		category: row.category,
		content: row.content,
		tags: jsonParse(row.tags_json, []),
		relevanceScore: Number(row.relevance_score ?? 1),
		accessCount: Number(row.access_count ?? 0),
		lastAccessedAt: row.last_accessed_at,
		expiresAt: row.expires_at,
		parentId: row.parent_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

async function ensureMemorySchema() {
	if (!schemaReady) {
		schemaReady = (async () => {
			const ds = getDataSource();
			await ds.query(`
				CREATE TABLE IF NOT EXISTS ${TABLE} (
					id TEXT PRIMARY KEY,
					scope TEXT NOT NULL DEFAULT 'session',
					agent_key TEXT,
					session_id TEXT,
					profile_key TEXT,
					category TEXT NOT NULL DEFAULT 'context',
					content TEXT NOT NULL,
					tags_json TEXT,
					relevance_score REAL NOT NULL DEFAULT 1.0,
					access_count INTEGER NOT NULL DEFAULT 0,
					last_accessed_at TEXT,
					expires_at TEXT,
					parent_id TEXT,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
			await ds.query(
				`CREATE INDEX IF NOT EXISTS idx_mem_scope_agent ON ${TABLE} (scope, agent_key)`,
			);
			await ds.query(
				`CREATE INDEX IF NOT EXISTS idx_mem_session ON ${TABLE} (session_id, scope)`,
			);
			await ds.query(
				`CREATE INDEX IF NOT EXISTS idx_mem_profile ON ${TABLE} (profile_key, scope)`,
			);
			await ds.query(
				`CREATE INDEX IF NOT EXISTS idx_mem_relevance ON ${TABLE} (relevance_score DESC)`,
			);
		})();
	}
	return schemaReady;
}

// ─── CRUD ───────────────────────────────────────────────────────

async function createMemory(input) {
	await ensureMemorySchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);
	const id = createId();
	const now = nowIso();

	const values = [
		id,
		input.scope || "session",
		input.agentKey || null,
		input.sessionId || null,
		input.profileKey || null,
		input.category || "context",
		input.content,
		jsonStringify(input.tags || []),
		input.relevanceScore ?? 1.0,
		0,
		null,
		input.expiresAt || null,
		input.parentId || null,
		now,
		now,
	];
	await ds.query(
		`INSERT INTO ${TABLE} (
			id, scope, agent_key, session_id, profile_key, category, content,
			tags_json, relevance_score, access_count, last_accessed_at,
			expires_at, parent_id, created_at, updated_at
		) VALUES (${values.map((_, i) => ph(dk, i + 1)).join(", ")})`,
		values,
	);
	return { id, createdAt: now };
}

async function getMemory(id) {
	await ensureMemorySchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);
	const rows = await ds.query(
		`SELECT * FROM ${TABLE} WHERE id = ${ph(dk, 1)}`,
		[id],
	);
	return mapRow(rows[0]);
}

async function updateMemory(id, patch) {
	await ensureMemorySchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);
	const now = nowIso();

	const sets = [];
	const values = [];
	let idx = 1;

	if (patch.content !== undefined) {
		sets.push(`content = ${ph(dk, idx++)}`);
		values.push(patch.content);
	}
	if (patch.category !== undefined) {
		sets.push(`category = ${ph(dk, idx++)}`);
		values.push(patch.category);
	}
	if (patch.tags !== undefined) {
		sets.push(`tags_json = ${ph(dk, idx++)}`);
		values.push(jsonStringify(patch.tags));
	}
	if (patch.relevanceScore !== undefined) {
		sets.push(`relevance_score = ${ph(dk, idx++)}`);
		values.push(patch.relevanceScore);
	}
	if (patch.expiresAt !== undefined) {
		sets.push(`expires_at = ${ph(dk, idx++)}`);
		values.push(patch.expiresAt);
	}
	if (patch.scope !== undefined) {
		sets.push(`scope = ${ph(dk, idx++)}`);
		values.push(patch.scope);
	}

	sets.push(`updated_at = ${ph(dk, idx++)}`);
	values.push(now);
	values.push(id);

	await ds.query(
		`UPDATE ${TABLE} SET ${sets.join(", ")} WHERE id = ${ph(dk, idx)}`,
		values,
	);
	return getMemory(id);
}

async function deleteMemory(id) {
	await ensureMemorySchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);
	const result = await ds.query(
		`DELETE FROM ${TABLE} WHERE id = ${ph(dk, 1)}`,
		[id],
	);
	return result;
}

// ─── Query ──────────────────────────────────────────────────────

async function queryMemories(filters = {}) {
	await ensureMemorySchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);

	const where = [];
	const values = [];
	let idx = 1;

	if (filters.scope) {
		where.push(`scope = ${ph(dk, idx++)}`);
		values.push(filters.scope);
	}
	if (filters.agentKey) {
		where.push(`agent_key = ${ph(dk, idx++)}`);
		values.push(filters.agentKey);
	}
	if (filters.sessionId) {
		where.push(`session_id = ${ph(dk, idx++)}`);
		values.push(filters.sessionId);
	}
	if (filters.profileKey) {
		where.push(`profile_key = ${ph(dk, idx++)}`);
		values.push(filters.profileKey);
	}
	if (filters.category) {
		where.push(`category = ${ph(dk, idx++)}`);
		values.push(filters.category);
	}
	if (filters.minRelevance != null) {
		where.push(`relevance_score >= ${ph(dk, idx++)}`);
		values.push(filters.minRelevance);
	}
	if (filters.excludeExpired !== false) {
		where.push(`(expires_at IS NULL OR expires_at > ${ph(dk, idx++)})`);
		values.push(nowIso());
	}

	const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const limit = filters.limit || 50;
	const offset = filters.offset || 0;

	const rows = await ds.query(
		`SELECT * FROM ${TABLE} ${clause}
		 ORDER BY relevance_score DESC, updated_at DESC
		 LIMIT ${limit} OFFSET ${offset}`,
		values,
	);

	// Bump access_count for returned rows
	if (rows.length > 0) {
		const ids = rows.map((r) => r.id);
		const now = nowIso();
		const placeholders = ids.map((_, i) => ph(dk, i + 1)).join(", ");
		const timeParam = ph(dk, ids.length + 1);
		await ds.query(
			`UPDATE ${TABLE}
			 SET access_count = access_count + 1, last_accessed_at = ${timeParam}
			 WHERE id IN (${placeholders})`,
			[...ids, now],
		);
	}

	return rows.map(mapRow);
}

// ─── Evaluate (relevance recalculation) ─────────────────────────

async function evaluateMemory(id, newScore) {
	return updateMemory(id, { relevanceScore: newScore });
}

// ─── Merge ──────────────────────────────────────────────────────

async function mergeMemories(sourceIds, mergedContent, options = {}) {
	await ensureMemorySchema();

	const sources = [];
	for (const sid of sourceIds) {
		const mem = await getMemory(sid);
		if (mem) sources.push(mem);
	}
	if (sources.length === 0) return null;

	const first = sources[0];
	const allTags = [...new Set(sources.flatMap((s) => s.tags || []))];
	const maxRelevance = Math.max(...sources.map((s) => s.relevanceScore));

	const merged = await createMemory({
		scope: options.scope || first.scope,
		agentKey: options.agentKey || first.agentKey,
		sessionId: options.sessionId || first.sessionId,
		profileKey: options.profileKey || first.profileKey,
		category: options.category || first.category,
		content: mergedContent,
		tags: allTags,
		relevanceScore: maxRelevance,
		expiresAt: options.expiresAt || null,
	});

	if (options.deleteOriginals !== false) {
		for (const sid of sourceIds) {
			await deleteMemory(sid);
		}
	}

	return merged;
}

// ─── Compact (summarize old memories) ───────────────────────────

async function compactMemories(filters = {}, summaryFn) {
	const memories = await queryMemories({
		...filters,
		excludeExpired: false,
		limit: filters.limit || 100,
	});

	if (memories.length <= 1) return { compacted: 0, merged: null };

	const contents = memories.map(
		(m) => `[${m.category}] ${m.content}`,
	);

	let summary;
	if (typeof summaryFn === "function") {
		summary = await summaryFn(contents);
	} else {
		summary = contents.join("\n---\n");
	}

	const merged = await mergeMemories(
		memories.map((m) => m.id),
		summary,
		{
			...filters,
			category: "compacted",
			deleteOriginals: true,
		},
	);

	return { compacted: memories.length, merged };
}

// ─── Cleanup expired ────────────────────────────────────────────

async function cleanupExpiredMemories() {
	await ensureMemorySchema();
	const ds = getDataSource();
	const dk = getDriverKind(ds);
	const result = await ds.query(
		`DELETE FROM ${TABLE} WHERE expires_at IS NOT NULL AND expires_at <= ${ph(dk, 1)}`,
		[nowIso()],
	);
	return result;
}

// ─── Build prompt injection ─────────────────────────────────────

async function buildMemoryPromptSection(filters = {}, maxTokenEstimate = 2000) {
	const memories = await queryMemories({
		...filters,
		excludeExpired: true,
		limit: 50,
	});

	if (memories.length === 0) return "";

	const lines = [];
	let estimatedChars = 0;
	const charLimit = maxTokenEstimate * 4;

	for (const mem of memories) {
		const line = `- [${mem.scope}/${mem.category}] ${mem.content}`;
		if (estimatedChars + line.length > charLimit) break;
		lines.push(line);
		estimatedChars += line.length;
	}

	return `\n\nPersistent memory:\n${lines.join("\n")}`;
}

module.exports = {
	createMemory,
	getMemory,
	updateMemory,
	deleteMemory,
	queryMemories,
	evaluateMemory,
	mergeMemories,
	compactMemories,
	cleanupExpiredMemories,
	buildMemoryPromptSection,
	ensureMemorySchema,
};
