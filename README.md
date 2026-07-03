# innoecm-ai-guard

`innoecm-ai-guard_개발계획서.md`(개발 계획서) 기반 구현. Chrome MV3 확장(프롬프트 DLP + 파일
업로드 통제) + Docker 기반 정책/관리 서버 + Fleet/osquery 설치 검증 연동으로 구성된 모노레포.

**문서**: 전체 산출물 설명은 [`docs/guide.md`](docs/guide.md), 강제 설치(GPO) 없이 로컬에서
검증하는 방법은 [`docs/testing-guide.md`](docs/testing-guide.md) 참조.

**라이브 데모**: 관리 콘솔이 Hugging Face Spaces에 떠 있다 —
https://chrismarspink-ai-guard-console.hf.space/admin (무료 티어라 미사용 시 슬립, SQLite라
재시작 시 데이터 초기화됨. `server/README.md` "Deploying a demo to Hugging Face Spaces" 참조).
확장의 기본 `serverBaseUrl`도 이 주소를 가리키도록 바뀌었다 — 압축해제된 확장을 로드만 해도 바로
이 서버와 통신한다.

## 구성

| 경로 | 내용 | 실행 방식 |
|---|---|---|
| [`profiles/`](profiles/) | `data_classifier.py` — T1 정규식/가중치/키워드/임계값의 단일 소스(회사 표준 `data_classifier.py`/`.md`의 JS 포팅 가능 부분집합). `export_patterns.py`가 GradeProfile JSON 번들을 생성해 서버·확장 양쪽에 배포 | Python (venv) |
| [`extension/`](extension/) | Chrome MV3 확장 — T1 검사 엔진, 파일 전체 내용 스캔(기본) + MIP 라벨 파서(옵션), 사이트 어댑터(ChatGPT/Claude/Gemini), 정책 로더, 이벤트 큐/하트비트 | Node/Vite (로컬 빌드 → 압축 해제된 확장 로드) |
| [`server/`](server/) | 정책/관리 서버(FastAPI) — 정책 배포, 이벤트 수집, 설치 하트비트, Fleet 웹훅, 관리 콘솔(`/admin`)·대시보드 | **Docker (docker compose)** |
| [`fleet/`](fleet/) | Fleet(osquery) policy/webhook 설정 — 확장 미설치·비활성 단말 탐지 | `fleetctl apply` |

관리 시스템(정책 서버)은 계획서에 별도 배포 방식이 명시되지 않아 Docker로 구성했다(`server/Dockerfile`,
`server/docker-compose.yml`) — 계획서 §3.1이 명시한 "온프레미스 배포 전제(에어갭 고객 대응),
Docker Compose/K8s"를 따른 것.

## 빠른 시작

### 1. GradeProfile 번들 생성 (T1 규칙의 단일 소스)

```bash
cd profiles
pip install pytest
pytest -q                     # 13 passed
python export_patterns.py     # profiles/dist/n2sf-v1.gradeprofile.json 생성
                               # + extension/src/engine/gradeProfile.json 로 자동 복사
```

`data_classifier.py`의 패턴/가중치/임계값을 수정했다면 반드시 재실행할 것 — 서버와 확장의 판정
일관성(계획서 §2.3, §8)이 이 파일 하나에 달려 있다.

### 2. 정책 서버 (Docker)

```bash
cd server
cp .env.example .env   # JWT_SECRET / FLEET_WEBHOOK_SECRET 등 설정
docker compose up --build
```

`http://localhost:8090/api/v1/...`(호스트 8090 → 컨테이너 내부 8080; 이 머신에 다른 프로젝트의
mitmproxy가 이미 호스트 8080을 쓰고 있어 충돌을 피했다), 헬스체크 `GET /healthz`. 관리 콘솔은
`http://localhost:8090/admin`(로그인 후 정책 조회/수정·대시보드 요약). 자세한 API 목록·인증 모델은
[`server/README.md`](server/README.md) 참조.

### 3. 브라우저 확장

```bash
cd extension
npm install
npm test          # vitest — 71 passed
npm run build     # dist/ 생성
```

`chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램을 로드합니다" → `extension/dist` 선택.
자세한 모듈 구조·빌드 방식은 [`extension/README.md`](extension/README.md) 참조.

### 4. Fleet/osquery 설치 검증 연동

```bash
fleetctl apply -f fleet/policies.yml
fleetctl apply -f fleet/webhook-automation.yml
```

플레이스홀더 치환과 웹훅 인증 관련 알려진 제약은 [`fleet/README.md`](fleet/README.md) 참조.

## 계획서 대비 구현 범위

계획서 §9 "Claude Code 작업 지시"의 우선순위(T1 엔진 → ChatGPT 어댑터 → MIP 파서 → 정책 로더 →
이벤트 큐/하트비트 → 서버 API → 대시보드 → Fleet 웹훅)를 그대로 구현했다. 아래는 v1 범위에서 의도적으로
남겨둔 것들이며, 각 컴포넌트 README에 이유가 적혀 있다:

- **대시보드**: 기존 InnoECM 콘솔에 통합하는 것이 목표(§3.1)이므로, 이번 v1은 독립 React SPA 대신
  서버 렌더링 HTML 요약 페이지(`GET /api/v1/dashboard`)만 제공한다.
- **DB 마이그레이션**: 스키마 리비전이 하나뿐인 시점에서 Alembic을 도입하는 것은 과설계라 판단해
  `create_all()`로 시작한다. 첫 스키마 변경 시 도입할 것.
- **T3(신경망) 검사**: 계획서 §2.3에 따라 v1 범위에서 제외(브라우저 CPU/지연 제약) — 로컬 에이전트
  위임 또는 Pyodide 경로는 v2 검토 대상으로 남겨둠.
- **어댑터 사이트 수**: ChatGPT/Claude/Gemini 3종만 우선 구현(계획서 로드맵 S2는 2개 사이트,
  S6에서 6개로 확대 예정) — Copilot/Perplexity/DeepSeek 등은 `extension/src/adapters/*.json`과
  동일한 스키마로 데이터만 추가하면 된다(코드 변경 불필요, §3.1 "원격 갱신 가능" 설계 그대로).
- **Fleet 웹훅 인증**: Fleet이 커스텀 헤더를 지원하지 않아 리버스 프록시 또는 쿼리 파라미터 경유가
  필요함 — 운영 배포 전 확정 필요([`fleet/README.md`](fleet/README.md) 참조).
- **파일 업로드 통제 — 컨텐츠 스캔 우선, MIP는 옵션(2026-07-02 결정)**: 계획서 §2.2/§4.2는 MIP
  라벨을 1차 게이트로 설계했으나, 실제 운영 시 조직 전체의 MIP 라벨링 도입이 선행돼야 하는 제약이
  커서 v1 기본값을 바꿨다. `extension/src/content-scan/`이 업로드 파일 전체를 텍스트로 추출해
  프롬프트와 동일한 T1 엔진으로 검사하고, **등급 O만 통과**시킨다(`policy.fileCheck.contentScan`,
  기본 `true`). MIP 라벨 검사(`extension/src/mip/`)는 그대로 남아있지만
  `policy.fileCheck.mipCheck`(기본 `false`)로 켜야 동작하는 **보조 레이어**가 됐다 — 둘 다 켜면
  두 판정 중 더 엄격한 쪽(차단 > 확인 > 통과)을 따른다. PDF/HWP/암호화 문서 등 브라우저에서 텍스트
  추출이 안 되는 형식은 fail-closed로 차단된다(§2.1의 fail-closed 원칙과 동일).
- **T1 판정 규칙 — 회사 표준 `data_classifier.py`(Presidio+spaCy+신경망 통합본, 루트 경로)와 정렬**:
  최초 구현 시 계획서 §2.3의 서술만으로 가중치/임계값을 추정했으나, 실제 표준 분류기 소스가 제공된 뒤
  키워드 등급 escalation(대외비/기밀/극비 등), 타입별 카운트 캡(반복 저위험 탐지의 선형 누적 방지),
  가중치 수치, BULK_PII_TYPES 화이트리스트, 그리고 **S_THRESHOLD가 비율이 아닌 절대 점수 컷오프**라는
  점을 `profiles/data_classifier.py`·`extension/src/engine/t1-engine.ts` 양쪽에 반영했다. NER/신경망
  티어는 여전히 브라우저 밖(§2.3) — 이 모듈은 표준 분류기의 "JS로 포팅 가능한 부분집합"만 유지한다.
- **관리 콘솔(`/admin`) 추가**: curl로만 정책을 조회/수정하는 게 실사용에 불편하다는 피드백을 받고,
  로그인 폼 + 정책 조회·수정 폼 + 대시보드 요약을 제공하는 자체완결형 HTML+JS 페이지를 추가했다
  (`server/app/templates/admin.html`, 빌드 단계·외부 CDN 의존 없음). 계획서에는 없던 산출물이며,
  `GET /policy`가 관리자 JWT도 받아들이도록(`require_admin_or_install`) 인증 경계를 하나 넓혔다 —
  관리자는 어차피 `PUT /policy`로 전체 쓰기 권한이 있으므로 읽기 허용은 새로운 노출이 아니다.
- **`docker-compose.yml` 포트/기동 순서 수정**: 개발 중인 호스트에 이미 다른 프로젝트의 컨테이너가
  호스트 8080을 점유하고 있어 `8090:8080`으로 변경했다(내부 컨테이너 포트는 그대로 8080). 또한
  `depends_on`이 기본값(`condition: service_started`)이라 Postgres가 연결을 받을 준비가 되기 전에
  서버 컨테이너가 붙어 크래시하는 경합이 있었음을 실제로 재현·확인해 Postgres/Redis에 헬스체크를
  추가하고 `condition: service_healthy`로 바꿨다.
- **확장 ↔ 서버 연동 버그 수정(2026-07-03)**: 확장과 서버를 각각 만들고 서버는 curl로만 따로
  검증하다 보니 실제 연동 지점 4곳이 안 맞았다 — ① 확장이 `POST /install/register`를 호출한 적이
  없어 유효한 인증 토큰이 없었고, ② 하트비트·이벤트 전송에 `Authorization`/`X-Install-Id` 헤더가
  빠져 있었고, ③ 이벤트를 `{events:[...]}` 배열로 한 번에 보냈는데 서버(`POST /events`)는 건당
  하나만 받도록 돼 있었고, ④ 확장이 서버의 `GET /policy`를 조회하지 않아 관리 콘솔에서 정책을 바꿔도
  확장에 전달되지 않았다(확장→서버 방향만 동작하는 반쪽 연동). 네 가지 모두 고치고
  `extension/src/policy/policy-loader.ts`에 "managed storage → 서버 정책 캐시 → 번들 기본값" 우선순위를
  추가했으며, 실제 Docker 서버에 붙여 등록→하트비트→정책조회→이벤트전송→관리자 정책수정→확장
  재조회까지 전 과정을 재현해 확인했다. 서버 시드 데이터도 확장의 기본 사이트 목록과 다르게(빈 배열)
  나가고 있어 함께 맞췄다(`server/app/core/seed.py`).
- **판정 UI 고도화 + 프롬프트 익명화(2026-07-03, `C:\Projects\UECM\fileTrench` 참조)**: 프롬프트/파일
  확인·차단 다이얼로그가 이제 등급 배지(O/S/C, 색상 구분)·검출 항목 목록(타입·건수·마스킹 샘플)·
  기여도 막대(SHAP 대신 실제 점수 기여분)·"이 결과는 감사 로그로 기록됩니다" 고지·"공개 등급이
  아니므로 확인/결재가 필요합니다" 안내를 표시한다(`extension/src/ui/dialog.ts`). 프롬프트가 S/C
  등급이면 "개인정보 마스킹 후 전송" 버튼으로 PII만 마스킹(등급 키워드는 유지)한 뒤 재분류해 O가
  되면 즉시 전송한다(`extension/src/engine/anonymize.ts`, `content/injected.ts`의
  `setPromptText()`); 서버에는 새 이벤트 타입 `prompt_anonymized_sent`로 기록된다. UECM의 fileTrench
  PWA(분류+정책+익명화 전용 도구) UI/익명화 로직을 참고했으며, 신경망 SHAP·OPA 정책엔진·문서
  재구성(CDR)·결재 워크플로처럼 이 확장에 없는 기능은 가져오지 않았다 — 자세한 대응 관계는
  [`docs/guide.md`](docs/guide.md) §2.2 참조.
- **CORS 누락 버그 수정(2026-07-03)**: 위의 확장↔서버 연동 수정을 다 적용하고도 실제 브라우저에서는
  여전히 서버로 요청이 한 건도 안 갔다. 원인은 CORS — 확장 서비스워커가 `chrome-extension://` 출처에서
  서버로 요청하는데, `Authorization`/`X-Install-Id` 헤더 때문에 브라우저가 매번 CORS 프리플라이트
  (`OPTIONS`)를 먼저 보내고, 서버에 `CORSMiddleware`가 없어 그게 `405`로 거부되면서 **진짜 요청
  자체가 브라우저 밖으로 나가지도 못했다.** 그래서 서버 로그에도 실패 흔적이 안 남아 "확장이 시도조차
  안 한 것"처럼 보였다. `server/app/main.py`에 `CORSMiddleware(allow_origins=["*"])` 추가로 해결 —
  이 API는 쿠키가 아닌 Bearer 토큰 인증이라 와일드카드 출처 허용이 안전하다(확장 출처는 설치마다
  달라 사전에 특정할 수도 없다). 회귀 테스트: `server/tests/test_cors.py`.
- **상세 감사 로그 + 사용자 식별 추가(2026-07-03)**: CORS 수정 후 실제 이벤트가 들어오기 시작했지만,
  관리 콘솔 대시보드는 "유형별/날짜별 건수" 집계뿐이라 "누가 위배했는지" 알 수 없었다. `GET /api/v1/events`
  (관리자 전용, 페이지네이션)로 개별 이벤트 전체(사용자·사이트·등급·점수·검출 항목·조치·설치 버전)를
  볼 수 있게 하고, 관리 콘솔에 "감사 로그" 탭을 추가했다. 또한 확장이 검출 항목의 `weight`/`samples`/
  `contribution`을 이미 보내고 있었는데 서버 `DetectionIn` 모델이 `type`/`count`만 선언해 나머지를
  조용히 버리고 있던 것도 함께 고쳤다. "누구"는 `chrome.identity.getProfileUserInfo`(`identity.email`
  권한, 관리형 Chrome 프로필에서만 값이 채워짐 — 개인 프로필의 사이드로드는 의도적으로 미확인 처리)로
  확장이 캡처해 모든 이벤트에 `user`로 첨부한다.
- **대시보드 차트 + 단말 OS/브라우저/계정 수집(2026-07-03)**: "전체 전송 위반율·블록·확인후전송을
  그래프로" 요청에 따라, 관리 콘솔에 Chart.js(캔버스 기반, SVG 미사용) 막대그래프 4종을 추가했다 —
  프롬프트/파일 위반율(%), 프롬프트 처리 결과(허용/확인후전송/익명화후전송/차단), 파일 처리 결과,
  단말 준수 현황(준수 설치/비준수 설치/Fleet 미설치 단말). "위반율"이 의미 있으려면 분모(전체
  검사 건수)가 필요한데 기존엔 등급 O(정상) 프롬프트/파일은 아예 로그를 안 남겼었다 — 새 이벤트
  타입 `prompt_allowed`/`file_allowed`를 추가해 정상 건도 가볍게 기록하도록 바꿨다(로그량이
  늘어나는 트레이드오프 있음, 필요시 정책 플래그로 끌 수 있게 후속 개선 가능). 단말 식별을 위해
  `Install`에 `platform`(`chrome.runtime.getPlatformInfo()`)·`user_agent`(`navigator.userAgent`)
  컬럼을 추가해 하트비트로 수집하고, Fleet 웹훅의 `NoncompliantDevice`에도 페이로드에 있으면
  `platform`을 저장한다. 관리 콘솔에 "설치 단말 목록" 표(OS/브라우저/계정/준수여부)를 추가했다.
  Chart.js는 jsdelivr CDN에서 받아 `server/app/static/`에 벤더링했다(사용자 승인 후 진행 —
  런타임에는 CDN 의존 없이 우리 서버가 직접 서빙, 에어갭 환경에서도 동작).
- **관리 콘솔 표 레이아웃 버그 수정(2026-07-03)**: 감사 로그 표에서 마스킹된 검출값(예:
  `90****-*******`)이 좁은 열 폭 때문에 괄호 중간에서 줄바꿈되며 깨져 보였다. 열마다
  `nowrap`/`wrap` 클래스를 명시하고 표를 가로 스크롤 컨테이너로 감싸 해결했다.
- **Hugging Face Spaces 데모 배포 + 확장 기본 서버 전환(2026-07-03)**: 무료 호스팅 요건에 따라
  정책 서버를 HF Spaces에 배포했다(`server/Dockerfile.hf` — Postgres 대신 SQLite, Redis는 생략;
  `server/deploy-to-hf.sh`로 배포). Docker Space는 컨테이너 하나만 띄우므로 `docker-compose.yml`
  구성을 그대로 못 쓴다는 게 핵심 제약이었다. 확장의 기본 `serverBaseUrl`
  (`default-policy.json`·`service-worker.ts`)도 이 배포 주소로 바꿔서, 압축해제된 확장을
  로드하기만 해도 바로 살아있는 서버와 통신하도록 했다 — 로컬 서버로 테스트하려면
  [`docs/testing-guide.md`](docs/testing-guide.md) §2의 오버라이드 방법을 따를 것. 배포 과정에서
  겪은 별개 이슈 셋: ① HF 앱에 루트(`/`) 페이지가 없어 HF의 기본 임베드 뷰가 404를 보여줘서
  `/`→`/admin` 리다이렉트를 추가했다, ② `hf auth login`의 Git Credential Manager 연동이
  `git push`에 토큰을 제대로 못 넘겨 매번 멈춰서(GCM이 비밀번호 인증으로 폴백 → HF가 거부),
  `deploy-to-hf.sh`가 `$HF_TOKEN` 환경변수를 직접 원격 URL에 실어 쓰도록 바꿨다, ③ Chart.js를
  받아온 것과 마찬가지로 public 저장소/Space 생성은 시스템 안전장치가 명시적 확인을 요구했다.

## 검증 상태

| 대상 | 명령 | 결과 |
|---|---|---|
| `profiles/` | `pytest -q` | 13 passed |
| `extension/` | `npx tsc --noEmit` / `npm test` / `npm run build` | clean / 71 passed / dist 생성 확인 |
| `server/` | `pytest -q` / `docker compose up` (실제 컨테이너로 등록→하트비트→정책조회→이벤트전송→관리자정책수정→재조회 전 과정 확인) | 28 passed / 정상 동작 |

## 남은 리스크 (계획서 §7 리스크 레지스터 대비 미해결 항목)

이번 구현은 코드/인프라 스캐폴딩까지이며, 다음은 조직적·법적 조치가 필요해 코드만으로 해결되지 않는다:
R1(사이트 DOM 변경 대응 — 어댑터 JSON 갱신 운영 프로세스 필요), R6(프롬프트 로깅 법적 리스크 — 사전
고지·동의 절차), R7(웹스토어 심사 — 배포 경로 결정), 강제설치 GPO 배포. 계획서 §8 체크리스트 참조.
