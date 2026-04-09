# Codex Multi-Agent Architecture

이 문서는 n8n 위에 구축된 Codex 멀티에이전트 시스템의 전체 아키텍처를 설명합니다.

---

## 1. 시스템 개요

```
┌─────────────────────────────────────────────────────────┐
│                    n8n Workflow Engine                    │
│                                                          │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │  Trigger  │→ │ Codex Agent  │← │ Codex Memory       │ │
│  │ (Chat/    │  │ (Orchestrator)│← │ Codex MCP Toolset  │ │
│  │  Manual/  │  │              │  └────────────────────┘ │
│  │  Webhook) │  │   ┌─────────┤                          │
│  └──────────┘  │   │  Tools  │                          │
│                │   └────┬────┘                          │
│                └────────┼────────────────────────────── │
│                    ┌────┴────┐                           │
│           ┌───────┤ AgentTool├───────┐                  │
│           │       │(Reviewer)│       │                  │
│           │       └──────────┘       │                  │
│    ┌──────┴─────┐            ┌──────┴─────┐            │
│    │  AgentTool │            │  AgentTool │            │
│    │(TestWriter)│            │(DocWriter) │            │
│    └────────────┘            └────────────┘            │
└─────────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
┌─────────────────┐    ┌──────────────────────┐
│  OpenAI Codex   │    │  SQLite Database     │
│  SDK Runtime    │    │  (codex_* tables)    │
│  (@openai/      │    │                      │
│   codex-sdk)    │    │  - runs              │
└─────────────────┘    │  - events            │
                       │  - artifacts         │
                       │  - session_bindings  │
                       │  - memories          │
                       │  - registry          │
                       │  - messages          │
                       └──────────────────────┘
```

---

## 2. 레이어 아키텍처

### 2.1 노드 레이어 (Presentation)

사용자가 n8n 에디터에서 드래그&드롭으로 조합하는 노드들입니다.

| 노드 | 파일 | 역할 |
|------|------|------|
| Codex Agent | `CodexAgent.node.js` | 메인 대화 노드. 프롬프트 입력 → Codex SDK 실행 → 결과 출력 |
| Codex Agent Tool | `CodexAgentTool.node.js` | n8n AI Agent의 tool로 동작. 부모 에이전트가 호출 |
| Codex Agent Registry | `CodexAgentRegistry.node.js` | 에이전트 프로필 CRUD + capability 매칭 |
| Codex Memory | `CodexMemory.node.js` | 세션 바인딩 설정 + Persistent Memory 주입 |
| Codex MCP Toolset | `CodexMcpToolset.node.js` | MCP 서버 설정 제공 (saved/stdio/http) |

### 2.2 런타임 레이어 (Business Logic)

```
codex-service.js
├── executeAgentRun()        ← 메인 진입점
│   ├── resolveRuntime()     → "sdk" (고정)
│   ├── createRun()          → DB에 실행 기록 생성
│   ├── lifecycle.preAgentStart()
│   ├── memory injection     → Persistent Memory 프롬프트 주입
│   ├── orchestration inject → Delegation + Shared Context 주입
│   ├── executeWithRuntime() → sdk-runtime.js 호출
│   │   └── runSdkAgent()
│   │       ├── buildCodexConfig()  → credential → Codex 설정
│   │       ├── buildPrompt()       → 프롬프트 조립
│   │       ├── new Codex({...})    → SDK 클라이언트 생성
│   │       ├── thread.run/runStreamed()  → 실행
│   │       └── isToolEvent() + hooks    → 스트리밍 중 hook 실행
│   ├── normalizeEvents()    → 이벤트 정규화
│   ├── extractArtifacts()   → 아티팩트 추출
│   ├── insertRunEvents()    → DB 저장
│   ├── insertRunArtifacts() → DB 저장
│   ├── upsertSessionBinding() → 세션 바인딩 갱신
│   ├── completeRun()        → DB에 완료 기록
│   ├── autoExtractAndSaveMemories() → 메모리 자동 저장
│   ├── lifecycle.postAgentComplete()
│   └── sendMessage()        → 오케스트레이션 결과 메시지
└── executeRecoveredRun()    ← thread 복구 시
```

### 2.3 스토어 레이어 (Data Access)

| 모듈 | 테이블 | 핵심 함수 |
|------|--------|-----------|
| `codex-store.js` | `codex_runs`, `codex_run_events`, `codex_run_artifacts`, `codex_session_bindings` | createRun, completeRun, insertRunEvents, upsertSessionBinding |
| `codex-memory-store.js` | `codex_agent_memories` | createMemory, queryMemories, evaluateMemory, mergeMemories, compactMemories |
| `codex-agent-registry-store.js` | `codex_agent_registry` | registerAgent, getAgentByKey, updateAgent, lookupByCapability |
| `codex-agent-message-store.js` | `codex_agent_messages` | sendMessage, getAgentInbox, buildSharedContext, buildDelegationContext |

모든 스토어는 `@n8n/typeorm`의 DataSource를 통해 n8n과 같은 SQLite DB를 사용합니다.
테이블은 첫 접근 시 `CREATE TABLE IF NOT EXISTS`로 자동 생성됩니다.

### 2.4 관측성 레이어 (Observability)

`codex-observability.js`가 제공하는 기능:

| 함수 | 역할 |
|------|------|
| `normalizeEvents()` | SDK 이벤트를 일관된 형식으로 변환 |
| `extractArtifactsFromEvents()` | 이벤트에서 아티팩트(파일변경, MCP호출 등) 추출 |
| `captureGitArtifacts()` | git status/diff 스냅샷 |
| `buildContextPressure()` | 토큰 사용량 → 컨텍스트 압력 수준 계산 |
| `buildExecutionDetails()` | 실행 상세 집계 (MCP, 명령, 파일변경, 타임라인) |
| `buildOutputEvents()` | 출력용 이벤트 정제 (summary/full/minimal) |

---

## 3. 데이터 흐름

### 3.1 단일 에이전트 실행

```
사용자 입력
    │
    ▼
[Codex Agent] ── getBaseNodeContext() ──→ credential 해석, codexHome 결정
    │
    ├── getConnectedCodexMemory() ──→ sessionId, transcript, persistent memory
    ├── getConnectedCodexToolsets() ──→ MCP 서버 설정
    │
    ▼
[codex-service.js] executeAgentRun()
    │
    ├── createRun() ──→ DB: codex_runs (status=in_progress)
    ├── lifecycle.preAgentStart()
    ├── memory + orchestration context 주입
    │
    ▼
[sdk-runtime.js] runSdkAgent()
    │
    ├── new Codex({config, apiKey, env})
    ├── thread = startThread/resumeThread
    ├── thread.run(prompt) 또는 thread.runStreamed(prompt)
    │   └── [스트리밍 시] 이벤트 루프:
    │       for await (event of streamed.events)
    │           → preToolUse hook
    │           → events.push(event)
    │           → onEvent callback (UI 스트리밍)
    │           → postToolUse hook
    │
    ▼ 결과 반환
    │
[codex-service.js] 후처리
    │
    ├── normalizeEvents() → insertRunEvents() ──→ DB: codex_run_events
    ├── extractArtifacts() → insertRunArtifacts() ──→ DB: codex_run_artifacts
    ├── upsertSessionBinding() ──→ DB: codex_session_bindings
    ├── completeRun() ──→ DB: codex_runs (status=completed)
    ├── autoExtractAndSaveMemories() ──→ DB: codex_agent_memories
    └── lifecycle.postAgentComplete()
```

### 3.2 멀티에이전트 오케스트레이션

```
[Chat Trigger]
    │
    ▼
[Codex Agent - Orchestrator]
    │ System Instructions:
    │ "코드 리뷰가 필요하면 code_reviewer tool을,
    │  테스트 작성이 필요하면 test_writer tool을 사용하세요."
    │
    ├── Codex SDK가 tool 호출 결정
    │
    ▼
[Codex Agent Tool - code_reviewer]
    │ agentProfileKey: "code-reviewer"
    │   → Registry에서 프로필 로드
    │   → 프로필 시스템 지침 + 노드 지침 + 호출 시 지침 병합
    │   → 프로필 모델/샌드박스 기본값 적용
    │
    ├── executeAgentRun() → 독립 SDK 세션
    │   ├── orchestrationId가 있으면:
    │   │   ├── buildDelegationContext() → 위임 메시지 주입
    │   │   └── buildSharedContext() → 다른 에이전트 결과 공유
    │   └── 완료 후: sendMessage(result) → codex_agent_messages
    │
    ▼ tool 결과를 부모에게 반환
    │
[Orchestrator가 다음 tool 결정]
    │
    ▼
[Codex Agent Tool - test_writer]
    │ 위와 동일한 흐름
    │ + Shared Context에 code_reviewer의 결과 포함
    │
    ▼
[Orchestrator가 최종 응답 생성]
```

### 3.3 메모리 흐름

```
[CodexMemory.supplyData()]
    │
    ├── resolveSessionId() → sessionId 결정
    ├── enablePersistentMemory? → queryMemories(filters)
    │                            buildMemoryPromptSection(filters)
    │
    ▼ memory 객체 반환
    │
[codex-service.js]
    │
    ├── transcript 조회 (mirrorTranscript일 때)
    │   └── listRecentTranscriptEntries()
    │
    ├── persistent memory 주입
    │   └── systemInstructions += memoryPromptSection
    │
    ▼ 에이전트 실행 후
    │
    ├── autoSaveMemories?
    │   └── autoExtractAndSaveMemories()
    │       ├── [MEMORY_SAVE] / [REMEMBER] / [메모리 저장] 마커 추출
    │       └── createMemory() → DB: codex_agent_memories
    │
    ▼ 다음 실행 시 → 저장된 메모리가 다시 프롬프트에 주입
```

---

## 4. 설정 우선순위 체계

여러 곳에서 동일한 설정을 지정할 수 있을 때의 우선순위입니다.

### System Instructions

```
[최저] Registry 프로필 defaultSystemInstructions
  ↓
[중간] 노드에서 직접 설정한 System Prompt
  ↓
[최고] 호출 시 query.systemInstructions (AgentTool만)
```

세 값은 `\n\n`으로 연결되어 모두 적용됩니다 (덮어쓰기가 아닌 병합).

### Model

```
[최저] Registry 프로필 defaultModel
  ↓
[최고] 노드에서 직접 설정한 Model Preset / Custom Model
```

노드에서 모델을 설정하면 Registry 값을 무시합니다.

### Sandbox

```
[최저] Registry 프로필 defaultSandbox
  ↓
[최고] 노드에서 직접 설정한 Sandbox 모드
```

### MCP Servers

```
Registry 프로필 defaultMcpServers + 노드 연결 MCP Toolset → 병합
(같은 serverName이면 노드 연결 설정이 우선)
```

---

## 5. Lifecycle Hooks

### Hook 실행 흐름

```
executeAgentRun()
    │
    ├── createLifecycleHooks(nodeHooks)
    │
    ├── preAgentStart ──────────────────────── 실행 전 처리
    │
    ├── [스트리밍 중]
    │   ├── preToolUse ─── tool 이벤트 감지 ─── tool 사용 전
    │   └── postToolUse ── tool 이벤트 감지 ─── tool 사용 후
    │
    ├── [성공 시] postAgentComplete ──────────── 완료 후 처리
    │
    └── [실패 시] onError ───────────────────── 에러 처리
```

### Hook 등록 방법

```javascript
const { registerHook } = require("./lib/codex-hooks");

// 글로벌 hook 등록 (모든 에이전트에 적용)
registerHook("postAgentComplete", async (ctx) => {
    console.log(`완료: ${ctx.request.nodeId}, threadId: ${ctx.result.threadId}`);
}, { priority: 10, label: "my-logger" });
```

### 내장 Hook 팩토리

| 팩토리 | 용도 |
|--------|------|
| `createTimingHook()` | 실행 시간 측정 |
| `createLoggingHook(logger)` | 시작/완료/에러 로깅 |
| `createMessageHook(messageStore)` | 오케스트레이션 메시지 자동 전송 |

---

## 6. MCP 통합

### 서버 설정 경로

```
[CodexMcpToolset 노드]
    │
    ├── saved: CODEX_HOME/config.toml에 등록된 서버
    ├── stdio: 명령어 + 인자로 직접 정의
    └── http:  URL + Bearer 토큰으로 직접 정의
    │
    ▼ buildCodexMcpConfig(toolsets)
    │
[codex-service.js]
    │
    ├── mcpConfigured 집계 (서버 수, 서버 목록)
    ├── codexConfig.mcpServers 구성
    │
    ▼ Codex SDK가 MCP 서버 시작 및 tool 호출
    │
    ▼ 실행 후
    ├── mcpCalls: 실제 호출된 MCP tool 목록
    ├── usedMcpServers: 사용된 서버 이름
    └── unusedMcpServers: 설정됐지만 사용되지 않은 서버
```

### Include/Exclude 필터링

```
includeTools: ["jira_get_issue", "jira_search"]
  → config의 enabled_tools에 반영
  → 이 tool만 에이전트에 노출

excludeTools: ["jira_delete_issue"]
  → config의 disabled_tools에 반영
  → 이 tool은 에이전트에서 숨김
```

---

## 7. 인증 아키텍처

```
[n8n Credential: CodexChatgptAccount]
    │
    ├── profileKey (고유 식별자)
    ├── authMode: browser / deviceCode
    ├── codexExecutable: Codex CLI 경로
    │
    ▼ getBaseNodeContext()
    │
    ├── codexHome = data/codex-profiles/{profileKey}/codex-home/
    ├── env = { CODEX_HOME: codexHome, ... }
    │
    ▼ Codex SDK에 env 전달 → 격리된 인증 컨텍스트
```

---

## 8. 향후 개선 방향

### OpenAI 공식 Codex와의 정렬

| 공식 기능 | 현재 상태 | 개선 방향 |
|-----------|-----------|-----------|
| TOML 에이전트 정의 | Registry SQLite → 호환 접근 | TOML import/export 지원 |
| `agents.max_threads` | 미구현 | Registry에 `maxConcurrent` 필드 존재, 런타임 적용 필요 |
| `agents.max_depth` | 미구현 | 재귀 호출 깊이 제한 추가 |
| SKILL.md 시스템 | `skillDirectories` 지원 | UI에서 Skill 경로 설정 노출 |
| `nickname_candidates` | 미구현 | Registry에 필드 추가 가능 |
| 배치 처리 | 미구현 | n8n의 Loop/SplitInBatches와 조합 가능 |

### 메모리 고도화

- LLM 기반 메모리 압축 (`compactMemories`)의 자동 트리거
- 메모리 간 유사도 기반 병합
- TTL(Time-To-Live) 기반 자동 만료

### 오케스트레이션 고도화

- `CodexOrchestrator` 전용 노드 (라우팅 전략, 결과 집계)
- capability-match 자동 라우팅
- 동시 실행 제한 (`maxConcurrent`)
