#!/usr/bin/env node
/**
 * Codex 커스텀 노드 크로스 플랫폼 검증 스크립트.
 *
 * macOS / Windows / Linux 모두에서 동일하게 실행 가능하다.
 * n8n 런타임이 필요 없고, 순수 Node.js만으로 다음을 검증한다:
 *
 *   1. 모든 노드/런타임/스토어 파일의 구문 정상 여부
 *   2. 모듈 간 require() 정합성 (순환 참조, 누락 export 등)
 *   3. 공유 유틸(codex-store-utils, buildModelFields) 기능 테스트
 *   4. 예제 워크플로 JSON 유효성 + credential placeholder 확인
 *
 * 사용법:
 *   cd n8n_custom_node
 *   node scripts/verify-codex-nodes.mjs
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CODEX = join(ROOT, "custom", "codex");
const require = createRequire(join(ROOT, "package.json"));

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name} — ${e.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "assertion failed");
}

// ────────────────────────────────────────────────────────
console.log("\n═══ 1. Syntax Check ═══");
// ────────────────────────────────────────────────────────

const nodeFiles = [
  "CodexAgent.node.js",
  "CodexAgentTool.node.js",
  "CodexAgentRegistry.node.js",
  "CodexMemory.node.js",
  "CodexMcpToolset.node.js",
];

const runtimeFiles = [
  "runtime/codex-service.js",
  "runtime/sdk-runtime.js",
  "runtime/codex-runtime-utils.js",
];

const storeFiles = [
  "store/codex-store-utils.js",
  "store/codex-store.js",
  "store/codex-memory-store.js",
  "store/codex-agent-registry-store.js",
  "store/codex-agent-message-store.js",
];

const libFiles = [
  "lib/node-runtime-helpers.js",
  "lib/node-ui-helpers.js",
  "lib/codex-hooks.js",
  "lib/codex-utils.js",
  "lib/codex-profile-utils.js",
];

const observabilityFiles = ["observability/codex-observability.js"];

const allFiles = [
  ...nodeFiles,
  ...runtimeFiles,
  ...storeFiles,
  ...libFiles,
  ...observabilityFiles,
];

for (const f of allFiles) {
  const fullPath = join(CODEX, f);
  test(`syntax: ${f}`, () => {
    assert(existsSync(fullPath), `file not found: ${fullPath}`);
    const src = readFileSync(fullPath, "utf8");
    // eslint-disable-next-line no-new-func
    new Function(src);
  });
}

// ────────────────────────────────────────────────────────
console.log("\n═══ 2. Module Require Check ═══");
// ────────────────────────────────────────────────────────

// 이 모듈들은 n8n 런타임 없이도 require 가능해야 한다
const requireableModules = [
  ["store/codex-store-utils", storeFiles[0]],
  ["lib/node-runtime-helpers", libFiles[0]],
  ["lib/node-ui-helpers", libFiles[1]],
  ["lib/codex-hooks", libFiles[2]],
  ["runtime/sdk-runtime", runtimeFiles[1]],
];

for (const [label, file] of requireableModules) {
  test(`require: ${label}`, () => {
    const mod = require(join(CODEX, file));
    assert(mod && typeof mod === "object", "module should export an object");
  });
}

// ────────────────────────────────────────────────────────
console.log("\n═══ 3. codex-store-utils Unit Tests ═══");
// ────────────────────────────────────────────────────────

const storeUtils = require(join(CODEX, "store", "codex-store-utils.js"));

test("nowIso returns ISO string", () => {
  assert(/^\d{4}-\d{2}.*Z$/.test(storeUtils.nowIso()));
});

test("createId returns UUID", () => {
  assert(/^[0-9a-f-]{36}$/.test(storeUtils.createId()));
});

test("jsonStringify(undefined) → null", () => {
  assert(storeUtils.jsonStringify(undefined) === null);
});

test("jsonStringify({a:1})", () => {
  assert(storeUtils.jsonStringify({ a: 1 }) === '{"a":1}');
});

test("jsonParse valid", () => {
  assert(storeUtils.jsonParse('{"b":2}').b === 2);
});

test("jsonParse invalid → fallback", () => {
  assert(storeUtils.jsonParse("not json", "fb") === "fb");
});

test("ph sqlite", () => {
  assert(storeUtils.ph("sqlite", 3) === "?");
});

test("ph postgres", () => {
  assert(storeUtils.ph("postgres", 3) === "$3");
});

// ────────────────────────────────────────────────────────
console.log("\n═══ 4. buildModelFields Unit Tests ═══");
// ────────────────────────────────────────────────────────

const helpers = require(join(CODEX, "lib", "node-runtime-helpers.js"));

test("MODEL_PRESET_OPTIONS exported", () => {
  assert(Array.isArray(helpers.MODEL_PRESET_OPTIONS));
  assert(helpers.MODEL_PRESET_OPTIONS.length === 9);
});

test("buildModelFields returns 2 fields", () => {
  const fields = helpers.buildModelFields();
  assert(Array.isArray(fields) && fields.length === 2);
  assert(fields[0].name === "modelPreset");
  assert(fields[1].name === "model");
});

test("buildModelFields spread works", () => {
  const props = [{ name: "a" }, ...helpers.buildModelFields(), { name: "b" }];
  assert(props.length === 4);
  assert(props[1].name === "modelPreset");
});

// ────────────────────────────────────────────────────────
console.log("\n═══ 5. Example Workflow Validation ═══");
// ────────────────────────────────────────────────────────

const examplesDir = join(ROOT, "docs", "examples");
const exampleFiles = readdirSync(examplesDir).filter((f) =>
  f.endsWith(".workflow.json"),
);

for (const file of exampleFiles) {
  test(`example JSON valid: ${file}`, () => {
    const raw = readFileSync(join(examplesDir, file), "utf8");
    const wf = JSON.parse(raw);
    assert(wf.nodes && Array.isArray(wf.nodes), "should have nodes array");
    assert(wf.connections && typeof wf.connections === "object", "should have connections");
  });

  test(`example no hardcoded credentials: ${file}`, () => {
    const raw = readFileSync(join(examplesDir, file), "utf8");
    // credential ID가 macOS 특정 값이면 실패
    assert(
      !raw.includes("RpJYd1nM7HAWJyua"),
      "contains hardcoded macOS credential ID — use YOUR_CREDENTIAL_ID placeholder",
    );
  });
}

// ────────────────────────────────────────────────────────
console.log("\n═══ 6. Cross-Platform Compatibility ═══");
// ────────────────────────────────────────────────────────

test("codex-store-utils has no platform-specific code", () => {
  const src = readFileSync(join(CODEX, "store", "codex-store-utils.js"), "utf8");
  assert(!src.includes("process.platform"), "should not reference process.platform");
  assert(!src.includes("/tmp/"), "should not have hardcoded Unix paths");
});

test("no hardcoded macOS paths in store files", () => {
  for (const f of storeFiles) {
    const src = readFileSync(join(CODEX, f), "utf8");
    assert(
      !src.includes("/Users/") && !src.includes("/opt/homebrew"),
      `${f} contains hardcoded macOS path`,
    );
  }
});

test("no hardcoded macOS paths in lib files", () => {
  for (const f of libFiles) {
    const src = readFileSync(join(CODEX, f), "utf8");
    assert(
      !src.includes("/Users/") && !src.includes("/opt/homebrew"),
      `${f} contains hardcoded macOS path`,
    );
  }
});

// ────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────
console.log("\n" + "═".repeat(50));
console.log(`Results: ${pass} passed, ${fail} failed (total ${pass + fail})`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  ✗ ${f.name}: ${f.error}`);
  }
  process.exit(1);
} else {
  console.log("All checks passed ✓");
  process.exit(0);
}
