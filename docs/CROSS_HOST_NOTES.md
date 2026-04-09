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
