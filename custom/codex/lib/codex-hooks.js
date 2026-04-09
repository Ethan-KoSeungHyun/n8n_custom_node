"use strict";

/**
 * Codex Agent Lifecycle Hooks
 *
 * Hook points:
 *   preAgentStart   — before executeWithRuntime(), can modify request
 *   postAgentComplete — after successful run, receives result
 *   onError         — on run failure, receives error
 *   preToolUse      — before each SDK tool event (streaming only)
 *   postToolUse     — after each SDK tool event (streaming only)
 *   onStop          — when run is aborted or timed out
 *
 * Each hook is an async function. Hooks are registered per-node or globally.
 * Hook failures are logged but never block the main execution path.
 */

const _globalHooks = {};

// ─── Hook Registry ─────────────────────────────────────────────

function registerHook(hookName, fn, options = {}) {
	if (typeof fn !== "function") return;
	if (!_globalHooks[hookName]) _globalHooks[hookName] = [];
	_globalHooks[hookName].push({
		fn,
		priority: options.priority || 0,
		label: options.label || fn.name || "anonymous",
	});
	_globalHooks[hookName].sort((a, b) => b.priority - a.priority);
}

function unregisterHook(hookName, fn) {
	if (!_globalHooks[hookName]) return;
	_globalHooks[hookName] = _globalHooks[hookName].filter((h) => h.fn !== fn);
}

function clearHooks(hookName) {
	if (hookName) {
		delete _globalHooks[hookName];
	} else {
		for (const key of Object.keys(_globalHooks)) delete _globalHooks[key];
	}
}

function getRegisteredHooks(hookName) {
	return (_globalHooks[hookName] || []).map((h) => ({
		label: h.label,
		priority: h.priority,
	}));
}

// ─── Hook Execution ────────────────────────────────────────────

async function runHooks(hookName, context, nodeHooks) {
	const global = _globalHooks[hookName] || [];
	const node = (nodeHooks && nodeHooks[hookName]) || [];

	const all = [
		...global,
		...node.map((fn, i) => ({
			fn,
			priority: 0,
			label: fn.name || `node-hook-${i}`,
		})),
	].sort((a, b) => b.priority - a.priority);

	const results = [];
	for (const hook of all) {
		try {
			const result = await hook.fn(context);
			results.push({ label: hook.label, success: true, result });
		} catch (error) {
			results.push({ label: hook.label, success: false, error: error.message });
		}
	}
	return results;
}

// ─── Lifecycle wrapper for codex-service ───────────────────────

function createLifecycleHooks(nodeHooks) {
	return {
		async preAgentStart(request) {
			return runHooks("preAgentStart", { request }, nodeHooks);
		},

		async postAgentComplete(request, result) {
			return runHooks("postAgentComplete", { request, result }, nodeHooks);
		},

		async onError(request, error) {
			return runHooks("onError", { request, error }, nodeHooks);
		},

		async preToolUse(event, request) {
			return runHooks("preToolUse", { event, request }, nodeHooks);
		},

		async postToolUse(event, request) {
			return runHooks("postToolUse", { event, request }, nodeHooks);
		},

		async onStop(request, reason) {
			return runHooks("onStop", { request, reason }, nodeHooks);
		},
	};
}

// ─── Built-in hooks ────────────────────────────────────────────

function createTimingHook() {
	let startTime;
	return {
		preAgentStart(ctx) {
			startTime = Date.now();
			return { timing: "started" };
		},
		postAgentComplete(ctx) {
			const elapsed = Date.now() - startTime;
			return { timing: "completed", durationMs: elapsed };
		},
		onError(ctx) {
			const elapsed = Date.now() - startTime;
			return { timing: "failed", durationMs: elapsed };
		},
	};
}

function createLoggingHook(logger) {
	const log = logger || console;
	return {
		preAgentStart(ctx) {
			log.info?.(`[codex-hooks] Agent starting: ${ctx.request?.nodeId || "unknown"}`);
		},
		postAgentComplete(ctx) {
			log.info?.(
				`[codex-hooks] Agent completed: ${ctx.request?.nodeId || "unknown"}, ` +
				`threadId=${ctx.result?.threadId || "none"}`,
			);
		},
		onError(ctx) {
			log.error?.(
				`[codex-hooks] Agent error: ${ctx.request?.nodeId || "unknown"}, ` +
				`error=${ctx.error?.message || "unknown"}`,
			);
		},
	};
}

function createMessageHook(messageStore) {
	return {
		async postAgentComplete(ctx) {
			const { request, result } = ctx;
			if (!request.orchestrationId || !request.agentKey) return;

			await messageStore.sendMessage({
				orchestrationId: request.orchestrationId,
				fromAgent: request.agentKey,
				toAgent: request.orchestratorKey || "orchestrator",
				messageType: "result",
				content: result.finalResponse || "",
				metadata: {
					threadId: result.threadId,
					usage: result.usage,
				},
				status: "pending",
			});
		},
		async onError(ctx) {
			const { request, error } = ctx;
			if (!request.orchestrationId || !request.agentKey) return;

			await messageStore.sendMessage({
				orchestrationId: request.orchestrationId,
				fromAgent: request.agentKey,
				toAgent: request.orchestratorKey || "orchestrator",
				messageType: "feedback",
				content: `Error: ${error?.message || "unknown"}`,
				metadata: { errorDetails: error?.details },
				status: "pending",
			});
		},
	};
}

module.exports = {
	registerHook,
	unregisterHook,
	clearHooks,
	getRegisteredHooks,
	runHooks,
	createLifecycleHooks,
	createTimingHook,
	createLoggingHook,
	createMessageHook,
};
