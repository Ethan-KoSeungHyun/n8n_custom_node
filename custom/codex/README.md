# Codex 커스텀 노드

이 폴더는 n8n용 Codex 커스텀 노드의 Git 공유 소스 코드가 들어 있는 위치입니다.

## 이 폴더에 포함되는 것

- `*.node.js`
- `*.credentials.js`
- `lib/**`
- `runtime/**`
- `store/**`
- `observability/**`
- `scripts/**`
- 의도적으로 로컬 패키지 매니페스트는 두지 않음

## 각 호스트에서 설치하는 방법

의존성은 공유 저장소 루트에서 설치합니다.

```bash
cd ../../
npm install
```

호스트 n8n 런타임은 `N8N_CUSTOM_EXTENSIONS`가 이 저장소의 `custom` 디렉터리를 가리키도록 설정해야 합니다.

## 관련 문서

- 저장소 개요: `../../README.md`
- 공용 노드 가이드: `../../docs/CODEX_N8N_NODE.md`
- Windows 호스트 설정: `../../docs/HOST_SETUP_WINDOWS.md`
- Linux 호스트 설정: `../../docs/HOST_SETUP_LINUX.md`
- 아키텍처: `../../docs/ARCHITECTURE.md`

## 왜 여기에는 local node_modules가 없는가

`custom/codex` 안에서 `npm install`을 실행하지 마세요.

`custom/codex/node_modules`가 생기면, n8n이 커스텀 노드를 로드하는 동안 의존성 파일까지 잘못 스캔해서 시작 단계에서 실패할 수 있습니다. 의존성 트리를 저장소 루트에만 두면 이 충돌을 피할 수 있습니다.

## 현재 제공되는 노드

- `Codex Agent`
- `Codex Agent Tool`
- `Codex Memory`
- `Codex MCP Toolset`

## 이 폴더 바깥에서 관리해야 하는 것

각 호스트는 아래 항목을 자체적으로 관리합니다.

- n8n 런타임
- `.env`와 `.npmrc`
- DB, 로그, `data/`, `tmp/`, 워크플로우 내보내기 파일
- `CODEX_HOME`과 저장된 인증 정보
- 프로세스 매니저 설정과 인증서
