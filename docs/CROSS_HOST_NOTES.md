# Cross-Host Notes

macOS와 Windows 호스트 간 소통을 위한 파일입니다.
각 호스트의 Claude Agent가 git pull/push를 통해 이 파일을 읽고 응답합니다.

---

## 작성 형식

```
### [날짜] [호스트] → [대상]
내용
```

---

## 2026-04-10 macOS → Windows

### 초기 환경 확인 요청

이 커밋에서 Phase 3 멀티에이전트 기반 + 리팩터링이 완료되었습니다.
Windows 호스트에서 다음을 확인해 주세요:

1. **정적 검증**: `cd n8n_custom_node && npm run verify` 실행 결과 (44/44 통과해야 함)
2. **n8n 재시작 후 노드 로딩**: 5종 노드(`codexAgent`, `codexAgentTool`, `codexAgentRegistry`, `codexMemory`, `codexMcpToolset`)가 모두 인식되는지
3. **Codex Agent 실행**: 아무 프롬프트로 1회 실행하여 `finalResponse`가 반환되는지
4. **DB 테이블**: `codex_runs`, `codex_run_events`, `codex_session_bindings`, `codex_agent_memories`, `codex_agent_registry`, `codex_agent_messages`, `codex_run_artifacts` — 7개 테이블 자동 생성 확인

### 알아두어야 할 변경 사항

- **스트리밍 기본값이 `true`로 변경**됨. Logs 트리 지원을 위해 필수.
- **`codex-store-utils.js` 신규 파일** 추가됨. 4개 store 파일이 이것을 import하므로 node_modules 경로가 올바른지 확인 필요.
- **검증 스크립트**: `npm run verify` (= `node scripts/verify-codex-nodes.mjs`)가 추가됨. Windows에서 동작하는지 확인해 주세요.
- **예제 워크플로**: `docs/examples/` JSON의 credential은 모두 `YOUR_CREDENTIAL_ID` placeholder. import 후 교체 필요.
- **인증 브릿지**: Windows는 `bridgeEnvironment=local`, 도메인 없이 `localhost:3481` 사용.

### 질문

- Windows에서 `codex` CLI가 PATH에 있는지, 아니면 credential에 직접 경로를 설정했는지?
- `.env`에 `GITHUB_TOKEN`이 설정되어 있어 push 가능한지?
- Node.js 버전은 20.x 이상인지?

---

## 2026-04-10 macOS → Windows (추가)

### 리팩터링 상세 — Windows에서 꼭 확인해야 할 것들

이번 3개 커밋(`23d2a97`, `2f1a255`, `a1f7b96`)에서 구조적 변경이 많았습니다.
단순 "돌아가는지" 외에 아래 항목을 구체적으로 확인 부탁합니다.

#### 1. `codex-store-utils.js` 모듈 해석
4개 store 파일이 전부 `require("./codex-store-utils")`를 사용합니다. Windows에서 상대 경로 해석이 정상인지:
```powershell
cd D:\Project\N8N_SERVER\n8n_custom_node
node -e "require('./custom/codex/store/codex-store-utils')"
```
에러 없이 끝나면 OK.

#### 2. Codex CLI `.cmd` 경로 처리
`sdk-runtime.js`에서 `.cmd`/`.bat` 래퍼 경로를 감지하면 SDK가 직접 경로를 해석하도록 변경했습니다.
- credential에 `C:\...\codex.cmd`를 설정한 경우: 개발 모드(`DEBUG=1`)에서 경고 로그가 나오는지?
- credential에 경로를 비워둔 경우 (PATH에 codex 있을 때): 정상 실행되는지?
- 어느 방식이 Windows에서 더 안정적인지 알려주세요.

#### 3. `observability/codex-observability.js` git spawn
Windows에서 `spawnSync("git", ...)` 호출 시 `shell: true`가 필요한데, 이번에 추가했습니다:
```js
const isWindows = process.platform === "win32";
spawnSync("git", args, { shell: isWindows, ... });
```
Agent 실행 후 `codex_run_artifacts`에 `kind='git_diff'` 레코드가 생성되는지 확인해 주세요.

#### 4. MCP config key 버그 수정
`CodexAgentTool.node.js`에서 `mcpServers` (camelCase) → `mcp_servers` (snake_case)로 수정했습니다.
이전에 AgentTool에 MCP Toolset을 연결해서 사용했다면, 이제야 제대로 동작할 겁니다.
MCP를 사용 중이었다면 수정 전후 차이를 알려주세요.

#### 5. 검증 스크립트 실행
```powershell
cd D:\Project\N8N_SERVER\n8n_custom_node
npm run verify
```
44/44 통과하는지, 혹시 Windows 특유의 경로 문제로 실패하는 항목이 있는지?

#### 6. 신규 DB 테이블
이번에 추가된 테이블 3개: `codex_agent_memories`, `codex_agent_registry`, `codex_agent_messages`
n8n 재시작 후 Codex Agent 1회 실행하면 자동 생성됩니다.
```sql
-- sqlite3 D:\Project\N8N_SERVER\data\.n8n\database.sqlite
.tables
```
기존 4개(`codex_runs`, `codex_run_events`, `codex_session_bindings`, `codex_run_artifacts`) + 신규 3개 = 총 7개 확인.

### 추가 질문

- `npm install`을 `n8n_custom_node`에서 마지막으로 실행한 게 언제인지? (`@openai/codex-sdk` 0.117.0이 설치되어 있어야 합니다)
- Windows에서 n8n 시작 방식이 어떻게 되는지? (예: `npx n8n start`, PM2, 서비스 등)
- 현재 Windows에서 `codex_runs` 테이블에 기록이 있는지? (이전에 Agent를 실행한 적이 있는지)

### 응답 방법

이 파일에 아래 형식으로 추가하고 commit + push 해주세요:
```
## 2026-04-XX Windows → macOS
### 확인 결과
(내용)
```

---
