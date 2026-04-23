#!/usr/bin/env node
/**
 * verify-codex-facts.mjs
 *
 * docs/CODEX_PLATFORM_FACTS.md의 "Last verified" 시점 이후 공식 문서·GitHub에
 * 변경이 있었는지 확인하는 스크립트.
 *
 * 동작:
 *   1. 이 파일 상단의 URL 목록을 모두 fetch
 *   2. 결과를 .codex-facts-cache/<YYYY-MM-DD>/ 에 저장
 *   3. 직전 스냅샷(있으면)과 비교하여 변경된 URL 리포트
 *   4. 로컬 SDK 버전 및 index.d.ts의 핵심 키워드 존재 여부 확인
 *   5. "커스텀 tool 등록 API 없음" 같은 주요 한계가 여전히 맞는지 검증
 *
 * 사용:
 *   cd n8n_custom_node
 *   node scripts/verify-codex-facts.mjs
 *   node scripts/verify-codex-facts.mjs --force-fetch   # 캐시 무시
 *
 * 출력:
 *   - 콘솔: 변경 요약 + 체크리스트
 *   - 파일: .codex-facts-cache/<date>/*.txt (스냅샷)
 *   - 파일: .codex-facts-cache/<date>/REPORT.md (리포트)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const CACHE_ROOT = path.join(REPO_ROOT, ".codex-facts-cache");

// 검증 대상 URL 목록
// 각 항목: [카테고리, slug, url]
const SOURCES = [
	["docs", "codex-index", "https://developers.openai.com/codex"],
	["docs", "codex-sdk", "https://developers.openai.com/codex/sdk"],
	["docs", "codex-cli", "https://developers.openai.com/codex/cli"],
	["docs", "codex-skills", "https://developers.openai.com/codex/skills"],
	["docs", "codex-subagents", "https://developers.openai.com/codex/subagents"],
	["docs", "codex-hooks", "https://developers.openai.com/codex/hooks"],
	["docs", "codex-mcp", "https://developers.openai.com/codex/mcp"],
	[
		"github",
		"sdk-ts-readme",
		"https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/README.md",
	],
	[
		"github",
		"sdk-py-readme",
		"https://raw.githubusercontent.com/openai/codex/main/sdk/python/README.md",
	],
	[
		"github",
		"sdk-py-api-reference",
		"https://raw.githubusercontent.com/openai/codex/main/sdk/python/docs/api-reference.md",
	],
];

// "Last verified" 시점에 확정된 핵심 주장들
// 하나라도 변할 가능성이 있으면 아키텍처 결정 영향
const ASSERTIONS_TO_RECHECK = [
	{
		id: "no-custom-tool-api-ts",
		description:
			"TypeScript SDK에 커스텀 tool 등록 API 없음 (tools, addTool, registerTool, FunctionTool)",
		checkLocal: (indexDts) => {
			const forbidden = [
				"addTool",
				"registerTool",
				"FunctionTool",
				"tools?:",
				"tools:",
				"onToolCall",
				"preToolUse",
				"postToolUse",
			];
			const found = forbidden.filter((keyword) => indexDts.includes(keyword));
			return {
				stillValid: found.length === 0,
				evidence:
					found.length === 0
						? "index.d.ts에 관련 키워드 없음 (확인된 대로 API 없음)"
						: `발견된 키워드: ${found.join(", ")} — 수동 확인 필요!`,
			};
		},
	},
	{
		id: "no-mid-turn-tool-result-injection",
		description:
			"Mid-turn tool_result injection 불가 (Python steer도 user input 주입, tool result 아님)",
		checkRemote: (pyApiRef) => {
			// 단순 휴리스틱: api-reference.md에 "tool_result" 또는 "inject_tool_response" 등장?
			const positiveSignals = [
				"tool_result",
				"inject_tool_response",
				"respond_to_tool",
				"submit_tool",
			];
			const found = positiveSignals.filter((s) => pyApiRef?.includes(s));
			return {
				stillValid: found.length === 0,
				evidence:
					found.length === 0
						? "Python api-reference.md에 tool_result 주입 API 키워드 없음"
						: `발견: ${found.join(", ")} — 수동 확인 필요`,
			};
		},
	},
	{
		id: "preToolUse-bash-only",
		description: "Hooks의 PreToolUse/PostToolUse는 Bash만 지원",
		checkRemote: (hooksDoc) => {
			// 단순 휴리스틱: hooks 페이지에 "mcp" 또는 "custom tool"과 함께 "PreToolUse" 맥락?
			if (!hooksDoc) return { stillValid: null, evidence: "문서 fetch 실패" };
			const hasMcpTool =
				/PreToolUse[\s\S]{0,500}(mcp|custom tool)/i.test(hooksDoc) ||
				/(mcp|custom tool)[\s\S]{0,500}PreToolUse/i.test(hooksDoc);
			return {
				stillValid: !hasMcpTool,
				evidence: hasMcpTool
					? "PreToolUse와 MCP/custom tool 맥락이 가까이 등장 — 확장됐을 가능성"
					: "Bash 외 지원 확장 증거 없음",
			};
		},
	},
];

function isoDate() {
	return new Date().toISOString().slice(0, 10);
}

function slugify(url) {
	return url
		.replace(/^https?:\/\//, "")
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/-+$/, "")
		.slice(0, 120);
}

function hash(s) {
	return crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
}

async function fetchUrl(url) {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		const res = await fetch(url, {
			headers: {
				"User-Agent":
					"codex-facts-verifier/1.0 (+https://github.com/openai/codex)",
				Accept: "text/plain, text/html, application/json;q=0.9, */*;q=0.8",
			},
			signal: controller.signal,
		});
		clearTimeout(timeout);
		if (!res.ok) {
			return { ok: false, status: res.status, text: "" };
		}
		const text = await res.text();
		return { ok: true, status: res.status, text };
	} catch (err) {
		return { ok: false, status: 0, text: "", error: err.message };
	}
}

async function loadIndexDts() {
	const candidates = [
		path.join(
			REPO_ROOT,
			"node_modules",
			"@openai",
			"codex-sdk",
			"dist",
			"index.d.ts",
		),
	];
	for (const p of candidates) {
		try {
			return { path: p, content: await fs.readFile(p, "utf8") };
		} catch {}
	}
	return null;
}

async function loadSdkPackageJson() {
	try {
		const p = path.join(
			REPO_ROOT,
			"node_modules",
			"@openai",
			"codex-sdk",
			"package.json",
		);
		const content = await fs.readFile(p, "utf8");
		return JSON.parse(content);
	} catch {
		return null;
	}
}

async function listPreviousSnapshots() {
	try {
		const entries = await fs.readdir(CACHE_ROOT, { withFileTypes: true });
		return entries
			.filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}

async function loadSnapshot(date, slug) {
	try {
		const p = path.join(CACHE_ROOT, date, `${slug}.txt`);
		return await fs.readFile(p, "utf8");
	} catch {
		return null;
	}
}

function summarizeDiff(prev, cur) {
	if (prev === null) return { status: "new", note: "첫 스냅샷" };
	if (prev === cur) return { status: "unchanged", note: "변경 없음" };
	const prevLines = prev.split("\n").length;
	const curLines = cur.split("\n").length;
	const prevHash = hash(prev);
	const curHash = hash(cur);
	return {
		status: "changed",
		note: `hash ${prevHash} → ${curHash}, ${prevLines}줄 → ${curLines}줄`,
	};
}

async function main() {
	const args = new Set(process.argv.slice(2));
	const forceFetch = args.has("--force-fetch");
	const today = isoDate();
	const outDir = path.join(CACHE_ROOT, today);
	await fs.mkdir(outDir, { recursive: true });

	console.log(`\n=== Codex Platform Facts Verification (${today}) ===\n`);

	const previous = (await listPreviousSnapshots()).filter((d) => d !== today);
	const prevDate = previous[previous.length - 1] || null;
	if (prevDate) {
		console.log(`📂 이전 스냅샷: ${prevDate}`);
	} else {
		console.log(`📂 이전 스냅샷 없음 (최초 실행)`);
	}

	// 1. 로컬 상태
	console.log(`\n--- 로컬 SDK 상태 ---`);
	const pkg = await loadSdkPackageJson();
	if (pkg) {
		console.log(`  @openai/codex-sdk: ${pkg.version}`);
	} else {
		console.log(`  ⚠️  @openai/codex-sdk 없음 (node_modules 확인)`);
	}
	const indexDts = await loadIndexDts();
	if (indexDts) {
		console.log(`  index.d.ts: ${indexDts.path} (${indexDts.content.length} bytes)`);
	}

	// 2. URL 스냅샷
	console.log(`\n--- 원격 스냅샷 수집 ---`);
	const results = [];
	for (const [category, slug, url] of SOURCES) {
		const outPath = path.join(outDir, `${slug}.txt`);

		let text;
		if (!forceFetch) {
			try {
				text = await fs.readFile(outPath, "utf8");
			} catch {}
		}

		if (text === undefined) {
			const res = await fetchUrl(url);
			if (!res.ok) {
				console.log(`  ❌ ${slug} [${category}] — fetch 실패 (${res.status}${res.error ? ": " + res.error : ""})`);
				results.push({ slug, category, url, status: "fetch_failed" });
				continue;
			}
			text = res.text;
			await fs.writeFile(outPath, text);
		}

		const prevText = prevDate ? await loadSnapshot(prevDate, slug) : null;
		const diff = summarizeDiff(prevText, text);
		const icon =
			diff.status === "new" ? "🆕" : diff.status === "unchanged" ? "✓" : "⚠️ ";
		console.log(`  ${icon} ${slug} [${category}] — ${diff.note}`);
		results.push({ slug, category, url, status: diff.status, note: diff.note, text });
	}

	// 3. 핵심 주장 재검증
	console.log(`\n--- 핵심 주장 재검증 ---`);
	const assertionResults = [];
	for (const assertion of ASSERTIONS_TO_RECHECK) {
		let outcome = { stillValid: null, evidence: "검사 함수 없음" };
		if (assertion.checkLocal && indexDts) {
			outcome = assertion.checkLocal(indexDts.content);
		} else if (assertion.checkRemote) {
			// 관련 리모트 텍스트 매핑 (간단한 규칙)
			let relevant = null;
			if (assertion.id.includes("mid-turn")) {
				relevant = results.find((r) => r.slug === "sdk-py-api-reference")?.text;
			} else if (assertion.id.includes("preToolUse")) {
				relevant = results.find((r) => r.slug === "codex-hooks")?.text;
			}
			outcome = assertion.checkRemote(relevant);
		}
		const icon =
			outcome.stillValid === true
				? "✓"
				: outcome.stillValid === false
					? "⚠️ "
					: "?";
		console.log(`  ${icon} [${assertion.id}]`);
		console.log(`     ${assertion.description}`);
		console.log(`     → ${outcome.evidence}`);
		assertionResults.push({ ...assertion, outcome });
	}

	// 4. 리포트 생성
	const reportPath = path.join(outDir, "REPORT.md");
	const changedCount = results.filter((r) => r.status === "changed").length;
	const newCount = results.filter((r) => r.status === "new").length;
	const invalidAssertions = assertionResults.filter(
		(a) => a.outcome.stillValid === false,
	);

	const report = [
		`# Codex Platform Facts — Verification Report`,
		``,
		`**Date**: ${today}`,
		`**Previous snapshot**: ${prevDate || "(none)"}`,
		``,
		`## 요약`,
		``,
		`- 변경된 소스: **${changedCount}**`,
		`- 신규 소스: **${newCount}**`,
		`- 재검증 실패 주장: **${invalidAssertions.length}**`,
		`- 로컬 SDK 버전: \`${pkg?.version || "(미확인)"}\``,
		``,
		`## 소스별 상태`,
		``,
		`| Slug | Category | Status | Note |`,
		`|------|----------|--------|------|`,
		...results.map(
			(r) =>
				`| \`${r.slug}\` | ${r.category} | ${r.status} | ${r.note || ""} |`,
		),
		``,
		`## 주장 재검증`,
		``,
		...assertionResults.flatMap((a) => [
			`### ${a.id}`,
			``,
			`- 설명: ${a.description}`,
			`- 여전히 유효: ${a.outcome.stillValid === true ? "예" : a.outcome.stillValid === false ? "아니오" : "불명"}`,
			`- 근거: ${a.outcome.evidence}`,
			``,
		]),
		`## 조치 권장`,
		``,
		changedCount > 0
			? `1. 변경된 소스 파일을 \`${outDir}\` 에서 직접 열어 확인`
			: `1. 변경 없음 — 문서 업데이트 불필요`,
		invalidAssertions.length > 0
			? `2. ⚠️ 다음 주장이 재검증 실패했습니다. \`docs/CODEX_PLATFORM_FACTS.md\`와 \`docs/MULTI_AGENT_STRATEGY.md\`를 수동 검토하십시오:\n${invalidAssertions.map((a) => `   - ${a.id}`).join("\n")}`
			: `2. 모든 핵심 주장이 여전히 유효`,
		`3. 검증 완료 후 \`CODEX_PLATFORM_FACTS.md\` 상단 "Last verified" 날짜 업데이트`,
		``,
	].join("\n");

	await fs.writeFile(reportPath, report);

	console.log(`\n=== 완료 ===`);
	console.log(`스냅샷: ${outDir}`);
	console.log(`리포트: ${reportPath}`);

	// Exit code: 변경 또는 주장 실패 시 1 (CI 통합용)
	if (changedCount > 0 || invalidAssertions.length > 0) {
		console.log(`\n⚠️  변경 발견 — 수동 검토가 필요합니다.`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("❌ 실행 실패:", err);
	process.exit(2);
});
