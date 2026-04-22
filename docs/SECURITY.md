# Security Hardening Guide

이 문서는 n8n 서버 및 Codex 커스텀 노드의 보안 강화 내역을 기록합니다.
macOS(Cloudflare Tunnel 도메인 운영)와 Windows(localhost 전용) 환경 모두를 다룹니다.

> **최종 감사일**: 2026-04-14
> **대상 버전**: n8n 2.13.4, Codex Custom Nodes 0.1.0

---

## 목차

1. [공격 표면 요약](#1-공격-표면-요약)
2. [Cloudflare 설정 (macOS 전용)](#2-cloudflare-설정-macos-전용)
3. [서버 환경변수 (.env)](#3-서버-환경변수-env)
4. [파일 권한](#4-파일-권한)
5. [코드 보안 (공유 레포)](#5-코드-보안-공유-레포)
6. [Windows 환경 가이드](#6-windows-환경-가이드)
7. [검증 체크리스트](#7-검증-체크리스트)
8. [양호 항목 (변경 불필요)](#8-양호-항목-변경-불필요)

---

## 1. 공격 표면 요약

### macOS (도메인 운영)

```
인터넷
  ├── n8n.seunghyun.space (Cloudflare Tunnel) → localhost:5678
  │     ├── n8n Editor UI — 사용자 인증
  │     ├── REST API (/api/v1/*) — API 키 인증
  │     ├── Webhooks (/webhook/*) — 워크플로별 랜덤 토큰
  │     └── Function 노드 — 제한된 코드 실행
  │
  └── codex-bridge.seunghyun.space (Cloudflare Tunnel) → localhost:3481
        ├── /oauth/authorize — OAuth 흐름
        ├── /oauth/token — 토큰 교환
        ├── /oauth/device/start — Device Code 인증
        ├── /oauth/disconnect — 연결 해제
        └── /oauth/purge — 프로필 삭제
```

### Windows (localhost 전용)

```
localhost:5678 — n8n Editor UI + REST API + Webhooks
localhost:3481 — Codex Auth Bridge
외부 노출 없음 (도메인, 터널 미사용)
```

---

## 2. Cloudflare 설정 (macOS 전용)

> Windows는 도메인을 사용하지 않으므로 이 섹션은 macOS에만 해당합니다.

### 2.1 SSL/TLS

| 항목 | 변경 전 | 변경 후 |
|------|---------|---------|
| SSL 모드 | Full | **Full (Strict)** |
| Always Use HTTPS | OFF | **ON** |
| HSTS | 미활성 | **활성** (max-age=6개월, includeSubDomains) |
| Minimum TLS Version | TLS 1.0 | **TLS 1.2** |
| TLS 1.3 | ON | ON (유지) |

### 2.2 Security / WAF Custom Rule

Codex Auth Bridge에 대한 지역 기반 접근 제한:

```
규칙명: Block non-KR access to codex-bridge
조건:  http.host eq "codex-bridge.seunghyun.space" AND ip.geoip.country ne "KR"
액션:  Block
```

### 2.3 Rate Limiting

Webhook 경로에 대한 속도 제한:

```
규칙명: Rate limit webhooks
URL:        *seunghyun.space/webhook/*
임계치:     30 requests / 10 seconds / IP
차단 기간:  60초
```

### 2.4 DNS 정리

| 레코드 | 변경 내용 |
|--------|-----------|
| A `seunghyun.space` → 162.255.119.36 | **삭제** (Namecheap 파킹 IP 잔존) |
| CNAME `www` → parkingpage.namecheap.com | **삭제** (불필요한 노출) |

### 2.5 Zero Trust Access

> **주의**: Zero Trust Access Policy는 아직 미설정 상태입니다.
> 추후 설정 시 n8n.seunghyun.space와 codex-bridge.seunghyun.space에
> 이메일 인증 또는 IP 제한 정책 추가를 권장합니다.

---

## 3. 서버 환경변수 (.env)

`.env` 파일은 호스트별 독립이며, git에 포함되지 않습니다.
아래 설정은 macOS/Windows 양쪽 모두 동일하게 적용해야 합니다.

### 3.1 노드 코드 실행 제한

| 변수 | 변경 전 | 변경 후 | 설명 |
|------|---------|---------|------|
| `NODE_FUNCTION_ALLOW_BUILTIN` | `*` | `crypto,path,url,querystring,util,assert` | Function 노드에서 사용할 수 있는 Node.js 내장 모듈 제한 |
| `NODE_FUNCTION_ALLOW_EXTERNAL` | `*` | `lodash,moment,luxon,date-fns` | Function 노드에서 사용할 수 있는 외부 패키지 제한 |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | `false` | **`true`** | Function 노드에서 process.env 접근 차단 |
| `N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES` | `false` | **`true`** | Function 노드에서 n8n 설정/DB 파일 접근 차단 |
| `N8N_RUNNERS_ALLOW_PROTOTYPE_MUTATION` | `true` | **`false`** | prototype pollution 방지 |
| `N8N_PYTHON_ENABLED` | `true` | **`false`** | Python 코드 실행 비활성화 |
| `N8N_UNVERIFIED_PACKAGES_ENABLED` | `true` | **`false`** | 미검증 커뮤니티 패키지 차단 |

### 3.2 위험 시나리오 (변경 전)

변경 전 설정에서는 Function 노드 하나로 다음이 가능했습니다:

- `process.env.GITHUB_TOKEN` — 모든 환경변수 탈취
- `require('fs').readFileSync('database.sqlite')` — n8n DB 직접 읽기
- `require('child_process').exec('whoami')` — 시스템 명령 실행
- `require('net')` — 내부 네트워크 스캔

### 3.3 Codex Agent 영향

Codex 노드는 Function 노드가 아닌 별도 SDK 런타임으로 동작하므로,
위 n8n 제한 설정은 Codex Agent 동작에 영향을 주지 않습니다.
단, 같은 워크플로 안에서 Function 노드를 병행 사용하면 해당 Function 노드에만 제한이 적용됩니다.

### 3.4 레거시 Basic Auth 제거

`data/.n8n/.env.n8n`에 잔존하던 레거시 Basic Auth 설정을 삭제했습니다:

```
# 삭제된 항목 (n8n 2.x에서 이미 지원 제거됨)
N8N_BASIC_AUTH_ACTIVE=true
N8N_BASIC_AUTH_USER=admin
N8N_BASIC_AUTH_PASSWORD=<평문 비밀번호>
```

> `.env.n8n`은 Docker 배포 참고용 파일이며, 로컬 런타임은 `.env`만 로드합니다.

---

## 4. 파일 권한

민감 파일의 권한을 `644`(누구나 읽기)에서 `600`(소유자만)으로 변경했습니다.

```bash
chmod 600 .env
chmod 600 data/.n8n/.env.n8n
chmod 600 data/.n8n/database.sqlite
chmod 600 data/.n8n/database.sqlite-wal
chmod 600 data/.n8n/database.sqlite-shm
chmod 600 ~/.cloudflared/config.yml          # macOS만 해당
```

### Windows 해당사항

Windows NTFS에서 `chmod`는 작동하지 않습니다. 대신:
- `.env` 파일: 파일 속성 → 보안 탭에서 현재 사용자만 읽기/쓰기 권한 부여
- `database.sqlite`: 동일하게 현재 사용자만 접근 가능하도록 설정
- Windows는 localhost 전용이므로 긴급도는 낮지만, 다중 사용자 환경에서는 적용 권장

---

## 5. 코드 보안 (공유 레포)

> 이 섹션의 모든 변경사항은 git으로 공유되므로 양쪽 환경에 자동 적용됩니다.

### 5.1 Auth Bridge 보안 헤더

**파일**: `lib/codex-auth-bridge.js`

모든 HTTP 응답(`writeJson`, `writeHtml`)에 보안 헤더를 추가했습니다:

```javascript
const SECURITY_HEADERS = {
    "x-frame-options": "DENY",                    // Clickjacking 방지
    "x-content-type-options": "nosniff",           // MIME sniffing 방지
    "content-security-policy": "default-src 'self'; ...",  // XSS 방지
    "referrer-policy": "strict-origin-when-cross-origin",
    "cache-control": "no-store",                   // 인증 데이터 캐시 방지
};
```

### 5.2 CSRF(Origin) 검증

**파일**: `lib/codex-auth-bridge.js`

모든 POST 요청에 Origin 헤더 기반 CSRF 보호를 추가했습니다:

```javascript
function isOriginAllowed(req) {
    const origin = String(req.headers.origin || req.headers.referer || "").trim();
    if (!origin) return true;  // n8n 내부 호출 (브라우저 아님) 허용
    const allowed = [
        "http://localhost",
        "https://n8n.seunghyun.space",
        "https://codex-bridge.seunghyun.space",
    ];
    return allowed.some((prefix) => origin.startsWith(prefix));
}
```

- `http://localhost` — macOS/Windows 모두 로컬 접근 허용
- `https://n8n.seunghyun.space` — macOS Tunnel 도메인 허용
- `https://codex-bridge.seunghyun.space` — macOS Bridge 도메인 허용
- Origin 헤더 없음 → 허용 (n8n 내부 HTTP 호출은 Origin을 보내지 않음)
- 알 수 없는 Origin → **403 Forbidden**

### 5.3 Client Secret 동적 생성

**파일**: `lib/codex-auth-bridge.js`

하드코딩된 `"codex-local-secret"`을 동적 생성으로 변경했습니다:

```javascript
const BRIDGE_CLIENT_SECRET =
    process.env.CODEX_AUTH_BRIDGE_SECRET || crypto.randomBytes(32).toString("hex");
```

- n8n 프로세스 시작마다 새 시크릿 생성
- 환경변수 `CODEX_AUTH_BRIDGE_SECRET`으로 고정값 지정 가능 (클러스터 환경용)

### 5.4 환경변수 필터링 (Codex SDK)

**파일**: `lib/node-runtime-helpers.js`

Codex SDK 자식 프로세스에 `process.env` 전체를 전달하던 것을 허용 목록 기반으로 변경했습니다.

**변경 전**:
```javascript
const env = { ...process.env, ...extraEnv, CODEX_HOME: codexHome };
// 위험: GITHUB_TOKEN, N8N_ENCRYPTION_KEY, N8N_API 등 모든 시크릿이 SDK에 전달됨
```

**변경 후**:
```javascript
const ALLOWED_ENV_PREFIXES = ["CODEX_", "NODE_"];
const ALLOWED_ENV_KEYS = new Set([
    // 공통 (macOS/Linux)
    "PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ",
    "TERM", "SHELL", "TMPDIR", "XDG_RUNTIME_DIR",
    "NODE_PATH", "NODE_ENV",
    // Windows 전용 (자식 프로세스 스폰 및 SDK 동작에 필수)
    "APPDATA", "LOCALAPPDATA", "USERPROFILE", "COMSPEC", "PATHEXT",
    "TEMP", "TMP", "WINDIR", "SystemRoot", "OS",
]);
```

차단되는 주요 변수: `GITHUB_TOKEN`, `N8N_ENCRYPTION_KEY`, `N8N_API`,
`N8N_BLOCK_*`, `CLOUDFLARED_*` 등

### 5.5 MCP Toolset 입력 검증

**파일**: `CodexMcpToolset.node.js`

#### stdio 명령어 검증
셸 메타문자 차단으로 명령 주입 방지:
```javascript
if (/[;&|`$(){}]/.test(stdioCommand)) {
    throw new NodeOperationError(...);
}
```

#### 환경변수 키 검증
위험한 환경변수 키 차단:
```javascript
const DANGEROUS_ENV_KEYS = /^(LD_PRELOAD|DYLD_INSERT_LIBRARIES|LD_LIBRARY_PATH|PATH|NODE_OPTIONS)$/i;
```

#### Bearer Token 환경변수명 검증
민감 패턴 차단으로 시크릿 탈취 방지:
```javascript
if (/^(N8N_|GITHUB_|.*SECRET|.*PASSWORD|.*TOKEN$)/i.test(bearerTokenEnvVar)) {
    throw new NodeOperationError(...);
}
```

### 5.6 Codex Executable 경로 검증

**파일**: `lib/codex-profile-utils.js`

credential에서 전달되는 실행 파일 경로에 셸 메타문자 차단:
```javascript
if (/[;&|`$(){}]/.test(resolved)) {
    throw new Error("Codex 실행 파일 경로에 허용되지 않는 문자가 포함되어 있습니다");
}
```

---

## 6. Windows 환경 가이드

### 6.1 자동 적용 (git pull로 해결)

다음 보안 변경은 공유 레포에 포함되어 있으므로 `git pull`만 하면 자동 적용됩니다:

- Auth Bridge 보안 헤더 (5.1)
- CSRF Origin 검증 (5.2)
- Client Secret 동적 생성 (5.3)
- 환경변수 필터링 (5.4) — Windows 필수 변수 포함
- MCP Toolset 입력 검증 (5.5)
- Executable 경로 검증 (5.6)

### 6.2 수동 적용 필요 (.env 설정)

Windows의 `.env` 파일(`D:\Project\N8N_SERVER\.env`)에 다음 설정을 적용하세요:

```env
# --- 보안 설정 (아래 값으로 변경) ---
NODE_FUNCTION_ALLOW_BUILTIN=crypto,path,url,querystring,util,assert
NODE_FUNCTION_ALLOW_EXTERNAL=lodash,moment,luxon,date-fns
N8N_BLOCK_ENV_ACCESS_IN_NODE=true
N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES=true
N8N_RUNNERS_ALLOW_PROTOTYPE_MUTATION=false
N8N_PYTHON_ENABLED=false
N8N_UNVERIFIED_PACKAGES_ENABLED=false
```

### 6.3 Windows 불필요 항목

| 항목 | 이유 |
|------|------|
| Cloudflare 설정 전체 (섹션 2) | 도메인/터널 미사용 |
| `~/.cloudflared/config.yml` 권한 | 파일 없음 |
| HSTS, TLS 설정 | 외부 노출 없음 |
| Rate Limiting, WAF Rule | 외부 트래픽 없음 |

### 6.4 Windows 위험도 평가

| 위협 | macOS (도메인) | Windows (localhost) | 비고 |
|------|---------------|-------------------|------|
| 외부 공격자의 직접 접근 | **높음** | 없음 | Windows는 네트워크 노출 없음 |
| Function 노드 RCE | **높음** | **높음** | 로컬이어도 워크플로 import 시 위험 |
| 환경변수 탈취 | **높음** | **중간** | 로컬이지만 Codex SDK 하위 프로세스에 노출 |
| CSRF (Auth Bridge) | **높음** | **낮음** | 로컬 브라우저에서만 접근 가능 |
| 파일 권한 | **높음** | **낮음** | 단일 사용자 환경이면 위험 낮음 |

> Windows에서도 `.env` 보안 설정(6.2)은 **반드시** 적용해야 합니다.
> Function 노드를 통한 코드 실행 위험은 네트워크 노출 여부와 무관합니다.
> 악의적인 워크플로 JSON을 import하는 것만으로 exploit가 가능하기 때문입니다.

### 6.5 Windows .env.n8n

Windows `data\.n8n\.env.n8n`에도 레거시 Basic Auth 설정이 남아 있다면 삭제하세요:

```
# 이 3줄이 있으면 삭제
N8N_BASIC_AUTH_ACTIVE=true
N8N_BASIC_AUTH_USER=admin
N8N_BASIC_AUTH_PASSWORD=...
```

---

## 7. 검증 체크리스트

### 정적 검증 (양쪽 동일)

```bash
cd n8n_custom_node
npm run verify    # 44/44 통과 확인
```

### macOS 검증

| # | 검증 항목 | 방법 | 기대 결과 |
|---|-----------|------|-----------|
| 1 | HTTPS 강제 | `curl -I http://n8n.seunghyun.space` | 301 redirect to HTTPS |
| 2 | HSTS 헤더 | `curl -I https://n8n.seunghyun.space` | `Strict-Transport-Security` 헤더 존재 |
| 3 | TLS 1.0/1.1 차단 | `curl --tlsv1.1 https://n8n.seunghyun.space` | 연결 실패 |
| 4 | Bridge 지역 제한 | 외국 VPN으로 `codex-bridge.seunghyun.space` 접근 | Cloudflare Block 페이지 |
| 5 | env 접근 차단 | Function 노드에서 `return process.env.GITHUB_TOKEN` | 차단/undefined |
| 6 | 파일 접근 차단 | Function 노드에서 `require('fs').readFileSync(...)` | 차단 |
| 7 | 파일 권한 | `ls -la .env data/.n8n/.env.n8n` | `-rw-------` (600) |
| 8 | CSRF 차단 | `curl -X POST localhost:3481/oauth/disconnect -H "Origin: https://evil.com"` | 403 |
| 9 | 환경변수 필터 | Codex Agent 실행 후 SDK에서 `GITHUB_TOKEN` 접근 | 불가 |
| 10 | Codex Agent 정상 | Codex Agent 워크플로 1회 실행 | 성공 |

### Windows 검증

| # | 검증 항목 | 방법 | 기대 결과 |
|---|-----------|------|-----------|
| 1 | `npm run verify` | `cd n8n_custom_node && npm run verify` | 44/44 통과 |
| 2 | env 접근 차단 | Function 노드에서 `return process.env` | 차단/빈 객체 |
| 3 | .env 설정 확인 | `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` 등 | 설정 적용됨 |
| 4 | Codex Agent 정상 | Codex Agent 워크플로 1회 실행 | 성공 |

---

## 8. 양호 항목 (변경 불필요)

| 항목 | 설정 | 평가 |
|------|------|------|
| n8n 리스닝 주소 | `127.0.0.1` (localhost only) | 직접 외부 노출 차단 |
| 텔레메트리 | `N8N_DIAGNOSTICS_ENABLED=false` | 외부 데이터 전송 없음 |
| 버전 알림 | `N8N_VERSION_NOTIFICATIONS_ENABLED=false` | 외부 체크 없음 |
| 실행 이력 정리 | `EXECUTIONS_DATA_PRUNE=true`, 14일 보관 | 적절 |
| 설정 파일 권한 강제 | `N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true` | n8n 자체 검증 |
| Tunnel 기본 응답 | `http_status:404` | 알 수 없는 호스트 차단 |
| Tunnel credential 권한 | `600` | 적절히 보호됨 |
| .gitignore | `.env`, `database.sqlite` 등 제외 | git에 시크릿 미포함 |
| Secure Cookie (모드별) | local=false, tunnel=true | `n8n-env.sh`가 자동 전환 |

---

## 변경 이력

| 날짜 | 내용 |
|------|------|
| 2026-04-14 | 초기 보안 감사 및 전체 조치 적용 |
