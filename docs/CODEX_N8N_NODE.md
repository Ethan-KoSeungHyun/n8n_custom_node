# Codex n8n 커스텀 노드

이 저장소는 `custom/codex` 아래에 Codex 중심의 n8n 커스텀 노드 묶음을 제공합니다.

## 포함된 노드

- `Codex Agent`
  - 루트 AI Agent 스타일 노드
  - SDK 기반 실행, 세션 바인딩, transcript warm start, Codex MCP toolset 지원
- `Codex Memory`
  - `AiMemory` 서브노드
  - `sessionId -> threadId` 바인딩과 transcript mirror 설정 저장
- `Codex MCP Toolset`
  - `AiTool` 서브노드
  - 저장된 MCP 서버 또는 인라인 MCP 서버 구성을 `Codex Agent`, `Codex Agent Tool`에 전달
- `Codex Agent Tool`
  - 일반 n8n `AI Agent`용 `AiTool` 노드
  - 상위 에이전트가 Codex를 하위 에이전트처럼 호출할 수 있게 함

## 저장소 운영 원칙

- 이 저장소는 공용 커스텀 노드 소스, 공용 의존성, 공용 문서만 관리합니다.
- 각 호스트는 자기 n8n 런타임, `.env`, DB, 로그, 프로세스 매니저를 따로 관리합니다.
- `Saved Codex Auth`는 호스트별로 따로 저장됩니다. Windows와 Linux에서 각각 `codex login`을 실행해야 합니다.
- `CODEX_HOME`은 호스트 로컬 상태이므로 커밋하면 안 됩니다.

## 런타임 구조

구현은 네 개 계층으로 나뉩니다.

- `runtime`
  - `sdk-runtime.js`
  - `codex-service.js`
- `store`
  - `codex-store.js`
  - 활성 n8n 데이터베이스에 `codex_*` 테이블을 자동 생성
- `observability`
  - `codex-observability.js`
  - 이벤트를 정규화하고 아티팩트를 추출
- 노드 래퍼
  - `CodexAgent.node.js`
  - `CodexAgentTool.node.js`
  - `CodexMemory.node.js`
  - `CodexMcpToolset.node.js`

## 실행 방식

현재 스택은 SDK-only로 동작합니다.

- `Codex Agent`
- `Codex Agent Tool`

모두 `@openai/codex-sdk@0.117.0`을 사용합니다.

중요한 점:

- 이 SDK는 내부적으로 Codex 바이너리를 사용합니다.
- 하지만 이 저장소에는 더 이상 직접 `spawn`하는 CLI runtime이나 별도 `Codex CLI` 관리 노드가 없습니다.
- 인증 상태는 `CODEX_HOME` 또는 API Key를 통해 SDK 실행에 전달됩니다.

## 세션 모델

`Auto Resume`는 아래 값을 조합한 안정적인 바인딩 키를 저장합니다.

- `workflowId`
- `nodeId`
- `sessionId`
- `codexHome`
- `workingDirectory`

첫 실행 시:

- 새 Codex thread를 생성하고
- 그 바인딩을 `codex_session_bindings`에 저장합니다

같은 키로 이후 다시 실행하면:

- 저장된 `threadId`를 자동으로 이어서 사용합니다

저장된 thread가 유효하지 않으면:

- 새 thread를 생성하고
- 바인딩을 갱신하며
- 복구 기록을 실행 로그에 남깁니다

## 데이터베이스 테이블

활성 n8n 데이터베이스에는 첫 사용 시 아래 테이블이 생성됩니다.

- `codex_session_bindings`
- `codex_runs`
- `codex_run_events`
- `codex_run_artifacts`

이 테이블들은 세션 바인딩, 실행 메타데이터, 원본 이벤트 payload, 추출된 아티팩트를 저장합니다.

## 관측성

이벤트는 항상 내부 저장 대상입니다. `Include Events In Output`은 그 이벤트를 노드 출력에도 포함할지 여부만 제어합니다.

아티팩트에는 아래 내용이 포함될 수 있습니다.

- shell command 실행 기록
- 파일 변경 내용
- MCP tool 호출
- 웹 검색 사용 내역
- 작업 디렉터리가 Git 저장소일 때 best-effort 방식의 Git status / diff 스냅샷

## 대시보드 템플릿

아래 워크플로우 템플릿을 import 하면 시작용 쿼리 팩을 바로 쓸 수 있습니다.

- `docs/workflows/codex-observability-query-pack.workflow.json`

여기에는 다음 항목을 위한 시작용 브랜치가 들어 있습니다.

- 세션별 사용량
- 모델별 토큰
- 실패한 실행
- 최근 변경 파일
- 최근 shell command

## 권장 기본값

직접 채팅형 워크플로우:

- `When chat message received`
- `Codex Agent`
- 필요하면 `Codex Memory`
- 필요하면 `Codex MCP Toolset`

권장 필드 기본값:

- `Session Strategy`: `Auto Resume`
- `Session ID`: `={{ $json.sessionId }}`
- `State Scope`: `Workspace Scoped`
- `Include Events In Output`: `false`
- `Use Workspace Skills`: `true`

하위 에이전트형 워크플로우:

- `AI Agent`
- `Codex Agent Tool`
- 필요하면 `Codex MCP Toolset`

권장 필드 기본값:

- `Session Strategy`: `Always New`
- `Ephemeral`: `true`

## 검증

공용 커스텀 노드 의존성은 shared repo 루트에서 설치합니다.

```powershell
cd /absolute/path/to/n8n_server_github
npm install
```

그 다음 `N8N_CUSTOM_EXTENSIONS`가 이 저장소의 `custom` 디렉터리를 가리키도록 설정한 뒤, 호스트 런타임 폴더에서 아래 명령으로 검증합니다.

```powershell
npm run check:codex-node
npm run export:codex-nodes
```

## 현재 제한 사항

- `Codex Agent`는 우선적으로 `Codex MCP Toolset` 입력을 이해하며, 임의의 LangChain tool 전체를 아직 완전히 지원하지는 않습니다.
- 별도 `Auth`, `MCP`, `Review` 관리 노드는 더 이상 제공하지 않습니다. 인증은 `codex login` 또는 API Key로 관리하고, MCP는 `Codex MCP Toolset` 또는 `CODEX_HOME` 구성을 사용합니다.
- 대시보드 템플릿은 쿼리 팩 형태이며, 완성된 차트 UI는 아닙니다.
