# innoecm-ai-guard — 개발 계획서 (Claude Code 전달용)

> 생성형 AI(LLM) 웹사이트에 대한 **프롬프트 DLP 검사** + **파일 업로드 통제(MIP 라벨 기반)** 를 수행하는
> Chrome 확장(MV3)과, 확장 **설치·활성화 검증(osquery)** 및 **정책/관리 서버**를 포함한 전체 시스템 개발 계획.
> InnoECM 제품군과 통합을 전제로 하며, N²SF 등급 체계(`data_classifier.py`) 및 GradeProfile 정책 모델과 연동한다.

---

## 1. 목표 및 범위

| # | 목표 | 성공 기준 |
|---|---|---|
| G1 | LLM 사이트 프롬프트 전송 전 개인정보/기밀 검사 | 전송 전 T1(정규식) 검사 지연 ≤ 50ms, C등급 검출 시 차단 또는 사용자 확인 후 로그·보고 |
| G2 | 파일 업로드 통제 — MIP 라벨 O(공개)등급이 아니면 차단 | 업로드 UI 시점 차단, OOXML/PDF 라벨 판독 ≤ 300ms(10MB 기준) |
| G3 | 확장 미설치/비활성 단말 탐지·통보 | osquery 스케줄 쿼리 → Fleet → 대시보드 경고 + 사용자/관리자 통보(SLA: 탐지 후 1시간 내) |
| G4 | 정책 서버 기반 중앙 정책 배포·이벤트 수집 | 사이트 목록·모드(차단/확인/감사)·라벨 매핑을 재배포 없이 갱신 |

**비범위(Out of scope, v1)**: 타 브라우저(Firefox/Safari) 네이티브 지원, 모바일, 네트워크 프록시(ICAP)형 DLP(→ InnoECM DLP 본체 담당), OCR/이미지 검사.

---

## 2. 핵심 기술 결정 (사전 확정 사항)

### 2.1 파일 통제 시점 — **업로드(UI) 시점 차단을 선택** ★

| 비교 항목 | A. 업로드 UI 시점 차단 (선택) | B. 네트워크 전송 차단 |
|---|---|---|
| MV3 실현 가능성 | ◎ File API로 파일 바이트 직접 접근 | △ `declarativeNetRequest`는 **요청 본문 검사 불가**. blocking `webRequest`는 **정책 강제설치 확장에서만** 허용 |
| 본문(파일) 접근 | ◎ Blob 전체 판독 가능 → ZIP 해제·라벨 파싱 | △ multipart 원시 바이트 재조립 필요, fetch 스트리밍 업로드는 유실 가능 |
| 지연/UX | ◎ 전송 전 즉시 피드백(다이얼로그) | △ 요청 실패로만 보여 UX 나쁨 |
| 우회 내성 | △ DOM 변경·페이지 스크립트 우회 가능 | ○ UI를 우회해도 네트워크에서 잡힘 |
| 결론 | **1차 방어(주 통제)** | **2차 안전망**: 강제설치 환경 한정, LLM 업로드 엔드포인트 URL 패턴 차단(본문 검사 없이 URL+헤더 기준) |

인터셉트 지점(모두 MAIN world 주입 스크립트로 후킹):
1. `<input type="file">` — `change` 이벤트 캡처 단계 가로채기 + `HTMLInputElement.prototype.files` 감시
2. Drag&Drop — `drop` 이벤트 캡처, `DataTransfer.files`
3. 클립보드 붙여넣기 — `paste` 이벤트, `clipboardData.files`
4. `fetch` / `XMLHttpRequest.send` 몽키패치 — `FormData`/`Blob` 본문 검사(최후 방어선, 페이지 CSP 영향 없음: 확장 주입은 CSP 미적용)

판정 실패(파싱 오류·초과 크기·암호화 파일) 시 **fail-closed(차단)** 기본. 정책으로 fail-open 전환 가능하되 감사 로그 필수 — 기존 `preflight_neural()` fail-closed 원칙과 동일한 설계 철학.

### 2.2 MIP(Microsoft Information Protection) 라벨 판독

| 파일 유형 | 라벨 위치 | 판독 방법(브라우저 내) |
|---|---|---|
| OOXML(docx/xlsx/pptx) | `docProps/custom.xml`의 `MSIP_Label_{GUID}_Enabled/_Name/_SiteId` 속성, 또는 신형 `docMetadata/LabelInfo.xml`(`clbl:label` 요소) | fflate(경량 unzip, WASM 불필요)로 해당 엔트리만 부분 해제 → XML 파싱 |
| PDF | XMP 메타데이터 `msip_labels` | 파일 앞/뒤 512KB 스캔으로 XMP 블록 추출(전체 파싱 불필요) |
| 보호(암호화)된 문서 | OLE/CFB 래퍼 (`D0 CF 11 E0` 매직) | 매직 넘버 검사 → 라벨 판독 불가 = **비공개로 간주, 차단** |
| HWPX | MIP 미지원 | 라벨 없음 → 정책 기본값 적용(권장: 차단 + T1 텍스트 검사 안내) |
| 라벨 없는 파일 | — | 정책 선택: `block`(기본) / `confirm` / T1 텍스트 추출·검사 후 판정(txt·csv 등 평문 한정) |

**등급 매핑**: 라벨 GUID → N²SF 등급(C/S/O) 매핑 테이블을 정책 서버에서 배포. "O등급 라벨 GUID allowlist"에 있는 경우에만 통과. 라벨명 문자열 매칭은 보조 수단(테넌트 간 GUID 상이 대응).

### 2.3 프롬프트 검사 엔진 — T1 정규식 재사용

- `data_classifier.py`의 `PATTERN_RECOGNIZERS`(KR_RRN, KR_PHONE, KR_ACCOUNT, AWS_ACCESS_KEY, GENERIC_API_KEY 등)를 **JSON 스키마로 추출하여 JS 엔진에 이식**. 단일 소스 유지: 파이썬 쪽에서 `export_patterns.py`로 생성 → 확장 빌드에 포함 + 정책 서버에서 핫업데이트.
- 점수식·임계값(`ENTITY_WEIGHTS`, `C_THRESHOLD=5.5`, `S_THRESHOLD=0.75`, `BULK_PII_THRESHOLD=10`)도 GradeProfile 형태로 배포 — 서버측 분류기와 **판정 일관성** 확보(회귀 픽스처로 검증).
- 신경망(T3)은 브라우저에서 수행하지 않음(CPU·지연 제약). 필요 시 옵션: 로컬 에이전트(Native Messaging Host)로 위임하거나 Presidio-in-PWA(Pyodide) 경로는 v2 검토.
- **원문 프롬프트는 서버로 전송하지 않는다.** 로그에는 검출 타입·건수·마스킹된 스니펫(예: `800101-*******`)·사이트·시각·판정만 기록. (개인정보보호법·통신비밀 리스크 최소화)

### 2.4 설치 검증 — osquery: **가능** ★

- osquery `chrome_extensions` 테이블: 브라우저 프로필 디스크 파일을 직접 읽어 `identifier`(확장 ID), `version`, `state`(활성=1), `profile_path`, `from_webstore` 등을 반환. **브라우저 미실행 상태에서도 조회 가능**, Chrome 외 Edge/Brave 등 Chromium 계열 커버.
- 탐지 쿼리 예:
  ```sql
  -- 설치·활성 여부 (사용자별)
  SELECT u.username, ce.version, ce.state
  FROM users u
  JOIN chrome_extensions ce USING (uid)
  WHERE ce.identifier = '<EXTENSION_ID>';
  ```
  Fleet **policy**로 등록: 결과 0행 또는 `state != 1` → **실패(비준수)** → webhook → 관리 서버.
- 보조 신호(교차 검증): 확장 자체의 **하트비트**(service worker가 30분 주기로 정책 서버에 `install_id, version, enabled` 보고). osquery는 "있어야 하는데 없음"을, 하트비트는 "있고 살아있음"을 증명 — 둘을 자산목록(AD/HR)과 대조해 미설치 단말을 확정.
- 예방책 병행: Chrome Enterprise `ExtensionInstallForcelist` GPO/클라우드 정책으로 **강제 설치**(사용자가 제거·비활성화 불가). osquery는 강제설치가 미적용된 예외 단말(미가입 기기, GPO 누락)을 잡는 **검증·감사 계층**으로 운용.
- 한계: osquery 에이전트 자체가 미설치된 단말은 못 봄(→ 자산관리/NAC와 대조), 크롬 다중 프로필·포터블 크롬 경로는 커스텀 경로 등록 필요, 쿼리 주기(권장 15분)만큼의 탐지 지연.

---

## 3. 전체 아키텍처

```
┌─ 사용자 PC ──────────────────────────────────────────────┐
│  Chrome (강제설치: ExtensionInstallForcelist)             │
│  ┌─ innoecm-ai-guard (MV3) ─────────────────────────┐    │
│  │ content script(ISOLATED) ── UI 다이얼로그/배지     │    │
│  │ injected script(MAIN)   ── input/drop/paste/fetch 훅│  │
│  │ service worker          ── 정책 캐시, 이벤트 큐,   │    │
│  │                            하트비트, 오프라인 재전송│    │
│  │ 검사엔진: T1 regex(JS) + MIP 파서(fflate)          │    │
│  │ chrome.storage.managed  ── 기업 정책 수신           │    │
│  └───────────────────────────────────────────────────┘    │
│  osquery agent (Fleet 관리) ── chrome_extensions 쿼리     │
└───────────┬───────────────────────────────┬──────────────┘
            │ HTTPS(mTLS 옵션)               │ TLS
┌───────────▼───────────────┐   ┌───────────▼───────────┐
│ 정책/관리 서버 (신규 개발)  │◀──│ Fleet 서버 (osquery)   │
│ · 정책 API(v1, 버저닝)     │ webhook(policy failing)   │
│ · 이벤트 수집 API          │   └───────────────────────┘
│ · 대시보드(미설치 경고,     │
│   차단/확인 이벤트 통계)    │──▶ 알림: 사용자 메일/메신저, 관리자, SIEM(syslog/CEF)
│ · 라벨 GUID↔등급 매핑 관리 │──▶ InnoECM 연동(감사 로그, GradeProfile 공유)
│ · RBAC / 감사 로그         │
└───────────────────────────┘
```

### 3.1 구성요소별 기술 스택

| 구성요소 | 기술 | 비고 |
|---|---|---|
| 확장 | TypeScript, MV3, Vite(CRXJS), fflate, (선택)WASM regex | 코드 30k LoC 미만 목표, 사이트 어댑터 플러그인 구조 |
| 사이트 어댑터 | 사이트별 셀렉터/훅 정의(JSON) | ChatGPT, Claude, Gemini, Copilot, Perplexity, DeepSeek 등. **원격 갱신 가능**(DOM 변경 대응) |
| 정책 서버 | Python FastAPI(또는 기존 InnoECM 스택), PostgreSQL, Redis | 온프레미스 배포 전제(에어갭 고객 대응), Docker Compose/K8s |
| 대시보드 | React + 기존 InnoECM 관리 콘솔에 모듈로 탑재 우선 검토 | 별도 SPA는 차선 |
| 단말 검증 | osquery + Fleet(오픈소스) | 기보유 EDR/UEM 있으면 대체 가능(선택 계층) |
| 강제 배포 | Chrome Enterprise(GPO `ExtensionInstallForcelist`, `ExtensionSettings`) / Google Admin Console | 배포 문서 별도(배포 계획 PPT 참조) |

### 3.2 정책 스키마(요지)

```jsonc
{
  "policyVersion": "2026-07-01T00:00:00Z",
  "mode": { "prompt": "confirm", "file": "block" },   // block | confirm | audit
  "sites": [ { "id": "chatgpt", "urls": ["https://chat.openai.com/*", "https://chatgpt.com/*"],
               "adapterVersion": "1.4.2" } ],
  "gradeProfile": "n2sf-v1",            // 정규식·가중치·임계값 번들 (data_classifier 파생)
  "mipLabelMap": { "allowO": ["<GUID-공개>", "<GUID-Public>"], "denyUnlabeled": true },
  "userMessage": { "blocked": "보안 정책에 따라 전송이 차단되었습니다. 보안팀에 보고됩니다.",
                    "confirm": "개인정보 의심 내용이 있습니다. 전송 시 로그가 저장되고 보안팀에 보고됩니다." },
  "heartbeatMin": 30, "logMasking": true
}
```

### 3.3 이벤트 스키마(요지)

```jsonc
{ "type": "prompt_block|prompt_confirm_sent|file_block|file_confirm|heartbeat",
  "installId": "...", "user": "AD-UPN(managed policy 주입)", "site": "chatgpt",
  "grade": "C", "score": 12.0, "detections": [{"type":"KR_RRN","count":1}],
  "file": {"name":"직원명부.xlsx","labelGuid":"...","labelName":"대외비"},
  "action": "blocked|user_confirmed|allowed", "ts": "..." }
```

---

## 4. 기능 상세

### 4.1 기능 1 — 프롬프트 검사
1. 사이트 어댑터가 입력창(contenteditable/textarea)·전송 트리거(버튼 click, Enter keydown)를 캡처 단계에서 선점.
2. 전송 직전 텍스트를 T1 엔진으로 검사(WebWorker, 50ms 예산; 초과 시 32KB 청크 슬라이딩 윈도우).
3. 판정:
   - **O** → 통과(감사 모드면 통계만).
   - **S** → 정책에 따라 `confirm`: 다이얼로그 "개인정보 의심 — 전송 시 로그 저장·보안팀 보고" → [수정] / [전송(사유 입력 선택)]. 확인 후 원 이벤트 재발화(re-dispatch)로 전송.
   - **C**(주민번호·카드·API키 등 단일 검출로 임계 도달, 대량 PII ≥ 10건) → `block`: 전송 차단 + 배지 + 이벤트 로그.
4. 스트리밍/재전송·IME(한글 조합) 이슈: `compositionend` 이후 검사, 전송 훅은 어댑터별 단위 테스트.

### 4.2 기능 2 — 파일 업로드 통제
1. §2.1의 4개 인터셉트 지점에서 File/Blob 획득.
2. 매직 넘버 → 유형 분기 → MIP 라벨 판독(§2.2). 50MB 초과 파일은 즉시 차단(정책값).
3. 라벨 O(allowlist GUID) → 통과. 그 외(라벨 C/S, 무라벨, 암호화, 판독 실패) → 차단(기본) 또는 확인.
4. 차단 시 `input.value` 초기화·`drop` preventDefault·fetch 훅에서 요청 abort — 3중 저지.
5. 이벤트 로그(파일명·라벨·판정) 서버 전송. 파일 내용은 전송하지 않음.

### 4.3 기능 3 — 설치 검증·통보 체계
1. Fleet 스케줄 쿼리(15분): §2.4 쿼리. 실패 단말 → webhook → 관리 서버.
2. 관리 서버: 자산목록과 조인 → 대시보드 "비준수 단말" 위젯(경고 레벨: 미설치 > 비활성 > 구버전).
3. 통보: 사용자(메일/사내 메신저 봇) + 관리자(일일 다이제스트 + 즉시 알림 임계). 유예기간·재알림·에스컬레이션 규칙 설정 가능.
4. 하트비트 누락(2주기) 단말도 동일 파이프라인으로 승격.

---

## 5. 개발 로드맵 (9주 안, 2인 기준)

| 단계 | 기간 | 산출물 | 게이트 |
|---|---|---|---|
| S1 킥오프·설계 확정 | 1주 | 어댑터 목록·정책 스키마·API 명세(OpenAPI) 동결 | 스코프 게이트(법무 검토 착수 포함) |
| S2 확장 코어 | 2주 | T1 엔진(JS 이식+회귀 픽스처), 프롬프트 인터셉트(2개 사이트) | 판정 일치율 100%(파이썬 대비, 샘플 500건) |
| S3 파일 통제 | 2주 | MIP 파서, 4개 인터셉트 지점, fail-closed | 라벨 판독 정확도 100%(테스트 코퍼스), 300ms/10MB |
| S4 정책 서버·대시보드 | 2주 | 정책/이벤트 API, 대시보드 v1, 알림 | E2E 데모 |
| S5 osquery/Fleet 연동 | 1주 | Fleet policy, webhook, 비준수 워크플로 | 미설치 단말 탐지 시연 |
| S6 파일럿·강화 | 1주 | 어댑터 6개 확대, 강제설치 배포 리허설, 부하·우회 테스트 | 파일럿 부서 2주 운영 승인 |

---

## 6. 시장 (요지)

- **카테고리**: GenAI DLP / Shadow AI 통제 — 브라우저 계층 신흥 시장. 글로벌: Netskope·Zscaler·Palo Alto(AI Access)·LayerX·Island(엔터프라이즈 브라우저)·Menlo. 국내: 소만사·지란지교·파수 등 기존 DLP 벤더가 GenAI 모듈 확장 중.
- **차별화 포인트**: ① N²SF 등급 체계 네이티브(공공·준공공 시장 직결) ② 완전 온프레미스·에어갭 배포(외부 클라우드 프록시 불요, 프롬프트 원문 미전송) ③ MIP 라벨 연동으로 기존 M365 라벨 투자 재활용 ④ InnoECM(ECM/DLP 로드맵)과 단일 정책(GradeProfile)·단일 감사 체계.
- **타깃**: 1차 공공기관·공기업(N²SF 의무화 흐름), 2차 금융·제조 대기업(M365+MIP 도입 조직).
- **포지셔닝 주의**: 프록시형 DLP 대비 "가볍고 빠른 최전방 계층"으로 포지셔닝. 완전 우회 차단은 브라우저 확장 단독으로 불가 → NAC/프록시와의 계층 방어 스토리 필수(과대 약속 금지).

## 7. 위험 요소 (리스크 레지스터)

| ID | 위험 | 영향 | 확률 | 대응 |
|---|---|---|---|---|
| R1 | LLM 사이트 DOM/API 수시 변경 → 훅 실패 | 高 | 高 | 어댑터를 원격 갱신 JSON으로 분리, 훅 실패 시 fail-closed(해당 사이트 입력 차단+안내) 옵션, 셀렉터 자동 헬스체크 |
| R2 | MV3 제약(본문 검사·SW 수명) | 中 | 中 | UI 시점 차단 채택(§2.1), SW keepalive는 alarms+이벤트 큐 영속화(IndexedDB) |
| R3 | 우회: 타 브라우저·시크릿·개인기기·모바일 | 高 | 中 | 강제설치+시크릿 허용 정책, osquery로 타 Chromium 감시, 브라우저 표준화 정책, 잔여 위험은 프록시/NAC 계층에 명시 이관 |
| R4 | MIP 라벨 미부착 문서 다수 → 대량 차단 민원 | 中 | 高 | 파일럿에서 무라벨 비율 실측 → `confirm` 모드로 점진 전환, 라벨링 캠페인 병행 |
| R5 | 오탐(T1 정규식) → 업무 방해·신뢰 하락 | 中 | 中 | 파이썬 보정값 그대로 이식+회귀 픽스처, 감사(audit) 모드 선행 운영, 예외 신청 워크플로 |
| R6 | 프롬프트 로깅의 법적 리스크(개인정보·통신비밀·노동관계) | 高 | 中 | 원문 미저장·마스킹 스니펫만, 사전 고지·동의(취업규칙/보안서약), 법무 검토 S1 게이트 |
| R7 | 웹스토어 심사 지연/거절(원격 코드·광범위 권한) | 中 | 中 | 어댑터는 코드가 아닌 데이터(JSON)로 갱신(원격 코드 금지 준수), 자체 호스팅 배포 경로 병행 확보 |
| R8 | 대용량 파일 파싱 성능 | 低 | 中 | 부분 해제(fflate 스트리밍), 크기 상한, WebWorker |
| R9 | osquery 에이전트 미설치 단말 사각 | 中 | 中 | 자산목록 대조, 하트비트 교차, NAC 연계 |
| R10 | 확장 ID 사칭·이벤트 위조 | 中 | 低 | 서버측 install 등록 토큰, mTLS 옵션, 이벤트 서명 |

## 8. 고려사항 (체크리스트)

- **법·컴플라이언스**: 모니터링 사전 고지문, 로그 보존기간(개인정보 처리방침 반영), 노사 협의 필요 여부, KISA 과제 산출물 요건.
- **운영**: 어댑터 갱신 SLA(사이트 개편 후 24h), 예외 처리(임원/특정 부서 정책), 헬프데스크 FAQ.
- **보안**: 확장 권한 최소화(`host_permissions`를 대상 LLM 사이트로 한정), 정책 서버 RBAC, 이벤트 무결성.
- **일관성**: GradeProfile 단일 소스 — 파이썬 분류기와 JS 엔진 판정 회귀 테스트를 CI에 상시 편성.
- **관측성**: 확장 오류 텔레메트리(사이트별 훅 성공률), 판정 분포 드리프트 모니터링.

## 9. Claude Code 작업 지시 (초기 스캐폴딩)

1. `innoecm-ai-guard/` 모노레포: `extension/`(Vite+CRXJS+TS), `server/`(FastAPI), `adapters/`(사이트 JSON), `profiles/`(GradeProfile 산출 스크립트 — `data_classifier.py`에서 `PATTERN_RECOGNIZERS`/가중치 export).
2. 우선 구현 순서: T1 JS 엔진+회귀 픽스처 → ChatGPT 어댑터(프롬프트) → MIP 파서(docx/xlsx/pptx/pdf 코퍼스 테스트) → 정책 managed storage 로더 → 이벤트 큐/하트비트 → 서버 API → 대시보드 → Fleet webhook.
3. 테스트: Playwright로 사이트 목업(HTML 픽스처) 기반 인터셉트 E2E, 파이썬↔JS 판정 diff 테스트, MIP 라벨 샘플 20종.
