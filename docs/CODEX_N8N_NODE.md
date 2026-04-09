# Codex n8n Custom Nodes

이 레포지토리는 `custom/codex` 디렉터리 아래에 OpenAI Codex SDK 기반 커스텀 노드 스택을 제공합니다.

---

## 노드 목록

### 메인 노드

| 노드 | 타입 | 설명 |
|------|------|------|
| **Codex Agent** | Root Node | SDK 기반 메인 AI 에이전트. 세션 연속성, 메모리, MCP, 스트리밍 지원 |
| **Codex Agent Tool** | AiTool | Codex를 n8n AI Agent의 서브에이전트 tool로 노출 |
| **Codex Agent Registry** | Utility | 에이전트 프로필 CRUD + capability 기반 Lookup |

### 서브 노드 (설정 제공자)

| 노드 | 출력 타입 | 설명 |
|------|-----------|------|
| **Codex Memory** | AiMemory | 세션 바인딩 + transcript 미러 + Persistent Memory |
| **Codex MCP Toolset** | AiTool | MCP 서버 설정을 Agent/AgentTool에 주입 |

### Credential

| 이름 | 설명 |
|------|------|
| **Codex ChatGPT Account** | ChatGPT 계정 인증. profileKey 기반 격리 저장 |

---

## 레포지토리 규약

- 이 레포는 공유 커스텀 노드 소스, 공유 의존성, 공유 문서만 관리합니다.
- 각 호스트는 자체 n8n 런타임, `.env`, DB, 로그, 프로세스 매니저를 유지합니다.
- Codex 계정 인증은 n8n Credentials의 **Codex ChatGPT Account**로 관리하며, 인증 상태는 `data/codex-profiles/{profileKey}/codex-home`에 계정별로 격리 저장됩니다.

---

## 런타임 아키텍처

4개 레이어 + 3개 유틸리티 모듈로 구성됩니다.

### 레이어

```
[노드 UI]        CodexAgent / CodexAgentTool / CodexMemory / CodexMcpToolset / CodexAgentRegistry
    ↓
[런타임]         codex-service.js → sdk-runtime.js → @openai/codex-sdk
    ↓
[스토어]         codex-store / codex-memory-store / codex-agent-registry-store / codex-agent-message-store
    ↓
[관측성]         codex-observability (이벤트 정규화 · 아티팩트 추출 · 컨텍스트 압력)
```

### 유틸리티

| 모듈 | 역할 |
|------|------|
| `lib/codex-hooks.js` | Lifecycle Hook 시스템 (6개 hook point) |
| `lib/codex-auth-bridge.js` | OAuth2 인증 브릿지 (포트 3481) |
| `lib/node-runtime-helpers.js` | 노드 간 공통 필드·옵션 빌더 |
| `lib/node-ui-helpers.js` | Logs 트리 브릿지, 스트리밍 UI, 턴 요약 포맷 |
| `lib/codex-profile-utils.js` | 프로필 경로 해석, Codex CLI spawn, 플랫폼 호환 |
| `lib/codex-utils.js` | 공통 유틸 (경로, 문자열, 환경변수 해석) |

---

## 세션 모델

### Session Strategy

| 전략 | 동작 | 권장 사용처 |
|------|------|-------------|
| **Auto Resume** | sessionId → SHA-256 바인딩 키로 threadId 자동 복원 | 채팅형 워크플로 |
| **Always New** | 매 실행마다 새 thread 생성 | 서브에이전트, 일회성 작업 |
| **Specific Thread ID** | 지정된 threadId로 강제 이어가기 | 디버깅, 특수 케이스 |
| **Last Thread** | SDK의 마지막 thread 재개 | 간단한 연속 작업 |

### Auto Resume 바인딩 키

다음 5개 필드의 SHA-256 해시로 생성됩니다:
- `workflowId`, `nodeId`, `sessionId`, `codexHome`, `workingDirectory`

### Thread 복구

저장된 threadId가 유효하지 않으면:
1. 새 thread를 자동 생성
2. 바인딩 업데이트
3. `session_recovery` 아티팩트 기록
4. `sessionRecovered: true` 플래그 반환

---

## 데이터베이스 테이블

n8n 데이터베이스(SQLite)에 첫 사용 시 자동 생성됩니다.

| 테이블 | 용도 |
|--------|------|
| `codex_runs` | 실행 기록 (상태, 토큰, 모델, 소요 시간) |
| `codex_run_events` | SDK 이벤트 로그 (순서 보장) |
| `codex_run_artifacts` | 파일 변경, MCP 호출, shell 명령, git diff |
| `codex_session_bindings` | sessionId → threadId 매핑 |
| `codex_agent_memories` | Persistent Memory (scope, category, relevance) |
| `codex_agent_registry` | 에이전트 프로필 (모델, 지침, sandbox, MCP) |
| `codex_agent_messages` | 오케스트레이션 inter-agent 메시지 |

---

## Persistent Memory

### 개요

`Codex Memory` 노드에서 **Enable Persistent Memory**를 켜면 `codex_agent_memories` 테이블에 저장된 메모리가 프롬프트에 자동 주입됩니다.

### 메모리 속성

| 속성 | 설명 |
|------|------|
| **scope** | session / agent / project / user |
| **category** | fact / preference / instruction / context / compacted |
| **relevance_score** | 0~1 범위, Min Relevance Score 이상만 주입 |
| **access_count** | 조회 횟수 (자동 증가) |
| **expires_at** | 만료 시간 (선택사항) |

### 자동 저장

에이전트 응답에 다음 마커가 포함되면 자동으로 메모리 저장:
- `[MEMORY_SAVE] 내용`
- `[REMEMBER] 내용`
- `[메모리 저장] 내용`

마커가 없으면 Q&A 요약이 context 카테고리로 저장됩니다.

---

## Agent Registry

에이전트 프로필을 중앙에서 관리합니다.

### 프로필 필드

| 필드 | 설명 |
|------|------|
| `agentKey` | 고유 식별자 (예: `code-reviewer`) |
| `displayName` | 표시 이름 |
| `description` | 역할 설명 |
| `capabilities` | 기능 태그 (쉼표 구분) |
| `defaultModel` | 기본 모델 |
| `defaultSystemInstructions` | 기본 시스템 지침 |
| `defaultSandbox` | 기본 샌드박스 모드 |
| `defaultMcpServers` | 기본 MCP 서버 목록 (JSON) |
| `memoryScope` | 기본 메모리 범위 |
| `priority` | 우선순위 (Lookup 정렬) |
| `enabled` | 활성 상태 |

### AgentTool 연동

`Codex Agent Tool`의 **Agent Profile Key** 필드에 프로필 키를 입력하면:
1. Registry에서 프로필 자동 로드
2. 모델, 시스템 지침, 샌드박스, MCP 서버 기본값 적용
3. 노드에서 직접 설정한 값이 프로필보다 우선

---

## Inter-Agent Communication

오케스트레이터와 서브에이전트 간 메시지를 `codex_agent_messages` 테이블에 저장합니다.

### 메시지 타입

| 타입 | 용도 |
|------|------|
| `task` | 오케스트레이터 → 서브에이전트 작업 위임 |
| `result` | 서브에이전트 → 오케스트레이터 결과 반환 |
| `context` | 공유 컨텍스트 정보 |
| `feedback` | 오류 또는 피드백 |

### 컨텍스트 주입

`orchestrationId`와 `agentKey`가 설정된 실행은:
- **Delegation Context**: 이 에이전트에게 보낸 메시지를 시스템 프롬프트에 주입
- **Shared Context**: 다른 에이전트 간 처리 완료된 메시지를 공유 컨텍스트로 주입

---

## Lifecycle Hooks

`lib/codex-hooks.js`에서 6개 hook point를 제공합니다.

| Hook | 시점 | 용도 |
|------|------|------|
| `preAgentStart` | 에이전트 실행 전 | 요청 전처리, 로깅 |
| `postAgentComplete` | 성공 완료 후 | 결과 후처리, 메시지 전송 |
| `onError` | 실행 실패 시 | 에러 보고, fallback |
| `preToolUse` | SDK tool 이벤트 전 (스트리밍) | tool 사용 감사 |
| `postToolUse` | SDK tool 이벤트 후 (스트리밍) | tool 결과 추적 |
| `onStop` | 실행 중단/타임아웃 시 | 정리 작업 |

- 글로벌 레지스트리 (priority 기반) + 노드별 hook을 병합 실행
- **모든 hook 실패는 메인 실행을 차단하지 않습니다**

---

## 관측성 (Observability)

### 이벤트 저장

모든 SDK 이벤트는 `codex_run_events`에 저장됩니다. `Include Events In Output` 옵션은 노드 출력에 이벤트를 포함할지만 제어합니다.

### 아티팩트 종류

| kind | 설명 |
|------|------|
| `command` | shell 명령 실행 |
| `file_change` | 파일 생성/수정/삭제 |
| `mcp_tool_call` | MCP tool 호출 |
| `web_search` | 웹 검색 사용 |
| `git_status` / `git_diff` | Git 상태 스냅샷 |
| `session_recovery` | Thread 복구 이벤트 |

### Context Pressure

토큰 사용량 기반으로 컨텍스트 압력 수준을 계산합니다:
- `low` / `medium` / `high` / `critical`
- `recommendedAction` 필드에 권장 조치 제공

---

## 오케스트레이션 패턴

### 기본 패턴: Orchestrator + Sub-Agents

```
[Chat Trigger] → [Codex Agent (Orchestrator)]
                      ↳ Tool: [Codex Agent Tool (Code Reviewer)] ← Memory, MCP
                      ↳ Tool: [Codex Agent Tool (Test Writer)]   ← Memory
                      ↳ Tool: [Codex Agent Tool (Doc Writer)]    ← MCP
```

오케스트레이터 Agent의 System Instructions에 라우팅 규칙을 명시합니다.

### 프로필 기반 패턴

1. Registry에 에이전트 프로필 등록 (register)
2. 각 AgentTool에 `agentProfileKey` 설정
3. 프로필에서 모델, 지침, 샌드박스, MCP 자동 로드

### 설정 우선순위

```
Registry 기본값 < 노드 직접 설정 < 호출 시 파라미터
```

---

## 권장 기본 설정

### 직접 채팅 워크플로

```
[When chat message received] → [Codex Agent] ← [Codex Memory] ← [Codex MCP Toolset]
```

| 필드 | 권장값 |
|------|--------|
| Session Strategy | Auto Resume |
| Session ID | `={{ $json.sessionId }}` |
| Include Events In Output | false |

### 서브에이전트 워크플로

```
[Trigger] → [AI Agent] ← [Codex Agent Tool] ← [Codex Memory] ← [Codex MCP Toolset]
```

| 필드 | 권장값 |
|------|--------|
| Session Strategy | Always New |
| Ephemeral | true |

---

## 설치 검증

공유 레포 루트에서 의존성 설치:

```bash
cd /absolute/path/to/n8n_custom_node
npm install
```

**`custom/codex` 안에서 `npm install` 절대 금지** — n8n 시작 실패 원인.

`N8N_CUSTOM_EXTENSIONS`를 이 레포의 `custom` 디렉터리로 설정한 뒤 호스트 런타임에서 확인:

```bash
npm run check:codex-node
npm run export:codex-nodes
```

---

## 현재 제한사항

- `Codex Agent`는 `Codex MCP Toolset` 입력을 우선 이해합니다. 임의 LangChain tool은 아직 완전히 지원되지 않습니다.
- 대시보드 템플릿은 쿼리 팩이며 완성된 차트 UI가 아닙니다.
- MCP 서버 시작 타임아웃이 길면 첫 실행이 느릴 수 있습니다.
- Persistent Memory의 자동 압축(compaction)은 아직 수동 트리거만 가능합니다.
