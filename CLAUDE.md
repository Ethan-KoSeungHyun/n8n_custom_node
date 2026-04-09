# CLAUDE.md — Codex n8n Custom Nodes

이 파일은 Claude Code가 자동으로 읽는 프로젝트 컨텍스트입니다.
**코드만 봐서는 알 수 없는 것**만 기록합니다. 구현 상세는 코드를 직접 읽으세요.

---

## 운영 환경 구성 (중요)

이 레포는 **공유 소스**이며, 각 호스트는 별도의 런타임 폴더를 가집니다.

| 환경 | 런타임 위치 | n8n 접근 URL |
|---|---|---|
| macOS (서버) | `~/Documents/Project/N8N_SERVER` | `https://n8n.seunghyun.space` |
| Windows (클라이언트) | `D:\Project\N8N_SERVER` (예시) | 로컬 또는 동일 URL |

**공유 레포 위치 (macOS):**
```
~/Documents/Project/N8N_SERVER/n8n_custom_node/  (이 레포, 직접 clone)
```

**Cloudflare Tunnel (macOS 기준):**
- `n8n.seunghyun.space` → `localhost:5678` (n8n)
- `codex-bridge.seunghyun.space` → `localhost:3481` (인증 브릿지)

---

## 인증 아키텍처 (핵심 결정사항)

### 구 방식 (제거됨)
- 전역 `CODEX_HOME` 환경변수 하나로 모든 워크플로가 같은 Codex 계정 공유
- `codexApi` credential 타입 사용

### 현재 방식 (profile 기반)
- `CodexChatgptAccount` credential 1개 = Codex 계정 1개
- 각 credential은 고유한 `profileKey`를 가지며, 인증 상태는 아래에 격리 저장:
  ```
  {N8N_USER_FOLDER}/data/codex-profiles/{profileKey}/codex-home/
  ```
- 전역 `CODEX_HOME` 환경변수는 **더 이상 사용하지 않음**

### 인증 브릿지 (`lib/codex-auth-bridge.js`)
- n8n 프로세스 시작 시 `startAuthBridgeInBackground()`로 자동 실행 (포트 3481)
- n8n의 OAuth2 흐름을 Codex CLI `codex login` 프로세스로 프록시
- 외부 접근용 URL: `CODEX_AUTH_BRIDGE_BASE_URL` 환경변수로 설정
  - macOS 서버: `.env`에 `CODEX_AUTH_BRIDGE_BASE_URL=https://codex-bridge.seunghyun.space`

### Credential `bridgeEnvironment` 필드
- `local`: 브라우저와 n8n이 같은 머신일 때 → `http://localhost:3481`
- `remote`: 외부 브라우저(원격 접속)에서 Connect할 때 → `https://codex-bridge.seunghyun.space`
- **이유**: n8n OAuth 팝업이 브라우저에서 열리므로, 원격 브라우저는 서버의 localhost에 접근 불가

---

## 로그인 방식별 특성

| 방식 | 원격 사용 | 설명 |
|---|---|---|
| Device Code | ✅ 가능 | URL + 코드를 어느 기기에서든 입력 |
| 서버 브라우저 (Admin) | ❌ 불가 | `codex login`이 서버 로컬 브라우저를 열기 때문 |

**서버 브라우저 방식이 원격 불가인 이유:**
`codex login`은 `localhost:{랜덤포트}/callback`을 redirect_uri로 사용하며 OpenAI에 이미 등록된 로컬 전용 앱이므로 임의 도메인으로 교체 불가.

---

## 노드 구성

```
CodexAgent.node.js          메인 대화 노드 (SDK 기반)
CodexAgentTool.node.js      서브에이전트용 Tool 노드 (Agent Registry 프로필 로드 지원)
CodexAgentRegistry.node.js  에이전트 프로필 등록·조회·Lookup 노드
CodexMemory.node.js         세션 바인딩 + Persistent Memory 메모리
CodexMcpToolset.node.js     MCP 서버 설정 노드
CodexChatgptAccount.credentials.js  계정 인증 credential
```

**삭제된 노드 (과거 코드에서 보일 수 있음):**
- `CodexCli.node.js` — 제거됨
- `CodexApi.credentials.js` — `CodexChatgptAccount`로 교체됨

---

## Multi-Agent 아키텍처 (Phase 3)

코드만 봐서는 파악하기 어려운 **설계 결정과 데이터 흐름**을 기록합니다.

### 레이어 구조 (위 → 아래)

```
[n8n 노드 UI]  Agent / AgentTool / Memory / MCP Toolset / Registry
      ↓
[런타임]       codex-service.js → sdk-runtime.js → @openai/codex-sdk
      ↓
[스토어]       codex-store / codex-memory-store / codex-agent-registry-store / codex-agent-message-store
      ↓
[관측성]       codex-observability (이벤트·아티팩트·컨텍스트 압력)
      ↓
[유틸]         codex-hooks (lifecycle) / codex-auth-bridge / codex-utils
[UI 레이어]    node-ui-helpers (Logs 브릿지·스트리밍·턴 요약) / node-runtime-helpers (필드·옵션)
```

### n8n Logs 트리 통합 (핵심 설계)

SDK는 블랙박스이므로 n8n 빌트인 AI Agent처럼 Logs 트리에 엔트리를 남기려면 별도 브릿지가 필요하다.

**작동 원리:**
1. `CodexMemory.supplyData()` 시점에 `addInputData`/`addOutputData` 클로저를 캡처하여 `loggingBridge` 생성
2. `wrapHooksWithBridge(hooks, bridge)` (`node-ui-helpers.js`)가 SDK 스트리밍 이벤트를 브릿지 호출로 변환
3. 각 SDK 이벤트(command_execution, mcp_tool_call, file_change 등)가 Logs 트리에 개별 엔트리로 표시
4. **턴 요약**: 도구 호출 없는 단순 대화에서도 `turn.completed` 이벤트에서 응답 미리보기·토큰 사용량 엔트리 생성

**스트리밍 기본값 = true**: `runStreamed()` → `hooks.onEvent()`에 의존. 비스트리밍 `run()`은 hooks를 호출하지 않아 Logs가 생성되지 않음.

### 핵심 테이블 (SQLite, `data/.n8n/database.sqlite`)

| 테이블 | 용도 | 자동 생성 |
|--------|------|-----------|
| `codex_runs` | 실행 기록, 토큰 사용량 | ✅ |
| `codex_run_events` | SDK 이벤트 로그 | ✅ |
| `codex_run_artifacts` | 파일 변경, MCP 호출, git diff | ✅ |
| `codex_session_bindings` | sessionId → threadId 매핑 | ✅ |
| `codex_agent_memories` | Persistent Memory (평가·병합·삭제 가능) | ✅ |
| `codex_agent_registry` | 에이전트 프로필 (모델, 지침, MCP 등) | ✅ |
| `codex_agent_messages` | 오케스트레이션 inter-agent 메시지 | ✅ |

### 오케스트레이션 패턴

```
[Trigger] → [Codex Agent (Orchestrator)]
                 ↳ Tool: [Codex Agent Tool (code-reviewer)] ← Memory, MCP
                 ↳ Tool: [Codex Agent Tool (test-writer)]   ← Memory
```

- 오케스트레이터 Agent의 System Instructions에 라우팅 규칙을 명시
- 각 AgentTool에 `agentProfileKey`를 설정하면 Registry에서 프로필 자동 로드
- 프로필 우선순위: Registry 기본값 < 노드 직접 설정 < 호출 시 파라미터

### Lifecycle Hooks (`lib/codex-hooks.js`)

- 6개 hook point: preAgentStart, postAgentComplete, onError, preToolUse, postToolUse, onStop
- 글로벌 레지스트리 (priority 기반) + 노드별 hook 병합 실행
- hook 실패는 절대 메인 실행을 차단하지 않음 (catch-and-log)

### 메모리 자동 저장 마커

에이전트 응답에 다음 마커가 있으면 자동으로 `codex_agent_memories`에 저장:
- `[MEMORY_SAVE] 내용`
- `[REMEMBER] 내용`
- `[메모리 저장] 내용`

---

## 환경 간 주요 차이점

| 항목 | macOS | Windows |
|---|---|---|
| Codex CLI 경로 | `/opt/homebrew/bin/codex` | `C:\...\codex.cmd` (credential에 직접 설정) |
| 브릿지 접근 | `localhost:3481` 또는 Cloudflare URL | `localhost:3481` (로컬 실행 시) |
| Cloudflare tunnel | `~/.cloudflared/config.yml`에 두 개 route | 불필요 (로컬 접근) |
| NODE_PATH | 공유 레포 `node_modules` 자동 주입 | 동일 (HOST_SETUP_WINDOWS.md 참조) |

---

## 알려진 동작 특성

- `N8N_CUSTOM_EXTENSIONS` 경로 내 `node_modules`가 생기면 n8n 시작 실패. `custom/codex` 안에서 `npm install` 절대 금지.
- n8n 재시작 없이 커스텀 노드 코드 변경은 반영되지 않음 (심링크여도 동일).
- `codex-profiles` 디렉터리는 credential Connect 완료 후 자동 생성됨. 없어도 정상.
- 인증 브릿지는 n8n 프로세스 내에서 실행되므로 n8n 재시작 시 자동 재시작됨.

---

## 프로젝트 방향성 (최우선 원칙)

이 프로젝트는 장기적이고 큰 규모의 프로젝트다. **시간과 자원은 제약이 아니며, 옳은 방향이 유일한 기준이다.**

### 핵심 원칙

1. **n8n 코어 무수정**: n8n 서버/프론트엔드 코드는 절대 수정하지 않는다. 업데이트 호환성과 기존 지원 방식을 유지하기 위함.
2. **n8n 네이티브 통합**: 가능한 한 n8n이 공식 제공하는 패턴(EngineRequest/Response, addInputData, logAiEvent, sendChunk 등)을 사용한다. 커스텀 우회보다 정석 통합이 우선.
3. **Logs/UI 동등성**: Codex Agent가 n8n 빌트인 AI Agent와 동일한 수준의 Logs 트리, 스트리밍, 실행 추적을 제공해야 한다.
4. **점진적 진화**: 현재 SDK 기반 아키텍처에서 EngineRequest 기반으로 전환할 때, 기존 워크플로 호환성을 유지하면서 점진적으로 마이그레이션한다.
5. **한국어 UI**: 모든 사용자 대면 텍스트(description, hint, notice, 에러 메시지)는 한국어로 작성한다.

### 아키텍처 진화 방향 (Phase 4 목표)

현재: `Codex SDK (블랙박스)` → one-shot execute → 결과만 반환
목표: `EngineRequest/Response 패턴` → n8n 엔진이 매 단계 추적 → Logs 트리 완전 지원

구체적 전환 계획은 `docs/ARCHITECTURE.md`의 Phase 4 섹션에 기록한다.

---

## CLAUDE.md 업데이트 규칙

업데이트해야 할 때:
- 인증 구조 또는 환경 구성 변경 시
- 환경 간(macOS ↔ Windows) 동작 차이 새로 발견 시
- 노드/credential 타입 추가·제거 시

업데이트 불필요:
- 버그 픽스 (코드와 커밋 메시지로 충분)
- docs 내용 변경
- 코드로 읽을 수 있는 구현 상세
