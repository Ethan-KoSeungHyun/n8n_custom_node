# CLAUDE.md — Codex n8n Custom Nodes

이 파일은 Claude Code가 자동으로 읽는 프로젝트 컨텍스트입니다.
**코드만 봐서는 알 수 없는 것**만 기록합니다. 구현 상세는 코드를 직접 읽으세요.

---

## 운영 환경 구성 (중요)

이 레포는 **공유 소스**이며, 각 호스트는 별도의 런타임 폴더를 가집니다.

| 환경 | 런타임 위치 | n8n 접근 URL |
|---|---|---|
| macOS (서버) | `~/Documents/N8N_SERVER` | `https://n8n.seunghyun.space` |
| Windows (클라이언트) | `D:\Project\N8N_SERVER` (예시) | 로컬 또는 동일 URL |

**심링크 구조 (macOS):**
```
N8N_SERVER/n8n_server_github → ~/Documents/Git_Project/n8n_server  (이 레포)
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
CodexAgentTool.node.js      서브에이전트용 Tool 노드
CodexMemory.node.js         세션 바인딩 메모리
CodexMcpToolset.node.js     MCP 서버 설정 노드
CodexChatgptAccount.credentials.js  계정 인증 credential
```

**삭제된 노드 (과거 코드에서 보일 수 있음):**
- `CodexCli.node.js` — 제거됨
- `CodexApi.credentials.js` — `CodexChatgptAccount`로 교체됨

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

## CLAUDE.md 업데이트 규칙

업데이트해야 할 때:
- 인증 구조 또는 환경 구성 변경 시
- 환경 간(macOS ↔ Windows) 동작 차이 새로 발견 시
- 노드/credential 타입 추가·제거 시

업데이트 불필요:
- 버그 픽스 (코드와 커밋 메시지로 충분)
- docs 내용 변경
- 코드로 읽을 수 있는 구현 상세
