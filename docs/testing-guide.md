# 강제 설치(GPO) 없이 로컬에서 테스트하는 방법

Chrome Enterprise `ExtensionInstallForcelist` 같은 강제설치 정책은 실제 사내 배포 단계에서만
필요하다. 개발/QA 단계에서는 아래 절차만으로 프롬프트 검사, 파일 업로드 통제, 정책 서버, 이벤트
수집까지 전부 검증할 수 있다. 사전 준비물은 Node.js·Python·Docker뿐이며, 이 저장소를 만든 환경
기준으로 이미 검증된 버전은 Node 24, Python 3.12, Docker 29다.

## 0. 자동화 테스트부터 (가장 빠른 회귀 확인)

```bash
# T1 판정 규칙 (단일 소스)
cd profiles && pip install pytest && pytest -q          # 13 passed

# 브라우저 확장
cd ../extension && npm install
npx tsc --noEmit                                         # 타입 오류 없음
npm test                                                  # 71 passed
npm run build                                             # dist/ 생성

# 정책 서버
cd ../server
python -m venv .venv && . .venv/Scripts/activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
pytest -q                                                 # 28 passed
```

이 네 스텝이 모두 통과하면 판정 로직·확장 빌드·서버 API는 이미 검증된 것이다. 아래부터는 "실제로
동작하는지" 눈으로 확인하는 수동 절차다.

## 1. 정책 서버를 로컬에 띄우기

```bash
cd server
cp .env.example .env
# .env에서 JWT_SECRET / FLEET_WEBHOOK_SECRET을 임의의 긴 문자열로 바꾸고,
# 로그인 테스트를 하려면 SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD도 채운다(개발 전용).
docker compose up --build
```

헬스체크:

```bash
curl http://localhost:8090/healthz
```

### 1.1 관리자로 로그인해 정책 확인 — 관리 콘솔(권장) 또는 curl

가장 쉬운 방법: 브라우저로 `http://localhost:8090/admin` 접속 → `.env`에 넣은
`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`로 로그인하면 정책 조회·수정, 대시보드 요약을
클릭만으로 볼 수 있다. 로그인 후 발급된 JWT는 브라우저 `sessionStorage`에만 저장되고
탭을 닫으면 사라진다.

curl로 동일한 것을 확인하려면(스크립트/CI용):

```bash
TOKEN=$(curl -s -X POST http://localhost:8090/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<SEED_ADMIN_EMAIL>","password":"<SEED_ADMIN_PASSWORD>"}' | jq -r .access_token)

curl http://localhost:8090/api/v1/dashboard/summary -H "Authorization: Bearer $TOKEN"
```

### 1.2 설치(확장) 시뮬레이션 — 등록 → 정책 조회 → 하트비트 → 이벤트

확장 없이도 curl만으로 확장이 서버와 주고받는 전체 흐름을 재현할 수 있다:

```bash
# 1) 설치 등록 (인증 불필요 — 최초 부트스트랩)
RESP=$(curl -s -X POST http://localhost:8090/api/v1/install/register \
  -H "Content-Type: application/json" -d '{"version":"0.1.0"}')
INSTALL_ID=$(echo "$RESP" | jq -r .installId)
INSTALL_TOKEN=$(echo "$RESP" | jq -r .token)

# 2) 정책 조회 (설치 토큰 필요)
curl http://localhost:8090/api/v1/policy \
  -H "Authorization: Bearer $INSTALL_TOKEN" -H "X-Install-Id: $INSTALL_ID"

# 3) 하트비트
curl -X POST http://localhost:8090/api/v1/install/heartbeat \
  -H "Authorization: Bearer $INSTALL_TOKEN" -H "X-Install-Id: $INSTALL_ID" \
  -H "Content-Type: application/json" -d '{"version":"0.1.0","enabled":true}'

# 4) 이벤트 전송 (예: 프롬프트 차단 이벤트) -- ts는 필수 필드
curl -X POST http://localhost:8090/api/v1/events \
  -H "Authorization: Bearer $INSTALL_TOKEN" -H "X-Install-Id: $INSTALL_ID" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"prompt_block\",\"site\":\"chatgpt\",\"grade\":\"C\",\"score\":6.0,\"detections\":[{\"type\":\"KR_RRN\",\"count\":1}],\"action\":\"blocked\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
```

이 흐름이 되면 서버 쪽은 실제 확장과 동일하게 검증된 것이다. 잘못된 토큰이나 다른 `X-Install-Id`를
넣으면 401이 나야 정상이다(계획서 §7 R10 — 이벤트 위조 방지가 실제로 걸리는지 확인하는 셈).

## 2. 확장을 개발자 모드로 로드하기 (강제설치 불필요)

```bash
cd extension
npm install && npm run build
```

1. Chrome에서 `chrome://extensions` 접속
2. 우측 상단 "개발자 모드" 켜기
3. "압축해제된 확장 프로그램을 로드합니다" → `extension/dist` 폴더 선택

이 방법은 GPO/Google Admin Console 없이도 확장을 정상적으로 활성화한다. `manifest.json`의
`host_permissions`가 ChatGPT/Claude/Gemini 3개 사이트로 한정돼 있어, 해당 사이트를 열 때만 동작한다.

관리형 정책(`chrome.storage.managed`)이 없으면 확장은 자동으로 `extension/src/policy/default-policy.json`
값을 쓴다 — 즉 **기업 정책 배포 없이도 기본 동작을 그대로 테스트할 수 있다**. 로컬 서버로 하트비트/
이벤트를 보내게 하려면 `default-policy.json`의 `serverBaseUrl`이 이미 `http://localhost:8090`로
맞춰져 있으니 별도 수정이 필요 없다.

### 2.1 수동 테스트 체크리스트 — 프롬프트

ChatGPT/Claude/Gemini 아무 사이트나 열고 입력창에 아래를 입력해 전송을 시도한다.

| 입력 예시 | 기대 등급 | 기대 동작 (기본 정책: `mode.prompt = confirm`) |
|---|---|---|
| "오늘 회의 몇 시야?" | O | 그대로 전송됨 (다이얼로그 없음) |
| "문의는 user@example.com 으로" | S | 확인 다이얼로그 표시 → [그대로 전송] 선택 시 전송, 로그 남음 |
| "제 주민번호는 900101-1234568 이에요" | C | 정책이 `block`이면 차단, `confirm`이면 확인 후 전송 |
| "AKIAABCDEFGHIJKLMNOP" | C | 위와 동일 |
| "이 내용은 대외비입니다" | S | 확인 다이얼로그 |

다이얼로그에서 확인할 것(2026-07-03 추가):
- 등급 배지(공개/민감/기밀 + O/S/C)와 점수, 검출 항목 목록(타입·건수·마스킹된 샘플·기여도 막대)이 보이는지
- "이 판정 결과와 선택하신 조치는 감사 로그로 기록되어..." 문구가 항상 보이는지
- **익명화 후 전송**: 주민번호가 포함된 문장에서 [개인정보 마스킹 후 전송] 클릭 → 입력창의 텍스트가 마스킹된 버전으로 바뀌고 그대로 전송됨 → 서버 이벤트가 `prompt_anonymized_sent`로 기록되는지(§1.2 curl로 직접 조회하거나 관리 콘솔 대시보드에서 확인). 마스킹 후에도 문장에 "기밀" 같은 등급 키워드가 남아 있으면 등급이 그대로 S/C일 수 있음 — 의도된 동작(키워드는 PII가 아니라 마스킹 대상이 아님)

### 2.2 수동 테스트 체크리스트 — 파일 업로드 (기본 정책: 컨텐츠 스캔만 켜짐, MIP 꺼짐)

| 파일 | 기대 판정 | 비고 |
|---|---|---|
| PII 없는 `.txt`/`.docx`/`.xlsx` | 등급 O → 통과 | |
| 주민번호/카드번호가 포함된 `.txt` | 등급 C → 정책에 따라 차단/확인 | 파일 전체를 T1 엔진으로 검사 |
| `.pdf` 아무 파일 | 무조건 차단 | v1은 PDF 텍스트 추출 미지원 → fail-closed. 다이얼로그에 등급 대신 "분석 불가" 배지가 뜨는지 확인 |
| 50MB 초과 파일 | 무조건 차단 | 크기 상한 |
| 정상 텍스트를 담은 `.pptx` | 등급 O → 통과 | 슬라이드 텍스트 추출 확인용 |

MIP 라벨 검사까지 같이 켜서 테스트하려면 관리형 정책으로 `fileCheck.mipCheck: true`를 내려줘야 한다
(§3 참조) — 기본 개발자 모드 로드만으로는 컨텐츠 스캔 경로만 확인된다.

## 3. (선택) 관리형 정책(enterprise policy)을 강제설치 없이 시뮬레이션하기

`chrome.storage.managed`는 확장 강제설치(`ExtensionInstallForcelist`)와는 별개의 GPO
(`3rdparty/extensions/<확장ID>/policy`)로 주입된다. 강제설치 없이 "관리형 정책이 내려온 경우"만
테스트하고 싶다면 Windows에서 아래처럼 레지스트리에 정책 스키마 값을 넣을 수 있다(선택 사항, 이번
검증 범위에서 필수는 아님):

```powershell
# <EXTENSION_ID>는 chrome://extensions에서 "압축해제된 확장 프로그램을 로드합니다" 후 표시되는 ID
New-Item -Path "HKCU:\Software\Policies\Google\Chrome\3rdparty\extensions\<EXTENSION_ID>\policy" -Force
# 이후 default-policy.json과 동일한 키를 REG_SZ/JSON 값으로 등록 — Chrome 정책 문서의
# "확장 프로그램별 정책" 스키마 등록 절차를 따른다.
```

이 단계는 관리형 정책 폴백 로직 자체를 검증하는 용도이며, 생략해도 §2의 기본 동작 테스트에는
영향이 없다.

## 4. Fleet/osquery — 이번 로컬 검증 범위에서는 선택 사항

Fleet 서버 자체를 띄우는 것은 별도 인프라가 필요해 "강제설치 없는 빠른 검증"의 범위를 벗어난다.
osquery 쿼리 문법만 확인하고 싶다면 `osqueryi`가 설치된 머신에서 `fleet/policies.yml`의 SQL을
직접 실행해볼 수 있다:

```sql
SELECT identifier, version, state FROM chrome_extensions;
```

이 결과에 로컬에서 로드한 확장의 ID가 `state = 1`로 나오면 오스쿼리 자체는 정상 동작하는 것이다.
Fleet 서버 연동과 웹훅 전체 파이프라인 검증은 별도 스테이징 환경에서 진행할 것을 권장한다
([`fleet/README.md`](../fleet/README.md) 참조).

## 5. 트러블슈팅

| 증상 | 원인/조치 |
|---|---|
| 확장이 사이트에서 반응 없음 | `manifest.json`의 `host_permissions`에 해당 사이트가 없거나, 어댑터 셀렉터가 사이트 개편으로 깨졌을 수 있음 — `extension/src/adapters/*.json` 확인 |
| 하트비트/이벤트가 서버에 안 감 | `default-policy.json`의 `serverBaseUrl`이 실제 서버 주소와 다른지, 서버가 `docker compose up` 상태인지 확인 |
| 이벤트 전송 시 401 | 설치 토큰/`X-Install-Id`가 일치하지 않음 — §1.2처럼 등록 응답의 값을 그대로 써야 함 |
| PDF 업로드가 항상 차단됨 | 의도된 동작(§4.2 v1 제한) — 컨텐츠 스캔이 PDF 텍스트 추출을 지원하지 않아 fail-closed |
| `docker compose up` 실패 | `.env`의 `DATABASE_URL`/`POSTGRES_*` 값이 서로 일치하는지, 8090 포트가 이미 사용 중인지 확인 |
| `/dashboard`·`/healthz` 접속 시 502 (`mitmproxy`가 응답) | 호스트 8080에 우리 서버가 아닌 다른 컨테이너가 떠 있는 것 — `docker ps`로 확인. 우리 서버는 8090에 매핑돼 있으니 `localhost:8090`으로 접속 |
| 서버가 `UndefinedColumn` 또는 이벤트 전송 시 `StringDataRightTruncation`(500)으로 실패 | 이전 버전의 Postgres 볼륨이 남아있는데 스키마(컬럼 추가 또는 enum 값 추가로 VARCHAR 길이 부족)가 바뀐 경우 — 마이그레이션 시스템이 없는 v1의 알려진 제약(`server/README.md` "Data model / migrations" 참조). `docker compose down -v`로 볼륨을 지우고 다시 `up --build` |
