# pi-quota

[opencode-quota](https://github.com/slkiser/opencode-quota)의 OpenAI·Anthropic 구독
사용량 조회 기능을 [Senpi](https://github.com/code-yeongyu/senpi) 확장으로 이식한
프로젝트입니다.

원본의 전체 기능을 복제하지 않습니다. Senpi 안에서 자주 쓰는 `/quota` 명령 하나와
OpenAI Codex·Anthropic 사용량 조회에 집중합니다.

## 기능

- Senpi 대화형 모드에서 `/quota` 명령 제공
- OpenAI Codex 5시간·주간·월간·코드 리뷰 한도와 Anthropic 5시간·주간 한도 표시
- Senpi가 이미 관리하는 OAuth 인증 정보를 그대로 재사용 (별도 로그인 절차 없음)
- 결과는 알림(notify)으로만 표시 — 모델 턴을 시작하거나 대화 컨텍스트를 소비하지
  않음
- 한 제공자 조회가 실패해도 다른 제공자의 결과는 그대로 표시 (부분 성공 지원)
- 토큰이나 자격 증명 원문은 어떤 출력·로그에도 노출하지 않음

## 지원 범위

| 항목 | 지원 |
| --- | --- |
| 명령 | `/quota` |
| 운영체제 | Linux |
| OpenAI 인증 | `openai-codex` OAuth (Codex 구독) |
| Anthropic 인증 | `anthropic` OAuth (Claude 구독) |
| API 키 인증 | 지원 안 함 — 아래 [인증](#인증) 참고 |
| macOS / Windows | 범위 밖 |
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
OpenAI
  Weekly     83% left · resets in 3d 2h 12m

Anthropic
  5h         78% left · resets in 2h 53m
  Weekly     74% left · resets in 2d 17h 55m
```

표시되는 창(5시간/주간/월간/코드 리뷰)은 응답에 실제로 포함된 항목만 나타나며,
계정 상태에 따라 달라집니다. `/quota`는 인자를 받지 않습니다 — 인자를 붙이면
다음 사용법 안내만 표시하고 요청을 보내지 않습니다.

```text
/quota takes no arguments. Run /quota on its own to read your quota.
```

## 인증

`/quota`는 별도의 로그인 절차나 토큰 설정을 요구하지 않습니다. Senpi에 이미
로그인되어 있는 OpenAI Codex 또는 Anthropic 계정의 OAuth 자격 증명을 그대로
읽어 사용합니다.

- 아직 로그인하지 않았다면 Senpi에서 해당 제공자로 평소 로그인 절차(OAuth)를
  먼저 완료하세요. 로그인 후에는 별도 설정 없이 `/quota`가 바로 자격 증명을
  찾아 사용합니다.
- **API 키로만 등록된 계정은 구독 사용량을 조회할 수 없습니다.** OpenAI·
  Anthropic 구독 한도 API는 OAuth 토큰을 요구하기 때문입니다. 이 경우 `/quota`
  는 오류로 실패하지 않고 해당 제공자에 대해 다음과 같이 안내합니다.

  ```text
  Anthropic: this account uses an API key, not OAuth - subscription quota isn't available
  ```

- 아예 로그인되어 있지 않은 제공자는 다음과 같이 안내합니다.

  ```text
  OpenAI: not signed in with OAuth
  ```

- 로그인 저장소 파일을 직접 읽지 않습니다. Senpi의 모델 레지스트리 경계
  (`ctx.modelRegistry`)를 통해서만 자격 증명을 조회합니다.
- 자격 증명 원문은 `/quota` 출력이나 로그 어디에도 노출되지 않습니다.

## 원본 프로젝트와 차이

원본 `opencode-quota`는 OpenCode 플러그인과 터미널 CLI를 제공하며 여러 인증
제공자를 지원합니다. `pi-quota`는 다음 원칙으로 범위를 줄였습니다.

1. OpenCode API 대신 Senpi 확장 API를 사용합니다.
2. `/quota` 명령 하나만 제공합니다.
3. OpenAI Codex와 Anthropic OAuth 인증만 다룹니다.
4. Linux에서만 동작을 보장합니다.

## 개발 상태

구현이 완료되었습니다. `/quota` 등록, OpenAI·Anthropic 조회, 부분 성공/실패
처리, 취소·중복 실행 처리까지 자동 테스트와 실제 Senpi 세션에서의 사용량 조회로
확인했습니다.

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
