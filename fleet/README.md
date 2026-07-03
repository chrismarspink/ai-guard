# Fleet / osquery — 설치 검증 연동

`innoecm-ai-guard_개발계획서.md` §2.4, §4.3 구현. Fleet(오픈소스, https://fleetdm.com)에 아래 두 파일을 적용하면
"확장 미설치/비활성" 단말을 15분 주기로 탐지해 정책 서버(`server/`)에 통보한다.

## 적용 방법

```sh
fleetctl apply -f fleet/policies.yml
fleetctl apply -f fleet/webhook-automation.yml
```

적용 전에 플레이스홀더를 실제 값으로 치환한다:

| 플레이스홀더 | 값 |
|---|---|
| `${INNOECM_AI_GUARD_EXTENSION_ID}` | 웹스토어/강제설치 배포 시 발급된 확장 ID |
| `${INNOECM_AI_GUARD_BLOCKED_VERSIONS}` | 콤마로 구분된 문제 버전 목록, 예: `'1.0.0','1.0.1'` |
| `${INNOECM_AI_GUARD_SERVER_URL}` | 정책 서버 base URL, 예: `https://policy.internal.example.com` |
| `${INNOECM_AI_GUARD_POLICY_ID}` | `policies.yml` 적용 후 Fleet이 부여한 policy ID |

## 알려진 제약 — 웹훅 인증

Fleet의 `failing_policies_webhook`은 목적지 URL로 평문 JSON POST만 지원하고 커스텀 헤더를 지원하지
않는다. 정책 서버의 `/api/v1/fleet/webhook`은 `X-Fleet-Webhook-Secret` 헤더로 보호되므로(§7 R10 —
이벤트 위조 방지와 동일한 이유), 다음 중 하나가 필요하다:

1. **권장**: Fleet과 정책 서버 사이에 리버스 프록시(nginx 등)를 두어 해당 경로 요청에
   `X-Fleet-Webhook-Secret` 헤더를 주입하고, 프록시 자체는 사내망/방화벽으로만 접근 허용.
   `INNOECM_AI_GUARD_SERVER_URL`은 이 프록시를 가리킨다.
   
2. 대안: 정책 서버가 헤더 대신 쿼리 파라미터(`?secret=...`)도 허용하도록 확장하고,
   `destination_url`에 `?secret=<FLEET_WEBHOOK_SECRET>`을 포함한다(쿼리 파라미터는 접근 로그에
   남을 수 있어 1번보다 권장하지 않음).

파일럿 배포 전 반드시 위 경로 중 하나를 확정할 것 — 미설정 시 웹훅 요청이 401로 거부되어
비준수 단말 탐지 파이프라인이 조용히 끊긴다.

## 하트비트 교차검증

osquery는 "있어야 하는데 없음"만 증명한다. 확장 자체의 하트비트(`POST /api/v1/install/heartbeat`,
기본 30분 주기)는 "있고 살아있음"을 증명하며, 두 신호를 자산목록(AD/HR)과 대조해야 미설치 단말을
확정할 수 있다(§2.4). 하트비트 2주기 누락 단말의 승격 처리는 정책 서버의 대시보드 로직에 있다.
