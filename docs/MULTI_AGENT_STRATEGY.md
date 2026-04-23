# Multi-Agent 전략 (Phase 4 재정의)

> **최종 갱신**: 2026-04-23
> **상태**: 아키텍처 결정 — 진행 중 (구현 착수 전)
> **담당**: 이 레포의 Codex 커스텀 노드 전반

이 문서는 본 프로젝트의 **멀티에이전트 아키텍처 방향성**을 기록합니다. Phase 3에서 구축한 자산의 재평가와 Phase 4의 목표를 담습니다.

---

## 1. 핵심 구분 — 세 가지 멀티에이전트 패턴

멀티에이전트라는 용어는 구현에 따라 완전히 다른 것을 가리킬 수 있습니다. 이 프로젝트는 **세 가지 패턴을 구분**합니다.

### 패턴 A — 계층적 위임 (Hierarchical Delegation)

```
Parent가 방향을 정함 → Subagent에게 일부 작업 위임 → 결과 받음 → Parent가 종합
```

- Subagent는 **보조적 도우미** 역할
- Parent가 **종합 권한을 독점**: subagent 결과를 무시해도 차단되지 않음
- 목적: 작업 분해, 병렬 실행, 전문 역할 분리
- 예: "코드를 리뷰하려면 reviewer가 필요해" → reviewer 호출 → 보고서 수령 → parent 판단

### 패턴 B — 동료/적대적 (Peer / Adversarial)

```
Agent A 의견 ↔ Agent B 의견 → 상호 영향 → 합의 or 게이트 통과 → 진행
```

- **모든 참여 에이전트가 최종 결과에 실질적 영향**
- Agent가 **차단권(veto)** 또는 **게이트 통과 조건**을 가짐
- Parent 일방 결정 불가. 외부 오케스트레이션이 규칙 강제
- 목적: 검토, 논쟁, 합의, 검증, 품질 보장
- 예:
  - Planner가 방향을 제시하면 Critic이 반대 의견 제시 → Planner가 반영하지 않으면 구현 단계로 진입 불가
  - 3명 전문가의 PR 리뷰, 2/3 이상 반대면 merge 차단
  - Writer의 글을 Fact-checker가 검증, 사실 오류 있으면 강제 재작성

### 패턴 C — 파이프라인 (Sequential Pipeline)

```
Agent A → Agent B → Agent C → Output
```

- 각 단계는 독립적
- 앞 단계가 뒷 단계에 일방 전달
- 목적: 단순한 단계적 처리

---

## 2. 현재 기술 스택으로 각 패턴을 구현하는 방법

| 패턴 | 구현 수단 | 근거 |
|------|----------|------|
| A | **Codex 네이티브 subagents** (`.codex/agents/*.toml`) | Codex CLI 공식 기능. 사용자가 "이러한 조사에는 reviewer 써줘"라고 자연어로 지시하면 parent가 자동 spawn |
| B | **n8n 워크플로 + Phase 3 인프라** 병행 | Codex 자체는 B 미지원. 외부 오케스트레이션(게이트, 예산 제어, 메시지 라우팅) 필요 |
| C | **n8n 워크플로** | 노드 연결만으로 표현 가능 |

**중요**: 이 프로젝트의 **사용자가 원하는 것은 주로 B 패턴**입니다. "자신의 방향성에 반대되는 활동, 검토해서 반대 의견 제시, 방향 재조정"이 요구사항이며, 이는 Codex 네이티브로는 불가능합니다.

---

## 3. Phase 3 인프라의 재평가

Phase 3에서 구축한 자산들을 **패턴 관점에서 재평가**합니다.

| Phase 3 자산 | A 관점 | B 관점 | 결론 |
|-------------|-------|-------|------|
| `codex_agent_messages` (inter-agent 메시지 큐) | Codex 내부가 처리 → 중복 | **Peer 간 비동기 통신의 핵심** | **B용으로 유지** |
| `codex_agent_registry` (프로필 DB) | 파일 시스템(`.codex/agents/`)이 대체 → 일부 중복 | 동적 agent 구성, credential 격리에 유용 | **용도 재정의** |
| `buildSharedContext` / `buildDelegationContext` (AgentMessage store) | 불필요 | **Peer 간 상태 공유의 핵심** | **B용으로 유지** |
| 오케스트레이터 라우팅 시스템 프롬프트 | 불필요 | **Gate logic의 기반** | **B용으로 재설계** |
| `CodexAgentTool` (LangChain tool wrapper) | Codex 네이티브가 더 적합 | Tool-as-tool 방식으론 B 불가 | **리포지셔닝 필요** (아래 4절) |

**이전의 "Phase 3가 과도하다"는 평가는 A 패턴만 본 좁은 시각이었음**. B 패턴을 원한다면 Phase 3 인프라는 오히려 핵심 자산.

### 구현과 의도의 misalignment (오늘 `ignoredToolCount` 문제의 본질)

- **CLAUDE.md의 오케스트레이션 섹션**은 B 패턴 의도로 쓰여진 것으로 보임 (평가·합의·재조정 뉘앙스)
- **실제 구현**은 A 패턴(AgentTool을 Codex Agent의 AiTool로 연결)으로 흘러감
- **Codex SDK는 AgentTool을 tool로 인식 못 하므로** `ignoredToolCount: 2`로 무시됨
- 즉 오늘의 증상은 단순 누락이 아니라 **설계와 구현의 어긋남**

---

## 4. CodexAgentTool의 리포지셔닝

현재 노드는 LangChain `DynamicStructuredTool`을 반환하지만, 이 방식은 **A, B 어느 패턴에도 맞지 않습니다** (A는 Codex 네이티브가, B는 n8n 워크플로가 더 적합).

### 대안 역할 (택일 또는 복수 병존)

**역할 1 — Codex Native Subagent Definition 모드** (A 패턴용)
- UI는 유지 (name, description, model, instructions, MCP 등)
- 실행 시점에 `<workingDirectory>/.codex/agents/<name>.toml` 생성
- Codex가 네이티브로 자동 발견·spawn
- 워크플로 종료 시 정리 또는 유지 옵션

**역할 2 — Peer Agent Registration 모드** (B 패턴용)
- AgentMessage store에 peer agent로 등록
- 별도 `CodexAgentDebate`/`CodexAgentGate` 노드와 연계
- n8n 워크플로에서 topology 명시

**역할 3 — 레거시 (임시 하위호환)**
- 기존 워크플로 깨지지 않도록 한시적 유지
- Deprecation 로드맵 명시 → 2~3 릴리스 후 제거

---

## 5. Phase 4 목표 — B 패턴 지원 인프라 강화

### 신규 노드 후보

**`CodexAgentDebate`** — B 패턴 전용 빌트인 오케스트레이터
- 2~N개 agent profile 선택
- 합의 조건 설정: 라운드 수, 의견 일치도, 예산 상한
- 내부적으로 Phase 3 messages store 사용
- 수렴/발산 추적 및 중단 로직 내장

**`CodexAgentGate`** — 게이트 전용 노드
- 두 agent의 출력을 받아 합의·통과 여부 판단
- pass → 다음 단계 / rework → 재작업 루프로 분기
- Custom 규칙(예: "critic이 'block' 키워드 쓰면 차단") 지원

### 기존 자산 강화

- `codex_agent_messages`: TTL, 우선순위, 라우팅 키 추가 검토
- `codex_agent_registry`: credential 참조로 agent별 Codex 계정 격리 지원
- AgentMessage store: peer 간 shared state 조작 API 확장

### 관측성 (Phase 4a — 독립 진행 가능)

- `sendChunk` 스트리밍: `runStreamed` 이벤트를 n8n UI로 즉시 push
- `logAiEvent`: n8n 표준 AI 관측성 이벤트 병행 호출
- Debate/Gate 전용 로그 엔트리 추가

---

## 6. 하이브리드 아키텍처 — 최종 방향성

```
┌─────────────────────────────────────────────────────────┐
│                       n8n 워크플로 레이어                    │
│                                                         │
│  [Trigger] → [Orchestrator(CodexAgent)] → ...            │
│                 ↕ (Phase 3 messages)                     │
│              [CodexAgentDebate]                          │
│              [CodexAgentGate]                            │
│              [CodexAgent (peer)]                         │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼ (각 CodexAgent 안에서)
┌─────────────────────────────────────────────────────────┐
│                   Codex 런타임 레이어                      │
│  Codex CLI (agent) + 네이티브 subagents (.codex/agents/) │
│  + MCP 서버 + Skills + Hooks                             │
└─────────────────────────────────────────────────────────┘
```

**원칙**:
- **패턴 A**(단일 에이전트 내의 도구적 위임) → Codex 네이티브에게 위임
- **패턴 B**(peer/adversarial 오케스트레이션) → n8n 워크플로 레이어에서 처리
- **패턴 C**(단순 순차) → n8n 워크플로 엣지로 충분
- n8n과 Codex를 **경쟁 구조가 아닌 보완 구조**로 배치

---

## 7. 미결 결정 (Open Questions)

마이그레이션 시작 전 결정해야 할 것들:

1. **CodexAgentTool의 운명**: 완전 리팩터링 vs 두 역할로 분리 vs 레거시 유지
2. **.codex/agents/*.toml의 동적 생성 전략**: 워크플로 실행마다? 영구? 캐싱?
3. **B 패턴 예산 관리**: 무한 루프 방지 (라운드 상한, 토큰 상한, 시간 상한)
4. **Credential 격리**: peer agent마다 다른 Codex 계정 허용 여부
5. **새 노드 이름**: `CodexAgentDebate`가 맞는지, 더 일반적인 `CodexAgentOrchestrator`가 나은지
6. **마이그레이션 기간**: 기존 워크플로 깨지지 않을 전환 기간 (1개월? 2개월?)
7. **Phase 4a(스트리밍·관측성)를 먼저 할지, B 패턴 구현을 먼저 할지** 우선순위

---

## 8. 관련 문서

- **`docs/CODEX_PLATFORM_FACTS.md`** — 이 전략의 기술적 근거 (Codex SDK/CLI 기능 팩트 스냅샷)
- **`docs/ARCHITECTURE.md`** — 전체 시스템 아키텍처 (Phase 3 서술 부분은 이 문서와 일부 상충 — 업데이트 필요)
- **`docs/CROSS_HOST_NOTES.md`** — 호스트 간 공유 이슈

---

## 9. 변경 이력

| 날짜 | 변경 | 근거 |
|------|------|------|
| 2026-04-23 | 초기 작성 | 본 세션의 Codex 공식 문서 검토 및 사용자와의 설계 대화 |
