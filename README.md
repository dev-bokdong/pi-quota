# pi-quota

[opencode-quota](https://github.com/slkiser/opencode-quota)의 사용량 조회 기능을
[pi-mono](https://github.com/badlogic/pi-mono)용 확장으로 이식하는 프로젝트입니다.

전체 원본 기능을 복제하지 않습니다. Pi 안에서 자주 쓰는 `/quota` 명령과
OpenAI·Anthropic 사용량 조회에 집중합니다.

> [!NOTE]
> 현재 마이그레이션 작업 중입니다. 아직 설치 가능한 릴리스가 없습니다.

## 목표

- Pi 대화형 모드에서 `/quota` 명령 제공
- 조회 결과를 Pi TUI에 표시
- Pi가 저장한 인증 정보 재사용
- `senpi install`을 통한 패키지 설치
- Linux 환경 지원
- 모델 컨텍스트를 소비하지 않는 로컬 명령으로 동작

## 지원 범위

| 항목 | 지원 |
| --- | --- |
| 명령 | `/quota` |
| 운영체제 | Linux |
| OpenAI 인증 | 지원 대상 |
| Anthropic 인증 | 지원 대상 |
| macOS / Windows | 범위 밖 |
| 기타 opencode-quota 제공자 | 범위 밖 |
| 독립 실행형 CLI | 범위 밖 |
| OpenCode 플러그인 호환성 | 범위 밖 |

`Anthropic`은 회사·API 제공자 이름이며, Claude 제품군의 사용량을 뜻합니다.

## 목표 사용법

Pi를 실행하고 대화형 모드에서 다음 명령을 입력합니다.

```text
/quota
```

플러그인은 사용 가능한 OpenAI 및 Anthropic 인증을 감지한 뒤 각 제공자의
사용량 한도와 갱신 시점을 표시합니다. 출력 가능한 정보는 계정 종류와 제공자
응답에 따라 달라질 수 있습니다.

## 인증

별도 토큰 파일이나 환경 변수를 요구하지 않는 구성을 목표로 합니다. Pi에서
OpenAI 또는 Anthropic 로그인을 먼저 완료하면, 플러그인이 Pi의 인증 저장소를
통해 해당 자격 증명을 읽어 사용합니다.

자격 증명 원문은 `/quota` 출력이나 로그에 노출하지 않아야 합니다.

## 설치

아직 배포 전이므로 다음 명령은 현재 동작하지 않습니다. 패키징 완료 후
[Senpi](https://github.com/code-yeongyu/senpi)의 Git 패키지 설치 방식으로
배포할 예정입니다.

```bash
senpi install git:github.com/bok-dong/pi-quota
```

설치 후 Senpi를 다시 시작하거나 `/reload`를 실행하면 `/quota` 명령을 사용할
수 있는 구성을 목표로 합니다.

## 원본 프로젝트와 차이

원본 `opencode-quota`는 OpenCode 플러그인과 터미널 CLI를 제공하며 여러 인증
제공자를 지원합니다. `pi-quota`는 다음 원칙으로 범위를 줄입니다.

1. OpenCode API 대신 Pi 확장 API를 사용합니다.
2. `/quota` 하나만 제공합니다.
3. OpenAI와 Anthropic 인증만 다룹니다.
4. Linux에서만 동작을 보장합니다.

## 개발 상태

현재 저장소는 마이그레이션 워크스페이스 초기 단계입니다. 구현이 추가되기
전까지 이 문서의 기능 설명은 완료된 기능이 아닌 이식 목표를 나타냅니다.

## 크레딧

핵심 아이디어와 제공자별 사용량 조회 로직은
[slkiser/opencode-quota](https://github.com/slkiser/opencode-quota)를 기반으로
합니다.

## 라이선스

[MIT](LICENSE)
