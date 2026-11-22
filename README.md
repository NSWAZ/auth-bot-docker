# auth-bot-docker

NIS와 리크루트 두 Discord 길드를 함께 맡는 봇(v4)의 Docker 이미지 저장소입니다. Portainer Stack 설정은 이 저장소 밖에서 관리합니다.

## 기능

- NIS 길드: `/newbie`, `/inactive`(SeAT 역할 부여·제거), `/grill_reload`(채널 복사 후 아카이브 이동), `안내` 채널 안내 메시지
- 리크루트 길드: 가입·기타 문의 상담 흐름, `가입-안내` 채널 안내 메시지, `/상담완료`
- `/상담완료`: 상담 채널을 보관소(intel-archive)에 보관하고 POST·GET 응답을 대조해 검증한 뒤 **채널을 삭제**합니다. 검증되지 않으면 채널을 지우지 않습니다. 이미 보관된 채널(409)은 `by-channel` 조회로 기존 보관본을 확인한 뒤 삭제하며, 보관 이후 쓰인 새 메시지 수를 담당자에게 알립니다(내용은 남기지 않음).
- 안내 메시지는 봇 자신이 쓴 메시지만 교체합니다.
- 리크루트 상담 상태는 리크루트 길드의 `states-backup` 채널에 30분마다·종료 시 백업하고, 시작할 때 이 봇이 쓴 백업만 복원합니다(v3 백업 형식과 같음).

봇에 필요한 Discord 권한: 리크루트 길드에서 채널 관리(상담 채널 생성·삭제), 역할 관리(채널 권한 설정), 메시지 기록 보기. NIS 길드에서 채널 관리(`/grill_reload`). Message Content와 Server Members 인텐트를 켜야 합니다.

## Portainer / Docker Swarm 설정

민감하지 않은 값은 일반 환경변수로 전달합니다.

- `DISCORD_NIS_GUILD_ID`, `DISCORD_RECRUIT_GUILD_ID` (필수)
- `INTEL_ARCHIVE_URL` (보관소 주소, 기본값 `http://127.0.0.1:8000`이므로 Swarm에서는 반드시 설정)
- `BAN_LIST_FILE` (선택, 리크루트 밴 목록 파일 경로. 없으면 빈 목록으로 동작하고 경고를 남깁니다. 형식은 `ban-list.example.json`)
- `LOG_LEVEL` (선택, 기본값 `INFO`)
- `RECRUIT_ERROR_CONTACT_ID` (선택, 리크루트 오류 안내에서 문의 대상으로 멘션할 Discord 사용자 ID. 없으면 "리크루터에게 문의"로 안내)
- 선택: `INTEL_ARCHIVE_TIMEOUT_MS`(180000), `INTEL_ARCHIVE_GET_TIMEOUT_MS`(30000), `INTEL_ARCHIVE_RETRIES`(2), `INTEL_ARCHIVE_RETRY_DELAY_MS`(2000). 시간 제한과 재시도의 합이 Discord 응답 시간(15분)을 넘으면 봇이 시작하지 않습니다.
- 선택, 보관소 설정과 같은 값이어야 함: `INTEL_ARCHIVE_MAX_REQUEST_BYTES`, `INTEL_ARCHIVE_ATTACHMENT_HOSTS`, `INTEL_ARCHIVE_ALLOWED_MIME_TYPES`, `INTEL_ARCHIVE_MAX_ATTACHMENT_BYTES`

민감한 값은 Portainer에서 Docker Secret으로 생성하고 다음 파일 환경변수로 연결합니다. 밴 목록 파일도 Docker config나 secret으로 넣습니다.

- `DISCORD_TOKEN_FILE=/run/secrets/auth_bot_discord_token`
- `SEAT_TOKEN_FILE=/run/secrets/auth_bot_seat_token`
- `INTEL_ARCHIVE_TOKEN_FILE=/run/secrets/auth_bot_intel_archive_token`

Portainer Stack 편집기에서는 위 경로만 설정하지 말고, 각 Secret을 Stack 최상위에서 `external: true`로 선언한 뒤 auth-bot 서비스의 `secrets` 목록에도 연결해야 합니다. 실제 Stack 파일은 Portainer에서 관리하며 이 저장소에는 두지 않습니다.

직접 환경변수인 `DISCORD_TOKEN`, `SEAT_TOKEN`, `INTEL_ARCHIVE_TOKEN`도 지원하지만, 같은 이름의 직접 값과 `_FILE`이 모두 있으면 직접 값이 우선합니다. 실제 Secret 값, 밴 목록 파일과 `.env` 파일은 Git에 넣지 않습니다. 로컬 개발용 예시는 `.env.example`에 있습니다.

## v3.0.2에서 넘어갈 때

같은 서비스·같은 `DISCORD_TOKEN`(같은 봇 계정)으로 v3.0.2를 대신합니다. v3.0.2를 먼저 멈추면 종료 백업이 `states-backup`에 남고, v4가 시작할 때 그 백업을 복원합니다. 두 봇을 동시에 실행하지 않습니다. `/상담완료`는 이제 채널을 아카이브 분류로 옮기지 않고 삭제합니다.

## 개발

```bash
npm ci
npm test        # 빌드 후 tests/*.test.js
npm run typecheck
npm run lint
```
