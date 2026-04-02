# Linux 호스트 설정

이 문서는 Linux n8n 런타임을 공용 커스텀 노드 저장소 클론과 연결하는 방법을 설명합니다.

## 1. 공용 저장소 클론

예시:

```bash
git clone <your-remote-url> /srv/N8N_SERVER/n8n_server_github
```

## 2. 공용 커스텀 노드 의존성 설치

```bash
cd /srv/N8N_SERVER/n8n_server_github
npm install
```

## 3. Linux n8n 런타임이 shared repo를 보도록 설정

Linux 호스트의 로컬 `.env` 또는 서비스 환경 변수에 아래 값을 설정합니다.

```text
N8N_CUSTOM_EXTENSIONS=/srv/N8N_SERVER/n8n_server_github/custom
```

n8n 런타임, DB, 로그, 서비스 매니저 파일은 shared repo 밖에서 관리하세요.

## 4. 호스트 로컬 Codex 상태

권장되는 호스트 로컬 값 예시:

```text
CODEX_HOME=/var/lib/n8n/codex-home
```

`Saved Codex Auth`는 호스트별이므로, Windows와 별개로 Linux 호스트에서도 `codex login`을 실행해야 합니다.

`codex`가 `PATH`에 없으면 credential의 `Codex Executable Path`를 설정하거나, 호스트 로컬 `CODEX_BINARY_PATH`를 지정하세요.

## 5. 권한

Linux 서비스 사용자는 아래 경로를 읽을 수 있어야 합니다.

- shared repo clone 경로
- 설정된 `CODEX_HOME`
- 사용하는 CA bundle 경로 또는 skills 경로

그리고 아래 경로에는 쓸 수 있어야 합니다.

- 호스트 로컬 `CODEX_HOME`
- n8n 런타임 DB, 로그, 상태 디렉터리

## 6. 검증

Linux n8n 런타임 폴더에서 먼저 아래 명령으로 노드 로딩을 확인합니다.

```bash
npm run check:codex-node
npm run export:codex-nodes
```

그 다음 아래 항목을 스모크 테스트합니다.

- `Codex Agent`
- `Auto Resume` over two turns
- 저장된 서버 또는 로컬 stdio smoke server를 사용하는 `Codex MCP Toolset`

## 7. 운영 모델

- shared repo: `custom/codex/**` 소스와 문서의 기준 저장소
- Linux 호스트: 로컬 런타임, `.env`, 프로세스 매니저, DB, 로그, 인증서, `CODEX_HOME`

호스트 전용 런타임 파일은 이 shared repo에 넣지 마세요.
