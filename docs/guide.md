# innoecm-ai-guard — 산출물 가이드

`innoecm-ai-guard_개발계획서.md`를 기반으로 구현한 전체 시스템의 산출물을 설명한다. 각 컴포넌트의
실행 방법은 해당 디렉터리의 README([profiles](../profiles), [extension](../extension/README.md),
[server](../server/README.md), [fleet](../fleet/README.md))를 참조하고, 이 문서는 "무엇을 왜 이렇게
만들었는지"에 집중한다. 로컬 검증 절차는 [`testing-guide.md`](testing-guide.md)로 분리했다.

## 1. 전체 그림

```
사용자 PC (Chrome, MV3 확장)
  ├─ injected.ts (MAIN world)   — 입력창/전송버튼/드래그드롭/붙여넣기/fetch 후킹
  ├─ content-script.ts (ISOLATED)— 판정 요청 중계, 확인/차단 다이얼로그, 이벤트 로깅
  ├─ engine/t1-engine.ts         — 정규식+키워드 기반 O/S/C 판정 (프롬프트 · 파일 내용 공용)
  ├─ content-scan/               — 파일 → 텍스트 추출 (기본, MIP 불필요)
  ├─ mip/                        — MIP 라벨 판독 (옵션, 기본 꺼짐)
  ├─ policy/                     — 정책 로더(managed storage → 기본값 폴백)
  └─ background/service-worker.ts— 정책 캐시, 이벤트 큐, 하트비트
        │ HTTPS
        ▼
정책/관리 서버 (FastAPI, Docker) ── 정책 배포 · 이벤트 수집 · 설치 인증 · 대시보드
        ▲
        │ webhook
Fleet(osquery) ── 확장 미설치/비활성 단말 탐지
```

프로필(`profiles/data_classifier.py`)이 T1 판정 규칙의 단일 소스이며, `export_patterns.py`가 생성한
GradeProfile JSON을 서버와 확장이 그대로 소비한다. 판정 로직을 바꿀 때는 이 파일 하나만 고치고
재생성하면 서버·확장이 함께 갱신된다.

## 2. 컴포넌트별 산출물

### 2.1 `profiles/` — T1 판정 규칙 단일 소스

| 파일 | 역할 |
|---|---|
| `data_classifier.py` | 정규식 인식기(`PATTERN_RECOGNIZERS`), 엔티티 가중치, 등급 키워드, 대량 PII 화이트리스트, 임계값. `classify(text)` 함수가 O/S/C 등급·점수·검출목록 반환 |
| `export_patterns.py` | 위 규칙을 GradeProfile JSON 번들로 직렬화 → `profiles/dist/`와 `extension/src/engine/gradeProfile.json`에 배포 |
| `tests/test_data_classifier.py` | 13개 회귀 테스트 (등급 경계값, 체크섬 검증, 키워드 escalation, 대량 PII 등) |

**이 파일은 저장소 루트의 `data_classifier.py`/`data_classifier.md`(Presidio+spaCy NER+선택적
신경망까지 포함한 회사 표준 통합 분류기)의 JS로 포팅 가능한 부분집합이다.** 정규식·가중치·키워드·
임계값은 두 파일이 수치적으로 정렬되어 있지만, NER 엔티티 인식과 신경망 tier는 브라우저에서 실행할
수 없어(계획서 §2.3, 50ms 예산·CPU 제약) 여기 포함하지 않는다. 문서/파일의 정밀 분류(직원명부 등)가
필요하면 루트의 전체 분류기를 서버 사이드에서 호출하는 것이 맞고, 이 모듈은 실시간 브라우저 판정
전용이다.

**판정 규칙 핵심 (2026-07-02 갱신)**
- 등급 키워드 escalation: "대외비"/"기밀"/"극비"/"confidential" 등 텍스트에 등급 표시어가 직접
  있으면 그 자체로 점수에 반영된다.
- 타입별 카운트 캡: C등급 트리거(가중치 ≥ 5.5)가 아닌 이상 같은 타입 반복 검출은 2건까지만
  점수에 반영된다 — 이메일 5개가 나와도 무한정 점수가 오르지 않는다.
- 대량 PII 화이트리스트: `KR_RRN`/`KR_PHONE`/`EMAIL_ADDRESS`/`KR_ACCOUNT`/`CREDIT_CARD` 같은
  "개인식별자" 타입만 10건 이상이면 등급을 C로 강제 상향한다. API 키/시크릿 같은 자격증명은 이
  집계에서 제외된다(개별 가중치가 이미 높아 중복 escalation이 불필요).
- `S_THRESHOLD`(0.75)는 `C_THRESHOLD`(5.5)에 대한 **비율이 아니라 절대 점수 컷오프**다 — 이메일
  하나(가중치 1.0)만 검출돼도 즉시 S등급이 된다. 초기 스캐폴딩 단계에서는 이를 비율로 잘못 가정했으나
  회사 표준 분류기 소스를 받은 뒤 바로잡았다.

### 2.2 `extension/` — Chrome MV3 확장

| 모듈 | 역할 |
|---|---|
| `engine/t1-engine.ts` | `profiles/data_classifier.py`와 동일한 알고리즘의 JS 이식판. `gradeProfile.json`(생성물)을 그대로 소비 |
| `content-scan/extract-text.ts` | 업로드 파일 → 텍스트 추출 (txt/csv/md/json/log 평문, docx/pptx/xlsx는 fflate로 부분 압축 해제 후 XML 텍스트 추출). PDF/HWP/암호화 문서/50MB 초과 파일은 `unsupported`로 fail-closed |
| `content-scan/content-policy.ts` | 추출 상태 + T1 등급 → allow/block/confirm 결정. **등급 O만 통과**, 추출 실패·미지원 형식은 무조건 차단 |
| `mip/mip-parser.ts`, `mip/label-policy.ts` | MIP 라벨 판독·정책 매칭 (옵션 레이어, 기본 꺼짐) |
| `engine/labels.ts` | 검출 타입 → 한국어 표시명 (다이얼로그 표시용) |
| `engine/anonymize.ts` | PII 검출 span을 마스킹해 익명화된 텍스트 생성 (등급 키워드는 PII가 아니므로 마스킹 대상에서 제외) |
| `adapters/*.json` | ChatGPT/Claude/Gemini 사이트별 셀렉터·업로드 엔드포인트 (원격 갱신 가능한 데이터, 코드 아님) |
| `policy/` | 정책 우선순위: `chrome.storage.managed`(GPO) → 서버에서 받아온 캐시(`chrome.storage.local`) → 번들된 `default-policy.json` |
| `content/injected.ts` (MAIN world) | 입력창 전송, 드래그드롭, 붙여넣기, fetch/XHR 후킹. 익명화 후 전송 시 입력창 텍스트를 마스킹된 버전으로 교체 |
| `content/content-script.ts` (ISOLATED) | 판정 요청 중계, 확인/차단 다이얼로그(Shadow DOM), 이벤트 로깅 |
| `ui/dialog.ts` | 등급 배지·검출 항목·기여도 막대·감사로그 고지·익명화 버튼을 표시하는 다이얼로그 |
| `background/service-worker.ts` | 설치 등록(`POST /install/register`)·토큰 보관, 인증 헤더 포함 하트비트·정책 조회(`GET /policy`, ETag), 이벤트 큐(오프라인 재전송) |

**판정 결과 UI (2026-07-03, `C:\Projects\UECM\fileTrench` 참조)**: 프롬프트/파일 판정 다이얼로그를
UECM의 fileTrench PWA(§02-fileTrench-spec.md, Step 3 분류 결과 화면) 패턴을 참고해 다시 만들었다.
fileTrench는 등급 배지(O/S/C, 색상 구분) + 신뢰도 게이지 + findings 목록(타입·건수·근거) + SHAP
기여도 막대 + "왜 이 등급?" 설명을 보여주는데, 이 확장에는 NER/신경망/OPA가 없으므로 그 중 이
엔진이 실제로 계산하는 것만 가져왔다:
- **등급 배지**: O(녹색)/S(주황)/C(빨강) — fileTrench의 `GRADE_COLOR` 배색을 그대로 사용
- **검출 항목 목록**: 타입(한국어 라벨)·건수·마스킹된 샘플
- **기여도 막대**: 신경망 SHAP 대신, 각 검출이 실제로 점수에 기여한 양(`weight × 캡 적용 건수`)을
  막대로 표시 — 그래디언트 기반은 아니지만 "왜 이 등급인지"를 정직하게 설명한다는 목적은 동일
- **감사 로그 고지**: 모든 확인/차단 다이얼로그에 "이 판정 결과와 조치는 감사 로그로 기록되어
  정책 관리 서버에 전송됩니다" 문구를 고정 표시
- **등급 기반 안내 문구**: "공개(O) 등급이 아니므로 담당자 확인/결재 절차가 필요합니다" — 실제
  결재 워크플로(fileTrench의 "결재 승인" 기능)까지는 구현하지 않고 안내 메시지만 표시(범위 결정)

**프롬프트 익명화 후 전송 (2026-07-03, `fileTrench/src/anonymize.ts` 참조)**: S/C 등급 프롬프트의
확인 다이얼로그에 "개인정보 마스킹 후 전송" 버튼을 추가했다. fileTrench의 span 기반 in-place 치환
방식을 그대로 따르되(엔티티 타입별 mask/suppress/pseudonymize 강도 정책은 없이 항상 mask만 적용 —
서버에서 내려주는 anonymization-rules API가 없기 때문), 등급 키워드("기밀" 등)는 PII가 아니므로
마스킹 대상에서 제외한다. 마스킹 후 재분류해 등급이 O가 되면 그 텍스트로 즉시 전송하고
`prompt_anonymized_sent` 이벤트를 남긴다 — 여전히 S/C이면(키워드가 남아있는 경우 등) 갱신된 검출
결과로 다이얼로그를 다시 보여준다. 실제 입력창 텍스트 교체는 `injected.ts`의 `setPromptText()`가
담당하며, `document.execCommand("insertText", ...)`로 contenteditable 입력에 진짜 사용자 입력처럼
보이는 `input` 이벤트를 발생시켜 ChatGPT/Claude 같은 React 기반 입력창의 내부 상태도 함께 갱신한다
(속성을 직접 대입하면 이 이벤트가 발생하지 않아 사이트가 옛 텍스트를 전송해버린다).

**확장 ↔ 서버 연동 (2026-07-03 버그 수정)**: 확장과 서버를 병렬로 만들고 서버는 curl로만 따로
검증하다 보니, 실제로는 연결이 안 맞는 부분이 세 군데 있었다 — 확장이 `POST /install/register`를
아예 호출하지 않아 유효한 토큰이 없었고, 하트비트/이벤트 전송에 인증 헤더가 빠져 있었고, 이벤트를
`{events:[...]}` 배열로 한 번에 보냈는데 서버는 건당 하나만 받게 돼 있었다. 게다가 확장이 서버의
`GET /policy`를 아예 조회하지 않아서 관리 콘솔에서 정책을 바꿔도 확장에는 전달되지 않았다(확장→서버
방향만 동작). 네 가지 모두 고치고 실제 Docker 서버에 붙여 등록→하트비트→정책조회→이벤트전송→
관리자가 정책 수정→확장이 다음 조회에서 반영까지 전 과정을 curl로 재현해 확인했다.

**파일 업로드 흐름 (2026-07-02 재설계)**: 원래 계획(§2.2)은 MIP 라벨이 "공개" 등급인 파일만
통과시키는 방식이었다. 이번 v1은 기본값을 바꿔 **업로드 파일 전체를 텍스트로 추출해 프롬프트와
동일한 T1 엔진으로 검사하고, 등급 O만 통과**시킨다(`policy.fileCheck.contentScan`, 기본값 `true`).
MIP 라벨 검사는 삭제하지 않고 `policy.fileCheck.mipCheck`(기본값 `false`)로 켤 수 있는 보조 레이어로
남겨뒀다 — 둘 다 켜면 더 엄격한 판정(차단 > 확인 > 통과)이 최종 결정된다. 이렇게 바꾼 이유는 MIP
라벨 검사가 효과를 내려면 조직 전체에 MIP 라벨링이 선행 도입돼 있어야 하는데, 컨텐츠 스캔은 그런
전제조건 없이 바로 동작하기 때문이다.

### 2.3 `server/` — 정책/관리 서버 (Docker)

FastAPI + PostgreSQL + Redis. 정책 배포(`GET/PUT /policy`), 이벤트 수집(`POST /events`), 설치
등록/하트비트(`POST /install/register`, `/heartbeat`), Fleet 웹훅(`POST /fleet/webhook`), 관리자
대시보드(`GET /dashboard`)를 제공한다. 관리자(JWT)와 설치(발급 토큰), Fleet(공유 시크릿)는 서로
다른 인증 경계를 가진다 — 계획서 §7 R10(확장 사칭·이벤트 위조) 대응. 상세 API 표는
[`server/README.md`](../server/README.md) 참조.

**관리 콘솔(`GET /admin`, 2026-07-02 추가)**: curl로 정책을 조회/수정하는 게 불편하다는 피드백에
따라, 로그인 폼 + 정책 조회·수정 폼 + 대시보드 요약을 한 화면에서 제공하는 자체완결형 HTML+JS
페이지를 추가했다. 빌드 단계나 외부 CDN 의존이 없어 에어갭 환경에서도 그대로 동작한다. 정식 목표는
여전히 InnoECM 콘솔(React) 통합이므로, 이 페이지는 그 전까지 쓰는 임시 관리 도구다.

**감사 로그 탭(2026-07-03 추가)**: 관리 콘솔의 "대시보드" 탭은 이벤트를 유형·날짜별 건수로만
집계해서 "누가 위배했는지"를 알 수 없었다. `GET /api/v1/events`(관리자 전용, 페이지네이션)로 개별
이벤트 전체를 조회할 수 있게 하고, 관리 콘솔에 "감사 로그" 탭을 추가해 시각·사용자·사이트·유형·
등급·점수·검출 항목(타입·건수·마스킹 샘플)·조치·설치(버전)를 표 형태로 보여준다. "사용자"는 확장이
`chrome.identity.getProfileUserInfo`로 캡처한 Chrome 프로필 이메일이며, 관리형(엔터프라이즈)
프로필에서만 값이 채워진다 — 개인 프로필에 사이드로드된 경우 개인정보 보호를 위해 의도적으로
비워둔다(`user: null`, 설치 ID로는 여전히 추적 가능).

**대시보드 차트 + 단말 목록(2026-07-03 추가)**: "대시보드" 탭에 Chart.js(캔버스, SVG 미사용) 막대
그래프 4종 — 프롬프트/파일 위반율(%), 프롬프트 처리 결과(허용/확인후전송/익명화후전송/차단), 파일
처리 결과, 단말 준수 현황 — 과 "설치 단말 목록" 표(OS·브라우저·계정·버전·최근 하트비트·준수여부)를
추가했다. 위반율 계산에는 전체 검사 건수(분모)가 필요한데, 기존엔 등급 O(정상) 건은 로그를 아예
안 남겨서 분모가 없었다 — `prompt_allowed`/`file_allowed` 이벤트 타입을 추가해 정상 건도 가볍게
기록하도록 바꿨다(로그량 증가 트레이드오프 있음). 단말 OS/브라우저는 확장이 하트비트에
`chrome.runtime.getPlatformInfo()`/`navigator.userAgent`를 실어 보내 `Install` 테이블에 저장한다.
Chart.js는 jsdelivr에서 받아 `server/app/static/`에 벤더링해 런타임엔 CDN 의존이 없다.

### 2.4 `fleet/` — osquery/Fleet 연동

확장 미설치·비활성 단말을 15분 주기로 탐지해 정책 서버에 웹훅으로 통보하는 Fleet policy 설정.
[`fleet/README.md`](../fleet/README.md)에 적용 방법과 웹훅 인증의 알려진 제약(커스텀 헤더 미지원)을
정리했다.

## 3. 계획서 대비 의도적 차이 요약

| 항목 | 계획서 원안 | 실제 구현 | 이유 |
|---|---|---|---|
| 파일 업로드 1차 게이트 | MIP 라벨(§2.2) | 파일 전체 텍스트 T1 스캔, O만 통과 | MIP 라벨링 조직 전체 도입이 선행되지 않아도 즉시 동작 (2026-07-02 결정) |
| MIP 라벨 검사 | 필수 | 옵션(`fileCheck.mipCheck`, 기본 꺼짐) | 위와 동일 — 기존 로직은 보조 레이어로 보존 |
| S_THRESHOLD 의미 | 명시 없음(초기엔 비율로 추정) | 절대 점수 컷오프 | 회사 표준 `data_classifier.py` 소스 확인 후 정정 |
| 대시보드 | React, 기존 InnoECM 콘솔 통합(§3.1) | v1은 서버 렌더링 HTML 요약 + 정책 조회/수정용 자체완결형 관리 콘솔(`/admin`) | 콘솔 통합이 목표이므로 독립 SPA는 과설계, 다만 curl만으로 정책을 운영하기엔 불편해 최소 관리 UI는 추가 |
| NER/신경망 tier | — | 브라우저 미탑재 | §2.3의 50ms/CPU 제약, 표준 분류기 전체는 서버 전용으로 남김 |
| DB 마이그레이션 | — | Alembic 대신 `create_all()` | 스키마 리비전 1개 시점에 과설계 |
| 어댑터 사이트 수 | 로드맵상 순차 확대 | ChatGPT/Claude/Gemini 3종 우선 | S2~S6 로드맵과 동일한 순서, 나머지는 JSON 추가만으로 확장 가능 |

## 4. 알려진 제한사항

- **PDF/HWP/암호화 문서는 컨텐츠 스캔 미지원** — 브라우저에서 텍스트 레이어를 안전하게 추출할
  방법이 없어 fail-closed(차단)된다. 이런 형식을 자주 다루는 조직은 서버 사이드 확장(예: 루트의
  전체 `data_classifier.py`를 호출하는 별도 처리 경로)이 필요하다.
- **MIP 라벨 검사는 기본 꺼짐** — 이미 MIP 라벨링을 도입한 조직은 `policy.fileCheck.mipCheck`를
  `true`로 켜야 그 경로가 동작한다.
- **Fleet 웹훅은 커스텀 인증 헤더를 지원하지 않음** — 리버스 프록시 또는 쿼리 파라미터 경유가
  필요하다([`fleet/README.md`](../fleet/README.md)).
- 그 외 리스크(사이트 DOM 변경 대응 운영 프로세스, 프롬프트 로깅 법적 검토, 웹스토어 심사 등)는
  코드로 해결되지 않는 조직적 조치이며 계획서 §7/§8에 정리돼 있다.
