"use strict";

const crypto = require("node:crypto");
const { Container } = require("@n8n/di");
const { DataSource } = require("@n8n/typeorm");

const TABLES = {
	sessionBindings: "codex_session_bindings",
	runs: "codex_runs",
	runEvents: "codex_run_events",
	runArtifacts: "codex_run_artifacts",
};

let schemaPromise;

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
	const dataSource = Container.get(DataSource);

	if (!dataSource || !dataSource.isInitialized) {
		throw new Error(
			"n8n DataSource is not available yet. Start n8n before executing Codex nodes.",
		);
	}

	return dataSource;
}

function getDriverKind(dataSource) {
	const type = String(dataSource.options?.type || "").toLowerCase();
	if (type.includes("postgres")) return "postgres";
	return "sqlite";
}

function placeholder(driverKind, index) {
	return driverKind === "postgres" ? `$${index}` : "?";
}

function toBindingKey(parts) {
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(parts))
		.digest("hex");
}

function mapRunRow(row) {
	if (!row) return null;
	return {
		id: row.id,
		workflowId: row.workflow_id,
		nodeId: row.node_id,
		executionId: row.execution_id,
		resource: row.resource,
		operation: row.operation,
		runtime: row.runtime,
		status: row.status,
		sessionId: row.session_id,
		threadId: row.thread_id,
		promptPreview: row.prompt_preview,
		model: row.model,
		codexHome: row.codex_home,
		profileKey: row.profile_key,
		resolvedCredentialId: row.resolved_credential_id,
		authFingerprintAtRun: row.auth_fingerprint_at_run,
		workingDirectory: row.working_directory,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		durationMs: row.duration_ms,
		inputTokens: row.input_tokens,
		cachedInputTokens: row.cached_input_tokens,
		outputTokens: row.output_tokens,
		stderr: row.stderr,
		finalResponse: row.final_response,
		errorMessage: row.error_message,
		metadata: jsonParse(row.metadata_json, {}),
	};
}

function mapBindingRow(row) {
	if (!row) return null;
	return {
		id: row.id,
		bindingKey: row.binding_key,
		workflowId: row.workflow_id,
		nodeId: row.node_id,
		sessionId: row.session_id,
		codexHome: row.codex_home,
		profileKey: row.profile_key,
		resolvedCredentialId: row.resolved_credential_id,
		authFingerprint: row.auth_fingerprint,
		workingDirectory: row.working_directory,
		model: row.model,
		runtime: row.runtime,
		threadId: row.thread_id,
		lastRunId: row.last_run_id,
		status: row.status,
		recoveryCount: Number(row.recovery_count || 0),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastUsedAt: row.last_used_at,
	};
}

async function ensureSchema() {
	if (!schemaPromise) {
		schemaPromise = (async () => {
			const dataSource = getDataSource();

			await dataSource.query(`
				CREATE TABLE IF NOT EXISTS ${TABLES.sessionBindings} (
					id TEXT PRIMARY KEY,
					binding_key TEXT NOT NULL UNIQUE,
					workflow_id TEXT,
					node_id TEXT,
					session_id TEXT NOT NULL,
					codex_home TEXT,
					profile_key TEXT,
					resolved_credential_id TEXT,
					auth_fingerprint TEXT,
					working_directory TEXT,
					model TEXT,
					runtime TEXT,
					thread_id TEXT NOT NULL,
					last_run_id TEXT,
					status TEXT,
					recovery_count INTEGER NOT NULL DEFAULT 0,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					last_used_at TEXT NOT NULL
				)
			`);
			await dataSource.query(
				`CREATE INDEX IF NOT EXISTS idx_codex_bindings_lookup ON ${TABLES.sessionBindings} (workflow_id, node_id, session_id, profile_key)`,
			);

			await dataSource.query(`
				CREATE TABLE IF NOT EXISTS ${TABLES.runs} (
					id TEXT PRIMARY KEY,
					workflow_id TEXT,
					node_id TEXT,
					execution_id TEXT,
					resource TEXT NOT NULL,
					operation TEXT NOT NULL,
					runtime TEXT NOT NULL,
					status TEXT NOT NULL,
					session_id TEXT,
					thread_id TEXT,
					prompt_preview TEXT,
					model TEXT,
					codex_home TEXT,
					profile_key TEXT,
					resolved_credential_id TEXT,
					auth_fingerprint_at_run TEXT,
					working_directory TEXT,
					started_at TEXT NOT NULL,
					ended_at TEXT,
					duration_ms INTEGER,
					input_tokens INTEGER,
					cached_input_tokens INTEGER,
					output_tokens INTEGER,
					stderr TEXT,
					final_response TEXT,
					error_message TEXT,
					metadata_json TEXT
				)
			`);
			await dataSource.query(
				`CREATE INDEX IF NOT EXISTS idx_codex_runs_session ON ${TABLES.runs} (workflow_id, node_id, session_id, profile_key, started_at)`,
			);
			await dataSource.query(
				`CREATE INDEX IF NOT EXISTS idx_codex_runs_thread ON ${TABLES.runs} (thread_id, started_at)`,
			);

			await dataSource.query(`
				CREATE TABLE IF NOT EXISTS ${TABLES.runEvents} (
					id TEXT PRIMARY KEY,
					run_id TEXT NOT NULL,
					seq INTEGER NOT NULL,
					thread_id TEXT,
					event_type TEXT NOT NULL,
					ts TEXT NOT NULL,
					payload_json TEXT
				)
			`);
			await dataSource.query(
				`CREATE INDEX IF NOT EXISTS idx_codex_run_events_run ON ${TABLES.runEvents} (run_id, seq)`,
			);

			await dataSource.query(`
				CREATE TABLE IF NOT EXISTS ${TABLES.runArtifacts} (
					id TEXT PRIMARY KEY,
					run_id TEXT NOT NULL,
					kind TEXT NOT NULL,
					label TEXT,
					command TEXT,
					cwd TEXT,
					exit_code INTEGER,
					file_paths_json TEXT,
					payload_json TEXT,
					created_at TEXT NOT NULL
				)
			`);
			await dataSource.query(
				`CREATE INDEX IF NOT EXISTS idx_codex_artifacts_run ON ${TABLES.runArtifacts} (run_id, kind, created_at)`,
			);

			await ensureColumn(TABLES.sessionBindings, "profile_key", "TEXT");
			await ensureColumn(TABLES.sessionBindings, "resolved_credential_id", "TEXT");
			await ensureColumn(TABLES.sessionBindings, "auth_fingerprint", "TEXT");
			await ensureColumn(TABLES.runs, "profile_key", "TEXT");
			await ensureColumn(TABLES.runs, "resolved_credential_id", "TEXT");
			await ensureColumn(TABLES.runs, "auth_fingerprint_at_run", "TEXT");
		})();
	}

	return await schemaPromise;
}

async function queryOne(sql, values) {
	const dataSource = getDataSource();
	const rows = await dataSource.query(sql, values);
	return rows[0] || null;
}

async function ensureColumn(tableName, columnName, definition) {
	const dataSource = getDataSource();
	try {
		await dataSource.query(
			`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`,
		);
	} catch (error) {
		const message = String(error?.message || "").toLowerCase();
		if (
			message.includes("duplicate column") ||
			message.includes("already exists") ||
			message.includes(`column "${columnName.toLowerCase()}" of relation`)
		) {
			return;
		}
		throw error;
	}
}

async function createRun(input) {
	await ensureSchema();

	const dataSource = getDataSource();
	const driverKind = getDriverKind(dataSource);
	const id = createId();
	const startedAt = input.startedAt || nowIso();
	const values = [
		id,
		input.workflowId || null,
		input.nodeId || null,
		input.executionId || null,
		input.resource || "agent",
		input.operation || "exec",
		input.runtime || "sdk",
		input.status || "in_progress",
		input.sessionId || null,
		input.threadId || null,
		input.promptPreview || null,
		input.model || null,
		input.codexHome || null,
		input.profileKey || null,
		input.resolvedCredentialId || null,
		input.authFingerprintAtRun || null,
		input.workingDirectory || null,
		startedAt,
		input.endedAt || null,
		input.durationMs ?? null,
		input.inputTokens ?? null,
		input.cachedInputTokens ?? null,
		input.outputTokens ?? null,
		input.stderr || null,
		input.finalResponse || null,
		input.errorMessage || null,
		jsonStringify(input.metadata || {}),
	];
	const sql = `
		INSERT INTO ${TABLES.runs} (
			id, workflow_id, node_id, execution_id, resource, operation, runtime, status,
			session_id, thread_id, prompt_preview, model, codex_home, profile_key,
			resolved_credential_id, auth_fingerprint_at_run, working_directory,
			started_at, ended_at, duration_ms, input_tokens, cached_input_tokens, output_tokens,
			stderr, final_response, error_message, metadata_json
		) VALUES (
			${values.map((_, index) => placeholder(driverKind, index + 1)).join(", ")}
		)
	`;
	await dataSource.query(sql, values);
	return { id, startedAt };
}

async function completeRun(runId, input) {
	await ensureSchema();

	const dataSource = getDataSource();
	const driverKind = getDriverKind(dataSource);
	const values = [
		input.status || "completed",
		input.threadId || null,
		input.endedAt || nowIso(),
		input.durationMs ?? null,
		input.inputTokens ?? null,
		input.cachedInputTokens ?? null,
		input.outputTokens ?? null,
		input.stderr || null,
		input.finalResponse || null,
		input.errorMessage || null,
		jsonStringify(input.metadata || {}),
		runId,
	];
	const sql = `
		UPDATE ${TABLES.runs}
		SET
			status = ${placeholder(driverKind, 1)},
			thread_id = ${placeholder(driverKind, 2)},
			ended_at = ${placeholder(driverKind, 3)},
			duration_ms = ${placeholder(driverKind, 4)},
			input_tokens = ${placeholder(driverKind, 5)},
			cached_input_tokens = ${placeholder(driverKind, 6)},
			output_tokens = ${placeholder(driverKind, 7)},
			stderr = ${placeholder(driverKind, 8)},
			final_response = ${placeholder(driverKind, 9)},
			error_message = ${placeholder(driverKind, 10)},
			metadata_json = ${placeholder(driverKind, 11)}
		WHERE id = ${placeholder(driverKind, 12)}
	`;
	await dataSource.query(sql, values);
}

async function getSessionBinding(bindingKey) {
	await ensureSchema();

	const dataSource = getDataSource();
	const driverKind = getDriverKind(dataSource);
	const row = await queryOne(
		`SELECT * FROM ${TABLES.sessionBindings} WHERE binding_key = ${placeholder(
			driverKind,
			1,
		)}`,
		[bindingKey],
	);
	return mapBindingRow(row);
}

async function upsertSessionBinding(input) {
	await ensureSchema();

	const dataSource = getDataSource();
	const driverKind = getDriverKind(dataSource);
	const now = nowIso();
	const id = input.id || createId();
	const values = [
		id,
		input.bindingKey,
		input.workflowId || null,
		input.nodeId || null,
		input.sessionId,
		input.codexHome || null,
		input.profileKey || null,
		input.resolvedCredentialId || null,
		input.authFingerprint || null,
		input.workingDirectory || null,
		input.model || null,
		input.runtime || null,
		input.threadId,
		input.lastRunId || null,
		input.status || "active",
		input.recoveryCount ?? 0,
		input.createdAt || now,
		now,
		now,
	];
	const sql = `
		INSERT INTO ${TABLES.sessionBindings} (
			id, binding_key, workflow_id, node_id, session_id, codex_home,
			profile_key, resolved_credential_id, auth_fingerprint, working_directory,
			model, runtime, thread_id, last_run_id, status,
			recovery_count, created_at, updated_at, last_used_at
		) VALUES (
			${values.map((_, index) => placeholder(driverKind, index + 1)).join(", ")}
		)
		ON CONFLICT(binding_key) DO UPDATE SET
			workflow_id = excluded.workflow_id,
			node_id = excluded.node_id,
			session_id = excluded.session_id,
			codex_home = excluded.codex_home,
			profile_key = excluded.profile_key,
			resolved_credential_id = excluded.resolved_credential_id,
			auth_fingerprint = excluded.auth_fingerprint,
			working_directory = excluded.working_directory,
			model = excluded.model,
			runtime = excluded.runtime,
			thread_id = excluded.thread_id,
			last_run_id = excluded.last_run_id,
			status = excluded.status,
			recovery_count = excluded.recovery_count,
			updated_at = excluded.updated_at,
			last_used_at = excluded.last_used_at
	`;
	await dataSource.query(sql, values);
	return await getSessionBinding(input.bindingKey);
}

async function insertRunEvents(runId, events) {
	if (!Array.isArray(events) || events.length === 0) return 0;

	await ensureSchema();

	const dataSource = getDataSource();
	const driverKind = getDriverKind(dataSource);
	const COLS = 7;
	const BATCH_SIZE = Math.floor(999 / COLS);
	let count = 0;

	for (let i = 0; i < events.length; i += BATCH_SIZE) {
		const batch = events.slice(i, i + BATCH_SIZE);
		const allValues = [];
		const rowPlaceholders = [];

		for (const event of batch) {
			allValues.push(
				createId(),
				runId,
				event.seq,
				event.threadId || null,
				event.eventType,
				event.ts || nowIso(),
				jsonStringify(event.payloadJson ?? event.payload ?? {}),
			);
			const offset = allValues.length - COLS;
			rowPlaceholders.push(
				`(${Array.from({ length: COLS }, (_, k) => placeholder(driverKind, offset + k + 1)).join(", ")})`,
			);
		}

		const sql = `
			INSERT INTO ${TABLES.runEvents} (
				id, run_id, seq, thread_id, event_type, ts, payload_json
			) VALUES ${rowPlaceholders.join(", ")}
		`;
		await dataSource.query(sql, allValues);
		count += batch.length;
	}

	return count;
}

async function insertRunArtifacts(runId, artifacts) {
	if (!Array.isArray(artifacts) || artifacts.length === 0) return 0;

	await ensureSchema();

	const dataSource = getDataSource();
	const driverKind = getDriverKind(dataSource);
	let count = 0;

	for (const artifact of artifacts) {
		const values = [
			createId(),
			runId,
			artifact.kind,
			artifact.label || null,
			artifact.command || null,
			artifact.cwd || null,
			artifact.exitCode ?? null,
			jsonStringify(artifact.filePaths || []),
			jsonStringify(artifact.payload || {}),
			artifact.createdAt || nowIso(),
		];
		const sql = `
			INSERT INTO ${TABLES.runArtifacts} (
				id, run_id, kind, label, command, cwd, exit_code, file_paths_json, payload_json, created_at
			) VALUES (
				${values.map((_, index) => placeholder(driverKind, index + 1)).join(", ")}
			)
		`;
		await dataSource.query(sql, values);
		count += 1;
	}

	return count;
}

async function listRecentTranscriptEntries(input) {
	await ensureSchema();

	const dataSource = getDataSource();
	const driverKind = getDriverKind(dataSource);
	const limit = Math.max(1, Math.min(Number(input.limit || 5), 20));
	const values = [
		input.workflowId || null,
		input.nodeId || null,
		input.sessionId,
	];
	let sql = `
		SELECT prompt_preview, final_response, started_at
		FROM ${TABLES.runs}
		WHERE workflow_id = ${placeholder(driverKind, 1)}
			AND node_id = ${placeholder(driverKind, 2)}
			AND session_id = ${placeholder(driverKind, 3)}
			AND status = 'completed'
			AND final_response IS NOT NULL
	`;
	if (input.profileKey) {
		values.push(input.profileKey);
		sql += ` AND profile_key = ${placeholder(driverKind, values.length)}`;
	}
	sql += `
		ORDER BY started_at DESC
		LIMIT ${limit}
	`;
	const rows = await dataSource.query(sql, values);

	return rows
		.map((row) => ({
			promptPreview: row.prompt_preview || "",
			finalResponse: row.final_response || "",
			startedAt: row.started_at,
		}))
		.reverse();
}

async function listRunArtifacts(runId, kind) {
	await ensureSchema();

	const dataSource = getDataSource();
	const driverKind = getDriverKind(dataSource);
	const values = [runId];
	let sql = `
		SELECT *
		FROM ${TABLES.runArtifacts}
		WHERE run_id = ${placeholder(driverKind, 1)}
	`;

	if (kind) {
		values.push(kind);
		sql += ` AND kind = ${placeholder(driverKind, 2)}`;
	}

	sql += " ORDER BY created_at ASC";
	const rows = await dataSource.query(sql, values);
	return rows.map((row) => ({
		id: row.id,
		runId: row.run_id,
		kind: row.kind,
		label: row.label,
		command: row.command,
		cwd: row.cwd,
		exitCode: row.exit_code,
		filePaths: jsonParse(row.file_paths_json, []),
		payload: jsonParse(row.payload_json, {}),
		createdAt: row.created_at,
	}));
}

module.exports = {
	TABLES,
	completeRun,
	createRun,
	ensureSchema,
	getDataSource,
	getSessionBinding,
	insertRunArtifacts,
	insertRunEvents,
	listRecentTranscriptEntries,
	listRunArtifacts,
	mapRunRow,
	nowIso,
	toBindingKey,
	upsertSessionBinding,
};
