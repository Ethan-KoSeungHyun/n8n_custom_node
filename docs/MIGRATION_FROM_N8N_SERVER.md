# `N8N_SERVER/custom`에서 마이그레이션

이 문서는 Windows 런타임이 로컬 `D:\Project\N8N_SERVER\custom` 폴더를 쓰던 구조에서, `D:\Project\N8N_SERVER\n8n_server_github\custom` 아래의 nested shared repository를 쓰는 구조로 옮기는 방법을 설명합니다.

## 목표

마이그레이션이 끝나면 아래 상태가 됩니다.

- 커스텀 노드 소스는 `D:\Project\N8N_SERVER\n8n_server_github`에서만 수정
- `D:\Project\N8N_SERVER`는 로컬 런타임 폴더로 유지
- `N8N_CUSTOM_EXTENSIONS`는 shared repo를 가리킴

## 절차

1. 로컬 custom 폴더를 백업합니다.

```powershell
Rename-Item D:\Project\N8N_SERVER\custom custom.bak
```

2. 로컬 런타임 `.env`를 수정합니다.

```text
N8N_CUSTOM_EXTENSIONS=D:/Project/N8N_SERVER/n8n_server_github/custom
```

3. 로컬 런타임 파일은 계속 로컬에만 둡니다.

- `.env`
- `.npmrc`
- `package.json`
- `package-lock.json`
- `node_modules/`
- `data/`
- `tmp/`
- `workflow/`

4. shared custom 의존성을 설치하거나 업데이트합니다.

```powershell
cd D:\Project\N8N_SERVER\n8n_server_github
npm install
```

5. 로컬 런타임 폴더에서 검증합니다.

```powershell
cd D:\Project\N8N_SERVER
npm run check:codex-node
npm run export:codex-nodes
```

## 참고

- Codex 계정 인증은 n8n Credentials의 **Codex ChatGPT Account**로 관리합니다. 각 호스트에서 Connect를 눌러 다시 로그인해야 합니다.
- 인증 상태는 `data/codex-profiles/{profileKey}/codex-home`에 호스트 로컬 상태로 유지됩니다.
- 문제가 생기면 `custom.bak`에서 로컬 폴더를 복원하고, `N8N_CUSTOM_EXTENSIONS`를 임시로 예전 로컬 경로로 되돌릴 수 있습니다.
