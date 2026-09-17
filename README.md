# pi-quota

[opencode-quota](https://github.com/slkiser/opencode-quota)의 OpenAI·Anthropic 구독
사용량 조회 기능을 [Senpi](https://github.com/code-yeongyu/senpi) 확장으로 이식한
프로젝트입니다.

원본의 전체 기능을 복제하지 않습니다. Senpi 안에서 자주 쓰는 `/quota` 명령 하나와
OpenAI Codex·Anthropic·Claude SDK OAuth 사용량 조회에 집중합니다.

## 기능

- Senpi 대화형 모드에서 `/quota` 명령 제공
- OpenAI Codex 5시간·주간·월간·코드 리뷰 한도와 Anthropic 5시간·주간 한도 표시
- `claude-sdk-oauth`(Claude Agent SDK) 레인에 로그인해 두었으면 그 계정의 Claude
  구독 한도도 함께 표시 (로그인하지 않았으면 해당 블록은 아예 나오지 않음)
- 같은 제공자에 계정이 여러 개 등록되어 있으면 계정별로 한도를 각각 표시
- Senpi가 이미 관리하는 OAuth 인증 정보를 그대로 재사용 (별도 로그인 절차 없음)
- 결과는 알림(notify)으로만 표시 — 모델 턴을 시작하거나 대화 컨텍스트를 소비하지
  않음
- 한 제공자 조회가 실패해도 다른 제공자의 결과는 그대로 표시 (부분 성공 지원)
- OAuth가 없는 제공자·계정(미로그인, API 키 전용)은 경고 없이 출력에서 조용히 제외
- 토큰이나 자격 증명 원문은 어떤 출력·로그에도 노출하지 않음

## 지원 범위

| 항목 | 지원 |
| --- | --- |
| 명령 | `/quota` |
| 운영체제 | Linux, Windows (macOS는 지원하나 미검증) |
| OpenAI 인증 | `openai-codex` OAuth (Codex 구독) |
| Anthropic 인증 | `anthropic` OAuth (Claude 구독) |
| Claude SDK 인증 | `claude-sdk-oauth` OAuth (`/login claude-sdk-oauth` 계정, `CLAUDE_CODE_OAUTH_TOKEN[_N]` 포함) |
| 멀티 계정 | 세 제공자 모두 계정별 조회 (`/account`, `/gpt-account`, `/claude-account`로 관리하는 계정) |
| Claude SDK ambient 레인 | 범위 밖 (호스트 Claude CLI가 직접 보관하는 토큰은 읽지 않음) |
| API 키 인증 | 지원 안 함 — 아래 [인증](#인증) 참고 |
| 기타 opencode-quota 제공자 | 범위 밖 |
| 독립 실행형 CLI | 범위 밖 |
| OpenCode 플러그인 호환성 | 범위 밖 |

`Anthropic`은 회사·API 제공자 이름이며, Claude 제품군의 사용량을 뜻합니다.

## 설치

```bash
senpi install git:github.com/bok-dong/pi-quota
```

설치 후 Senpi를 다시 시작하거나 대화형 세션에서 `/reload`를 실행하면 `/quota`
명령을 바로 사용할 수 있습니다.

### 업데이트

```bash
senpi update git:github.com/bok-dong/pi-quota
```

### 제거

```bash
senpi remove git:github.com/bok-dong/pi-quota
```

(`senpi uninstall`은 `remove`의 별칭이며 동일하게 동작합니다.)

## 사용법

Senpi를 실행하고 대화형 모드에서 다음 명령을 입력합니다.

```text
/quota
```

로그인되어 있는 각 제공자의 사용량 한도와 갱신 시점이 알림으로 표시됩니다.
실제 출력 예시:

```text
   [OpenAI]
     Weekly                 3d
     █████████████████████░░░░ 83%

   [Anthropic]
     Five-hour            2.5h
     ████████████████████░░░░░ 78%
     Weekly                 2d
     ███████████████████░░░░░░ 74%

   [Claude SDK]
     Five-hour            2.5h
     ██████████████████░░░░░░░ 71%
     Weekly                 2d
     ████████████████░░░░░░░░░ 63%
```

`[Claude SDK]` 블록은 `claude-sdk-oauth` 레인에 계정이 하나라도 등록되어 있을 때만
나타납니다. 이 레인을 쓰지 않는 세션의 출력은 이전과 동일합니다.

한 제공자에 계정이 둘 이상 등록되어 있으면 계정마다 블록이 하나씩 나오고 헤더에
계정 이름이 붙습니다. 이름은 `/account <provider> rename`으로 지정한 표시 이름이
있으면 그것을, 없으면 계정 ID를 씁니다. 계정이 하나면 헤더는 그대로
`[OpenAI]`입니다.

```text
   [OpenAI: default]
     Weekly                 2d
     ░░░░░░░░░░░░░░░░░░░░░░░░░ 0%

   [OpenAI: work]
     Five-hour              4h
     █████████████████████████ 99%
     Weekly                 4d
     ███████████░░░░░░░░░░░░░░ 44%
```

표시되는 창(5시간/주간/월간/코드 리뷰)은 응답에 실제로 포함된 항목만 나타나며,
계정 상태에 따라 달라집니다. `/quota`는 인자를 받지 않습니다 — 인자를 붙이면
다음 사용법 안내만 표시하고 요청을 보내지 않습니다.

```text
/quota takes no arguments. Run /quota on its own to read your quota.
```

## 인증

`/quota`는 별도의 로그인 절차나 토큰 설정을 요구하지 않습니다. Senpi에 이미
로그인되어 있는 OpenAI Codex·Anthropic·Claude SDK OAuth 계정의 자격 증명을 그대로
읽어 사용합니다.

- 아직 로그인하지 않았다면 Senpi에서 해당 제공자로 평소 로그인 절차(OAuth)를
  먼저 완료하세요. 로그인 후에는 별도 설정 없이 `/quota`가 바로 자격 증명을
  찾아 사용합니다.
- **OAuth가 없는 제공자는 경고 없이 출력에서 조용히 빠집니다.** 아예 로그인되어
  있지 않은 제공자와, API 키로만 등록된 계정(OpenAI·Anthropic 구독 한도 API가
  OAuth 토큰을 요구하므로 조회할 수 없음)이 여기에 해당합니다. 안내 문구도 경고
  알림도 없이 해당 제공자 블록 자체가 나타나지 않고, 나머지 제공자의 결과만
  그대로 표시됩니다. 계정이 여러 개인 제공자에서 일부 계정만 OAuth가 없으면 그
  계정의 블록만 빠집니다.
- 읽을 수 있는 제공자가 하나도 없으면 `/quota`는 아무 알림도 표시하지 않습니다.

- `claude-sdk-oauth` 계정은 토큰을 호스트 인증 경로로 받을 수 없습니다. 이 레인은
  실제 요청을 Claude Agent SDK 하위 프로세스가 보내기 때문에 호스트가 이 제공자의
  인증을 토큰이 아닌 `claude-sdk-oauth-managed` 표식으로 해석합니다. 따라서 각
  계정의 토큰은 그 계정의 자격 증명 슬롯(`listSlots`가 돌려주는 `access`)에서
  직접 읽고, 표식이 들어 있는 슬롯은 무시합니다.
- 저장된 `claude-sdk-oauth` 토큰이 이미 만료되었으면 갱신하지 않고 그대로 보고합니다.
  리프레시 토큰은 회전되기 때문에, 자격 증명을 소유한 레인 외에는 갱신해서는 안
  됩니다(다른 곳에서 갱신하면 그 계정 로그인이 깨집니다).

  ```text
     [Claude SDK]: the stored token has expired - sign in again to refresh it
  ```

- 계정이 여러 개인 제공자는 계정별로 토큰을 따로 해석합니다. 계정 목록은
  `ctx.modelRegistry.authStorage.listSlots(provider)`로 읽고, `openai-codex`·
  `anthropic` 계정의 토큰은 호스트의 계정 단위
  인증(`modelRuntime.getAuth(provider, { slotName })`)으로 받습니다. 이 경로는
  해당 계정의 토큰만 갱신하며 다른 계정으로 폴백하지 않으므로,
  한 계정의 한도가 다른 계정 이름으로 표시되는 일은 없습니다. 한 계정이 실패해도
  나머지 계정 결과는 그대로 표시됩니다.
- 계정 풀을 지원하지 않는 구버전 호스트에서는 두 멤버가 없으므로 기존처럼 제공자당
  단일 자격 증명을 읽고 계정 이름 없이 표시합니다.
- 로그인 저장소 파일을 직접 읽지 않습니다. Senpi의 모델 레지스트리 경계
  (`ctx.modelRegistry`)를 통해서만 자격 증명을 조회합니다.
- 자격 증명 원문은 `/quota` 출력이나 로그 어디에도 노출되지 않습니다.

## 원본 프로젝트와 차이

원본 `opencode-quota`는 OpenCode 플러그인과 터미널 CLI를 제공하며 여러 인증
제공자를 지원합니다. `pi-quota`는 다음 원칙으로 범위를 줄였습니다.

1. OpenCode API 대신 Senpi 확장 API를 사용합니다.
2. `/quota` 명령 하나만 제공합니다.
3. OpenAI Codex·Anthropic·Claude SDK OAuth 인증만 다룹니다.
4. Linux와 Windows에서 동작을 검증했습니다. macOS는 플랫폼 의존 코드가 없어
   지원 대상이지만 실기기 검증은 하지 않았습니다.

## 개발 상태

구현이 완료되었습니다. `/quota` 등록, OpenAI·Anthropic 조회, 부분 성공/실패
처리, 취소·중복 실행 처리까지 자동 테스트와 실제 Senpi 세션에서의 사용량 조회로
확인했습니다.

`claude-sdk-oauth` 레인은 자동 테스트와 실제 호스트 `AuthStorage.listSlots` 슬롯
읽기 검증까지 마쳤습니다. 실제 `claude-sdk-oauth` 로그인 세션에서의 라이브 조회는
아직 검증하지 않았습니다.

```bash
bun run check   # 타입체크 + lint
bun run test    # 단위·통합 테스트
```

## 크레딧

핵심 아이디어와 제공자별 사용량 조회 로직은
[slkiser/opencode-quota](https://github.com/slkiser/opencode-quota)를 기반으로
합니다.

## 라이선스

[MIT](LICENSE)
