# n8n Codex 커스텀 노드

이 저장소는 여러 n8n 호스트가 함께 사용하는 Codex 커스텀 노드의 공용 기준 저장소입니다.

## 이 저장소에 포함되는 것

- `custom/codex/**`
- 공용 커스텀 노드 의존성 정의 파일인 `package.json`
- `docs/**` 아래의 공용 문서
- `docs/workflows/**` 아래의 공용 워크플로우 템플릿

## 이 저장소에 포함되지 않는 것

각 호스트는 아래 항목을 Git 밖에서 자체적으로 관리합니다.

- n8n 런타임 파일과 로컬 `node_modules`
- 호스트별 `.env`, `.npmrc`, 프로세스 매니저 설정, 인증서
- n8n 데이터베이스, 로그, `data/`, `tmp/`, 워크플로우 내보내기 파일
- 호스트 로컬 `CODEX_HOME`과 저장된 Codex 인증 정보

## 호스트 공통 규칙

모든 호스트는 n8n이 이 저장소의 `custom` 디렉터리를 보도록 설정합니다.

```text
N8N_CUSTOM_EXTENSIONS=/absolute/path/to/this/repo/custom
```

그 다음 각 호스트에서 한 번만 공용 커스텀 노드 의존성을 설치합니다.

```bash
cd /absolute/path/to/n8n_server_github
npm install
```

## 문서

- 공용 노드 가이드: `docs/CODEX_N8N_NODE.md`
- Windows 호스트 설정: `docs/HOST_SETUP_WINDOWS.md`
- Linux 호스트 설정: `docs/HOST_SETUP_LINUX.md`
- 로컬 `N8N_SERVER/custom`에서 전환하는 방법: `docs/MIGRATION_FROM_N8N_SERVER.md`
- 호스트용 `.env` 예제: `docs/examples/.env.host.example`

## 저장소 구조

```text
custom/codex/    공용 노드 소스, runtime, store, observability 모듈
docs/            공용 운영 문서
package.json     공용 커스텀 노드 의존성 정의 파일
```

호스트별 실행 스크립트는 이 저장소가 아니라 각 서버 또는 각 런타임 저장소에서 관리하세요.
