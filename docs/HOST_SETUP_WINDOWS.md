# Windows 호스트 설정

이 문서는 `D:\Project\N8N_SERVER` 같은 Windows n8n 런타임을 `D:\Project\N8N_SERVER\n8n_server_github` 아래의 공용 커스텀 노드 저장소에 연결하는 방법을 설명합니다.

## 1. 공용 커스텀 노드 의존성 설치

```powershell
cd D:\Project\N8N_SERVER\n8n_server_github
npm install
```

## 2. 로컬 n8n 런타임이 shared repo를 보도록 설정

Windows 호스트의 로컬 `.env`에 아래 값을 설정합니다.

```text
N8N_CUSTOM_EXTENSIONS=D:/Project/N8N_SERVER/n8n_server_github/custom
```

나머지 런타임 전용 설정은 shared repo가 아니라 로컬 런타임 폴더에서 관리해야 합니다.

## 3. 호스트 로컬 상태는 로컬에만 보관

아래 항목은 Windows 호스트에서 커밋하지 마세요.

- `.env`
- `.npmrc`
- `data/`
- `tmp/`
- `workflow/`
- 로컬 인증서
- 호스트 `CODEX_HOME`

## 4. Codex 인증

`Saved Codex Auth`를 쓸 경우, 반드시 Windows 호스트에서 직접 로그인해야 합니다.

```powershell
$env:CODEX_HOME='D:\Project\N8N_SERVER\data\codex-home'
codex login
```

`codex`가 `PATH`에 없으면 n8n credential의 `Codex Executable Path`를 설정하거나, 호스트 로컬 `CODEX_BINARY_PATH`를 지정하세요.

## 5. 검증

Windows n8n 런타임 폴더에서 아래 명령을 실행합니다.

```powershell
cd D:\Project\N8N_SERVER
npm run check:codex-node
npm run export:codex-nodes
```

내보내기 결과에는 아래 노드가 포함되어야 합니다.

- `CUSTOM.codexAgent`
- `CUSTOM.codexAgentTool`
- `CUSTOM.codexMemory`
- `CUSTOM.codexMcpToolset`

## 6. 권장 런타임 분리 방식

- `D:\Project\N8N_SERVER`: n8n 런타임, DB, 로그, 로컬 스크립트, 로컬 상태
- `D:\Project\N8N_SERVER\n8n_server_github`: 공용 커스텀 노드 소스, 공용 의존성, 공용 문서

커스텀 노드 수정은 항상 shared repo에서만 진행하세요.
