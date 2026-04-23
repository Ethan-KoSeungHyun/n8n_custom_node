# Codex 플랫폼 팩트 스냅샷

> ⚠️ **중요**: 이 문서는 **시점 제한 사실(time-bound facts)**을 기록합니다.
> Codex 플랫폼은 빠른 이터레이션 중이므로 기록된 정보가 **수주 내 구식**이 될 수 있습니다.
> **사실을 인용하기 전에 반드시 "Last verified" 날짜를 확인하고, 필요 시 재검증하십시오.**

---

## 메타정보

- **Last verified**: 2026-04-23
- **Next recommended re-verification**: 2026-05-23 (30일 후)
- **Codex SDK TypeScript 버전**: `@openai/codex-sdk@0.117.0` (local `node_modules`)
- **검증 방법**: 공식 문서 + GitHub 공식 레포 README/src + 로컬 타입 정의 교차 확인
- **재검증 절차**: 이 문서 마지막 절 참조

---

## 1. TypeScript SDK (`@openai/codex-sdk`)

### 공개 API 전체
```typescript
class Codex {
  constructor(options?: CodexOptions);
  startThread(options?: ThreadOptions): Thread;
  resumeThread(id: string, options?: ThreadOptions): Thread;
}

class Thread {
  run(input: Input, turnOptions?: TurnOptions): Promise<Turn>;
  runStreamed(input: Input, turnOptions?: TurnOptions): Promise<StreamedTurn>;
}

type CodexOptions = {
  codexPathOverride?: string;
  baseUrl?: string;
  apiKey?: string;
  config?: CodexConfigObject;   // --config key=value 오버라이드
  env?: Record<string, string>;
};

type ThreadOptions = {
  model?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  modelReasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  networkAccessEnabled?: boolean;
  webSearchMode?: "disabled" | "cached" | "live";
  webSearchEnabled?: boolean;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  additionalDirectories?: string[];
};
```

### 동작 방식
- `codex` CLI (`codex exec` 모드)를 자식 프로세스로 spawn
- stdin/stdout으로 **JSONL 이벤트** 교환
- TypeScript 레이어는 "얇은 래퍼"

### 스트리밍 이벤트 (`runStreamed`가 방출)
```typescript
type ThreadEvent =
  | { type: "thread.started", thread_id: string }
  | { type: "turn.started" }
  | { type: "turn.completed", usage: Usage }
  | { type: "turn.failed", error: ThreadError }
  | { type: "item.started", item: ThreadItem }
  | { type: "item.updated", item: ThreadItem }
  | { type: "item.completed", item: ThreadItem }
  | { type: "error", message: string };

type ThreadItem =
  | AgentMessageItem       // 에이전트 응답 텍스트
  | ReasoningItem          // 모델의 추론 요약
  | CommandExecutionItem   // shell 명령 실행 (in_progress/completed/failed)
  | FileChangeItem         // 파일 변경 (add/delete/update)
  | McpToolCallItem        // MCP tool 호출 (server, tool, arguments, result)
  | WebSearchItem          // 웹 검색 쿼리
  | TodoListItem           // 할일 목록
  | ErrorItem;
```

### 확인된 기능
- ✅ 스트리밍으로 **중간 reasoning/명령 실행/tool 호출/파일 변경을 실시간 관찰 가능**
- ✅ `config` 파라미터로 임의 `--config key=value` 오버라이드 (MCP 서버 설정 등)
- ✅ `env`로 환경변수 격리
- ✅ `outputSchema` (TurnOptions)로 구조화 JSON 출력
- ✅ `signal` (TurnOptions)로 AbortSignal 기반 취소
- ✅ 이미지 입력: `{ type: "local_image", path: "..." }`

### 확인된 미지원
- ❌ **커스텀 tool 등록 API 없음** — `tools`, `addTool`, `registerTool`, `FunctionTool` 등 API 부재
- ❌ **훅·콜백 API 없음** — `onToolCall`, `preToolUse`, `afterTurn` 등 부재
- ❌ **Mid-turn 입력 주입 불가** — `runStreamed()`는 관찰만, 턴 진행 중 메시지 추가 불가

---

## 2. Python SDK (`codex-app-server-sdk`)

> ⚠️ 공식 문서에 "**Experimental**"로 명시됨. API 안정성 보장 없음.

### 기본 API
```python
# 동기
with Codex() as codex:
    thread = codex.thread_start(model="gpt-5.4")
    result = thread.run("...")
    print(result.final_response)

# 비동기
async with AsyncCodex() as codex:
    thread = await codex.thread_start(model="gpt-5.4")
    result = await thread.run("...")
```

### 고급 API (`turn()` + `TurnHandle`)
```python
turn(input, *, approval_policy=None, cwd=None, effort=None,
     model=None, output_schema=None, personality=None,
     sandbox_policy=None, summary=None) -> TurnHandle

TurnHandle.steer(input: Input) -> TurnSteerResponse
TurnHandle.interrupt() -> TurnInterruptResponse
```

### 동작 방식
- **TypeScript SDK와 다른 프로토콜 사용**: `codex app-server` JSON-RPC v2 over stdio
- 런타임 의존: `openai-codex-cli-bin` (플랫폼별 바이너리)

### 확인된 기능 (TypeScript와 차이점)
- ✅ **`steer()`** — 활성 턴에 추가 input 주입 (사용자 수준)
- ✅ **`interrupt()`** — 활성 턴 중단
- ✅ 동기/비동기 API 모두 제공

### ⚠️ 주의 — "steer"의 의미
- `steer()`는 **사용자 input을 추가하는 것**이지 **tool_result를 주입하는 것이 아님**
- 모델은 steer된 메시지를 **"사용자가 대화 중간에 덧붙인 말"로 해석**
- OpenAI Function-calling 스타일의 `tool_call` → `tool_result` 왕복은 Python SDK로도 **불가**

### 확인된 미지원 (TypeScript와 동일)
- ❌ 커스텀 tool 등록 API 없음
- ❌ tool_result mid-turn 주입 불가 (steer는 user input 주입)
- ❌ tool-level preHook/postHook 콜백 없음

---

## 3. Codex CLI 기능 (양쪽 SDK 모두 아래 파일을 통해 활용 가능)

두 SDK 모두 같은 `codex` 바이너리를 사용하므로, **파일 시스템 기반 확장 기능들은 SDK 어느 쪽에서도 동일하게 작동**합니다.

### 3.1 Skills

**정의** (공식 문서 인용):
> "A skill packages instructions, resources, and optional scripts so Codex can follow a workflow reliably."

**파일 구조**:
```
my-skill/
├── SKILL.md             (필수)
├── scripts/             (선택)
├── references/          (선택)
├── assets/              (선택)
└── agents/openai.yaml   (선택, MCP 의존성 선언)
```

**SKILL.md 최소 형태**:
```yaml
---
name: skill-name
description: Explain exactly when this skill should and should not trigger.
---

Skill instructions for Codex to follow.
```

**호출**:
- 암시적: description 매칭으로 자동 선택
- 명시적: `/skills` (CLI/IDE) 또는 `$skill-name`

### 3.2 Subagents

**정의** (공식 문서 인용):
> "Codex can run subagent workflows by spawning specialized agents in parallel and then collecting their results in one response."

**파일 위치**:
- 전역: `~/.codex/agents/*.toml`
- 프로젝트: `<project>/.codex/agents/*.toml`

**최소 TOML**:
```toml
name = "agent_name"
description = "When to use this agent."
developer_instructions = "..."
```

**선택 필드**: `nickname_candidates`, `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`

**호출**: 자연어 — 사용자가 parent에게 "have agent_name do X"라고 지시

### 3.3 Hooks

**정의**: `.codex/hooks.json`에 정의되는 이벤트 훅

**이벤트 6종**: `SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `UserPromptSubmit`, `Stop`

**⚠️ 현재 한계**:
- `PreToolUse` / `PostToolUse`는 **Bash 호출만 지원** (기타 도구 호출에는 발화 안 됨)
- 훅은 **외부 명령 실행** 방식 (내부 JS 콜백 아님)

### 3.4 MCP (Model Context Protocol)

- 서버 설정: `config.toml` 또는 `--config mcp.servers.<name>.*`
- stdio / http 전송 지원
- 외부 tool 확장의 **가장 공식적인 경로**

---

## 4. 확인된 구조적 한계 (2026-04-23 기준)

1. **커스텀 tool 등록 API 부재** — 어느 SDK도 TypeScript/Python 함수를 LLM 호출 가능한 tool로 등록하는 API 없음. MCP가 유일한 공식 확장 경로.

2. **계층적 Subagent만 지원** — Codex 네이티브 subagent는 parent가 종합 권한 독점. Subagent의 **veto 권한 없음**. Peer/adversarial 패턴은 네이티브 불가.

3. **Mid-turn tool_result injection 불가** — Python `steer()`도 user input 주입이며 tool_result 주입 아님. Function-calling 왕복 프로토콜 미지원.

4. **Hooks의 범위 제한** — 현재 PreToolUse/PostToolUse는 Bash만. MCP tool이나 기타 tool 호출에는 발화 안 됨.

5. **SDK와 CLI의 프로토콜 분리** — TypeScript SDK는 `codex exec` (단방향 JSONL), Python SDK는 `codex app-server` (JSON-RPC v2). 기능 차이가 나는 이유는 프로토콜 차이.

---

## 5. 로컬 코드베이스 통합 상태

**`custom/codex/runtime/codex-service.js:53`**
```js
function resolveRuntime() {
    return "sdk";  // 하드코딩 — CLI 런타임은 cf23540에서 제거됨
}
```

**실제 사용 중**: TypeScript SDK via `sdk-runtime.js`. CLI 런타임 분기는 없음.

**MCP 사용**: `CodexMcpToolset` 노드가 `__codexMcpToolset` 마커로 자신을 식별. `getConnectedCodexToolsets()`가 이 마커로 필터링.

**Skills / Subagents / Hooks 사용 상태**: **현재 미사용**. `.codex/` 디렉토리 내 해당 파일 없음. Phase 4에서 채택 예정 (MULTI_AGENT_STRATEGY.md 참조).

---

## 6. 재검증 절차

### 6.1 언제 재검증해야 하는가

- **매월 1회** 정기 검증 (권장: 매월 첫 주)
- **방향 결정 전** 항상 (공식 기능에 의존하는 아키텍처 결정 시)
- **Codex SDK 버전 업데이트 직후**
- **공식 블로그/체인지로그에서 "tool", "SDK", "subagent", "hook" 관련 발표 있을 때**

### 6.2 확인 대상 URL (필수)

```
[공식 문서]
https://developers.openai.com/codex
https://developers.openai.com/codex/sdk
https://developers.openai.com/codex/cli
https://developers.openai.com/codex/skills
https://developers.openai.com/codex/subagents
https://developers.openai.com/codex/hooks
https://developers.openai.com/codex/mcp

[GitHub 공식 레포]
https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/README.md
https://raw.githubusercontent.com/openai/codex/main/sdk/python/README.md
https://raw.githubusercontent.com/openai/codex/main/sdk/python/docs/api-reference.md
https://github.com/openai/codex/tree/main/sdk/typescript/src
https://github.com/openai/codex/tree/main/sdk/python/examples

[로컬]
n8n_custom_node/node_modules/@openai/codex-sdk/dist/index.d.ts
n8n_custom_node/node_modules/@openai/codex-sdk/package.json
```

### 6.3 자동화 스크립트

```bash
cd n8n_custom_node
node scripts/verify-codex-facts.mjs
```

스크립트는:
1. 위 URL들을 fetch하여 스냅샷 저장 (`.codex-facts-cache/<date>/`)
2. 이전 스냅샷과 diff
3. 변경된 섹션 리포트
4. 이 문서(`CODEX_PLATFORM_FACTS.md`)의 "Last verified" 날짜 업데이트 제안

### 6.4 각 팩트에 대해 확인할 체크리스트

**SDK TypeScript**:
- [ ] `package.json`의 버전이 변경됐는가?
- [ ] `index.d.ts`에 새 export가 추가됐는가? (특히 `tools`, `onToolCall`, `hooks`, `Agent` 키워드)
- [ ] `runStreamed()` 이벤트 타입이 확장됐는가?
- [ ] README에 새 예제가 추가됐는가?

**SDK Python**:
- [ ] `experimental` 표시가 제거됐는가?
- [ ] `TurnHandle`에 새 메서드가 추가됐는가?
- [ ] tool_result 관련 API가 신설됐는가?

**CLI Features**:
- [ ] 새 hook 이벤트가 추가됐는가?
- [ ] PreToolUse/PostToolUse가 Bash 외 도구 지원하는가?
- [ ] Subagent가 veto/gating 기능 추가했는가?
- [ ] 새 확장 메커니즘이 도입됐는가? (예: custom function tools)

**한계 재검증**:
- [ ] "커스텀 tool 등록 API 없음" — 여전히 맞는가?
- [ ] "Mid-turn tool_result injection 불가" — 여전히 맞는가?
- [ ] "계층적 Subagent만 지원" — 여전히 맞는가?

### 6.5 변경 발견 시 조치

1. **본 문서 갱신** — 변경된 팩트 수정 + "Last verified" 날짜 갱신 + 변경 이력 추가
2. **`MULTI_AGENT_STRATEGY.md` 영향 검토** — 전략이 영향받는지 확인, 필요 시 업데이트
3. **아키텍처 결정 재검토** — 새로운 기능이 기존 제약을 해제하는지 확인
4. **Windows 호스트에 공유** — `CROSS_HOST_NOTES.md`에 변경사항 기록

---

## 7. 변경 이력

| 날짜 | 변경 | 검증자 |
|------|------|-------|
| 2026-04-23 | 초기 작성 — Codex SDK 0.117.0 기준 | Claude Opus 4.7 |
