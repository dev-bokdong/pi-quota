# pi-quota 구현 계획

## 1. 목표

`opencode-quota`의 OpenAI·Anthropic 사용량 조회 로직을 Senpi 확장으로 이식한다.
사용자는 Linux에서 다음 명령으로 패키지를 설치하고, Senpi 대화형 모드에서
`/quota`를 실행할 수 있어야 한다.

```bash
senpi install git:github.com/bok-dong/pi-quota
```

```text
/quota
```

## 2. 확정 범위

### 포함

- Linux
- Senpi/Pi 확장 패키지
- `/quota` 로컬 명령
- Senpi가 관리하는 OpenAI Codex OAuth 인증
- Senpi가 관리하는 Anthropic OAuth 인증
- OpenAI 5시간·주간·월간·코드 리뷰 한도
- Anthropic 5시간·주간 한도
- 부분 성공, 네트워크 오류, 인증 오류 표시
- 토큰 및 응답 본문 내 민감 정보 제거

### 제외

- macOS, Windows
- 독립 실행형 CLI
- OpenCode 플러그인 호환 계층
- Claude CLI 및 `~/.claude/.credentials.json` 직접 조회
- API 키 기반 비용·사용량 조회
- 원본 프로젝트의 기타 제공자
- 자동 폴링, 상태바 상시 표시, 백그라운드 새로고침
- 설정 파일이나 사용자 정의 제공자 추가

OpenAI와 Anthropic의 구독 사용량 API는 OAuth 토큰을 요구한다. Senpi에 API 키만
등록된 경우 인증 실패로 처리하지 않고, 해당 인증 방식으로는 구독 한도를 조회할
수 없다는 안내를 표시한다.

## 3. 기준 구현과 외부 계약

- Senpi 확장 API:
  `code-yeongyu/senpi/packages/coding-agent/src/core/extensions/types.ts`
- Senpi OpenAI 사용량 예제:
  `packages/coding-agent/examples/extensions/openai-codex-usage/`
- Senpi 패키지 규약:
  `packages/coding-agent/docs/packages.md`
- 원본 OpenAI 구현:
  `slkiser/opencode-quota/src/lib/openai.ts`
- 원본 Anthropic 구현:
  `slkiser/opencode-quota/src/lib/anthropic.ts`

사용할 Senpi API:

- `pi.registerCommand("quota", ...)`
- `ctx.modelRegistry.getProviderAuth(providerId)`
- `ctx.modelRegistry.isUsingOAuth(model)`
- `ctx.ui.notify(message, type)`
- `ctx.ui.setStatus(key, text)` — 요청 진행 중 표시와 정리에만 사용

제공자 ID:

- OpenAI: `openai-codex`
- Anthropic: `anthropic`

외부 API:

| 제공자 | 요청 |
| --- | --- |
| OpenAI | `GET https://chatgpt.com/backend-api/wham/usage` |
| Anthropic | `GET https://api.anthropic.com/api/oauth/usage` |

OpenAI 요청 헤더:

- `Authorization: Bearer <OAuth access token>`
- `ChatGPT-Account-Id: <JWT에서 추출한 계정 ID>`

Anthropic 요청 헤더:

- `Authorization: Bearer <OAuth access token>`
- `anthropic-beta: oauth-2025-04-20`

두 요청 모두 10초 제한시간, 리다이렉트 거부, 취소 신호 전달을 적용한다.

## 4. 목표 파일 구조

```text
.
├── src/
│   ├── index.ts
│   ├── auth.ts
│   ├── format.ts
│   ├── http.ts
│   ├── types.ts
│   └── providers/
│       ├── anthropic.ts
│       └── openai.ts
├── test/
│   ├── auth.test.ts
│   ├── command.test.ts
│   ├── format.test.ts
│   └── providers/
│       ├── anthropic.test.ts
│       └── openai.test.ts
├── biome.json
├── package.json
├── tsconfig.json
├── LICENSE
├── README.md
└── plans.md
```

## 5. 공통 설계

### 제공자 결과

`src/types.ts`에 판별 가능한 유니온을 정의한다.

- 성공: 제공자 ID, 표시 이름, 0~100 범위의 잔여 퍼센트, 갱신 시각을 가진
  쿼터 창 목록
- 사용 불가: OAuth 미설정, 지원하지 않는 인증 방식, 응답에 쿼터 창 없음
- 실패: HTTP 상태, 네트워크 오류, 제한시간 초과, 잘못된 응답

예외를 명령 계층까지 던지지 않는다. 각 제공자 어댑터가 자신의 결과를 반환하고
`/quota`는 두 결과를 모두 렌더링한다.

### 인증

`src/auth.ts`가 Senpi 모델 레지스트리의 제공자 모델과 인증 결과를 OAuth
자격 증명으로 변환한다.

- Senpi 인증 저장소 파일을 직접 읽지 않는다.
- 토큰을 로그, 오류, 테스트 스냅샷에 포함하지 않는다.
- `ctx.modelRegistry.getAvailable()`에서 제공자 모델을 찾는다.
- `ctx.modelRegistry.isUsingOAuth(model)`로 OAuth 여부를 확인한다.
- OAuth 모델만 `ctx.modelRegistry.getApiKeyAndHeaders(model)`로 해석한다.
- 모델이 없거나 OAuth가 아니거나 토큰이 없으면 사용 불가 결과를 반환한다.
- OpenAI 계정 ID는 `@earendil-works/pi-ai`의
  `extractOpenAiCodexAccountId()`로 추출한다.

### HTTP

`src/http.ts`는 다음 기능만 담당한다.

- 기존 취소 신호와 10초 제한시간 결합
- `fetch` 호출
- HTTP 상태를 안정적인 내부 오류 코드로 변환
- 요청 종료 후 타이머 정리

비정상 HTTP 응답 본문과 원시 예외 메시지는 사용자 출력이나 로그에 사용하지
않는다. 따라서 서버가 토큰이나 제어 문자를 되돌려도 TUI에 도달하지 않는다.
자동 재시도는 하지 않는다. Anthropic 429 응답에서는 `Retry-After`를 읽어
사용자에게 다음 조회 가능 시점을 안내한다.

### 출력

`src/format.ts`는 순수 함수로 결과를 여러 줄 문자열로 변환한다.

```text
OpenAI
  5h         82% left · resets in 2h 14m
  Weekly     61% left · resets Aug 8 09:00

Anthropic
  5h         74% left · resets in 1h 03m
  Weekly     48% left · resets Aug 10 12:00
```

- 없는 창은 만들지 않는다.
- 퍼센트는 0~100으로 제한한다.
- 갱신 시각이 없으면 퍼센트만 표시한다.
- 일부 제공자만 성공하면 성공 결과와 실패 이유를 함께 표시한다.
- 둘 다 실패하면 오류 알림, 하나 이상 성공하면 정보 또는 경고 알림을 사용한다.

## 6. 구현 순서

### 단계 1 — 패키지 골격

1. `package.json`에 ESM 패키지 정보와 `pi.extensions: ["./src/index.ts"]`를
   선언한다.
2. `@code-yeongyu/senpi`와 `@earendil-works/pi-ai`를 peer dependency로
   선언한다.
3. TypeScript, Vitest, Biome 개발 의존성과 `typecheck`, `lint`, `test`,
   `check` 스크립트를 추가한다.
4. Node.js 최소 버전은 현재 Senpi 기준인 24 이상으로 맞춘다.
5. 엄격한 TypeScript 설정과 Node ESM 해석을 적용한다.

완료 기준:

- 의존성 설치 성공
- 빈 확장 진입점 typecheck 성공
- `senpi install git:github.com/bok-dong/pi-quota`가 패키지 메타데이터를
  인식할 구조 완성

### 단계 2 — 공통 타입, 인증, HTTP

1. 결과 유니온과 쿼터 창 타입부터 실패 테스트로 고정한다.
2. OAuth·API 키·인증 없음 분기를 테스트한 뒤 `src/auth.ts`를 구현한다.
3. 성공, 비정상 상태, 제한시간, 취소, 오류 비노출 테스트를 만든 뒤
   `src/http.ts`를 구현한다.

완료 기준:

- 인증 저장소 직접 파일 접근 없음
- OAuth 토큰 외 인증은 명시적인 사용 불가 결과
- 취소와 제한시간 테스트가 고정 sleep 없이 통과
- 비정상 응답 본문과 원시 오류가 출력·로그에 사용되지 않음

### 단계 3 — OpenAI 제공자

1. 원본의 익명화된 fixture와 핵심 파싱 사례를 이식한다.
2. `used_percent`를 잔여 퍼센트로 변환한다.
3. 5시간, 주간, 월간, 코드 리뷰 창을 duration과 응답 위치로 구분한다.
4. `reset_at`을 우선하고 `reset_after_seconds`를 보조값으로 사용한다.
5. 중복 창은 합치고 충돌하는 중복은 표시하지 않는다.
6. 계정 ID와 OAuth 토큰으로 OpenAI 요청을 구현한다.

완료 기준:

- 정확한 URL, 헤더, 리다이렉트 정책 테스트 통과
- 만료 토큰, malformed JSON, 빈 창, 비정상 HTTP 테스트 통과
- 모든 퍼센트가 0~100 범위
- 응답에 없는 쿼터 창을 생성하지 않음

### 단계 4 — Anthropic 제공자

1. `five_hour`/`fiveHour`, `seven_day`/`sevenDay` 응답 변형을 테스트한다.
2. `utilization`을 잔여 퍼센트로 변환한다.
3. `resets_at`, `resetsAt`, `reset_at`, `resetAt`을 지원한다.
4. Senpi Anthropic OAuth 토큰으로 usage endpoint를 호출한다.
5. 429의 `Retry-After`, malformed JSON, 잘못된 응답 shape를 결과로 변환한다.

완료 기준:

- Claude CLI 실행과 `~/.claude` 파일 접근 없음
- 정확한 URL과 `anthropic-beta` 헤더 테스트 통과
- 5시간과 주간 창이 모두 유효할 때만 성공 결과로 처리
- 토큰 포함 네트워크 오류가 완전히 제거됨

### 단계 5 — `/quota` 명령

1. `src/index.ts`에서 `quota` 명령을 등록한다.
2. 인자를 받지 않으며, 인자가 있으면 사용법을 안내한다.
3. Linux가 아니거나 `ctx.hasUI`가 false면 지원 범위를 안내하고 요청하지 않는다.
4. 새 호출이 이전 `/quota` 호출을 취소하도록 실행별 AbortController를 관리한다.
5. 실행 중 `ctx.ui.setStatus("pi-quota", "Loading quota…")`를 설정한다.
6. 두 제공자 요청을 동시에 시작하고 독립적으로 결과를 수집한다.
7. 결과를 한 번의 `ctx.ui.notify()` 호출로 출력한다.
8. 성공, 부분 성공, 전체 실패에 맞는 알림 수준을 선택한다.
9. 세션 종료 시 진행 중 요청을 취소한다.
10. 성공·실패 여부와 관계없이 현재 호출이 소유한 status만 정리한다.

완료 기준:

- `/quota`가 모델 턴을 시작하거나 컨텍스트 메시지를 추가하지 않음
- 한 제공자 실패가 다른 제공자 결과를 숨기지 않음
- 중복 실행에서는 최신 호출만 결과를 게시
- 취소, 잘못된 인자, 비 Linux, 비 TUI에서 미처리 Promise나 HTTP 요청 없음
- 알림과 status에 자격 증명 미노출

### 단계 6 — 패키징과 문서

1. Git 설치에 필요한 소스 파일을 패키지 포함 목록에 선언한다.
2. README의 “개발 중” 문구를 실제 상태에 맞게 갱신한다.
3. 설치, 업데이트, 제거, `/reload`, 인증 선행조건, 지원 범위를 문서화한다.
4. API 키 인증으로 구독 쿼터를 조회할 수 없음을 명시한다.
5. 원본 프로젝트 저작권 고지와 이식한 fixture/로직의 출처를 확인한다.

완료 기준:

- 깨끗한 임시 Senpi 환경에서 Git 설치 성공
- 설치된 패키지에서 `/quota` 명령 등록 확인
- 패키지 산출물에 테스트 fixture, 로컬 인증 파일, 토큰 없음

## 7. 테스트 전략

행동 변경은 테스트 우선으로 진행한다.

### 단위 테스트

- 인증 결과 분류
- OpenAI/Anthropic 응답 파싱
- 퍼센트 제한
- 갱신 시각 계산
- 안정적인 오류 코드와 원시 오류 비노출
- 결과 문자열 포맷

### 통합 테스트

가짜 `ExtensionAPI`, `ExtensionCommandContext`, `modelRegistry`, `fetch`를 사용해
다음을 검증한다.

- 명령 등록 이름과 설명
- 두 제공자 동시 조회
- OAuth 없음
- API 키만 존재
- 두 제공자 성공
- 한 제공자만 성공
- 둘 다 실패
- HTTP 401, 429, 500
- 잘못된 JSON
- 요청 취소와 제한시간
- 연속 호출 시 이전 요청 취소와 stale 결과 차단
- 비 Linux와 비 TUI의 조기 종료
- status가 항상 정리됨

시간 자체가 대상이 아닌 테스트에는 sleep이나 polling을 쓰지 않는다. 요청
Promise와 AbortSignal 이벤트를 먼저 구독한 뒤 상태 변화를 기다린다.

## 8. 최종 검증

자동 검증:

```bash
npm run typecheck
npm run lint
npm test
npm pack --dry-run
```

수동 QA:

1. `senpi -e ./src/index.ts`로 개발 확장을 로드한다.
2. `/help` 또는 명령 목록에서 `/quota` 등록을 확인한다.
3. `/quota extra`가 사용법을 출력하는지 확인한다.
4. 인증 없는 격리 환경에서 `/quota`가 로그인 안내를 출력하는지 확인한다.
5. 사용 가능한 OAuth 계정이 있는 경우 실제 `/quota` 출력과 갱신 시각을
   확인한다.
6. 패키지를 Git URL로 설치한 새 Senpi 프로세스에서 `/quota`를 다시 실행한다.

실제 OAuth 계정을 사용할 수 없으면 해당 실서비스 호출만 미검증으로 기록하고,
fixture 기반 HTTP 통합 테스트와 인증 없는 실제 TUI 경로는 반드시 완료한다.

## 9. 주요 위험과 대응

| 위험 | 대응 |
| --- | --- |
| 제공자 비공개 API 응답 변경 | 파서를 격리하고 알려진 필드만 허용 |
| Senpi 인증 API 변경 | 파일 직접 접근 없이 `modelRegistry` 경계만 사용 |
| API 키와 OAuth 혼동 | `isUsingOAuth()` 검사와 명확한 사용자 안내 |
| 부분 장애가 전체 명령 실패로 전파 | 제공자별 결과 유니온과 독립 수집 |
| 오류에 토큰 포함 | 응답 본문·원시 오류 비노출과 토큰 canary 테스트 |
| Git 설치 후 소스 누락 | `npm pack --dry-run`과 깨끗한 설치 QA |

## 10. 완료 정의

- Linux Senpi에서 Git URL 설치 가능
- `/quota`가 OpenAI와 Anthropic OAuth 쿼터를 표시
- 인증 없음, 지원하지 않는 인증, 부분 장애를 구분해 안내
- 모델 호출이나 컨텍스트 오염 없음
- 토큰 노출 없음
- typecheck, lint, 테스트, 패키지 검증 통과
- README 설치·사용법이 실제 동작과 일치
