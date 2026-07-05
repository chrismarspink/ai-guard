# 관리 서버(정책 콘솔) 수정 → Hugging Face 재배포 가이드

정책/관리 콘솔 서버(`server/`)를 수정한 뒤 Hugging Face Space에 다시 올리는 절차.
현재 배포 대상 Space: **`chrismarspink/ai-guard-console`**
(공개 URL: https://chrismarspink-ai-guard-console.hf.space)

---

## 0. 사전 준비 (최초 1회)

- **HF Write 토큰**: https://huggingface.co/settings/tokens 에서 `Write` 스코프 토큰 발급
- git 설치 (별도 `hf` CLI 는 필요 없음 — 배포 스크립트가 git push 로 처리)
- Space 가 없다면: huggingface.co → New Space → **SDK: Docker** 로 먼저 생성

> ⚠️ 토큰은 절대 커밋하지 말 것. 셸 환경변수로만 사용한다.

---

## 1. 코드 수정

`server/app/` 아래 코드를 수정한다. 예:
- API 추가/변경: `server/app/api/*.py`
- 데이터 모델 변경: `server/app/models/*.py`
- 설정 추가: `server/app/core/config.py`
- 대시보드 화면: `server/app/templates/dashboard.html`

---

## 2. 로컬 검증 (배포 전 필수)

```bash
cd server
python3.12 -m venv .venv && source .venv/bin/activate   # 최초 1회
pip install -r requirements.txt
pytest -q          # 전체 테스트 통과 확인
```

(선택) HF 와 동일한 단일 컨테이너(SQLite, Redis 없음)로 빌드 확인:

```bash
docker build -f Dockerfile.hf -t ai-guard-console:test .
docker run --rm -p 8090:8000 -e SEED_ADMIN_EMAIL=a@b.c -e SEED_ADMIN_PASSWORD=pw ai-guard-console:test
curl localhost:8090/healthz
```

---

## 3. Hugging Face 재배포 (한 줄)

```bash
cd server
HF_TOKEN=hf_xxxxxxxx ./deploy-to-hf.sh chrismarspink/ai-guard-console
```

스크립트가 하는 일:
1. `app/` + `requirements.txt` + `Dockerfile.hf`(→ `Dockerfile`) + `hf-space-readme.md`(→ `README.md`) 를 임시 디렉터리에 모음
2. 그 디렉터리를 Space git 저장소에 **force-push** (Space 는 항상 "지금의 `server/`" 상태를 그대로 반영 — 자체 커밋 히스토리를 쌓지 않음)
3. 푸시 즉시 HF 가 Docker 이미지를 자동 재빌드 (수 분 소요)

> 토큰이 출력 로그에 찍히지 않게 하려면:
> `HF_TOKEN=hf_xxx ./deploy-to-hf.sh <space> 2>&1 | sed -E 's/hf_[A-Za-z0-9]+/hf_***/g'`

---

## 4. 배포 확인

```bash
# 헬스 (재빌드 완료까지 몇 번 재시도)
curl https://chrismarspink-ai-guard-console.hf.space/healthz

# 새로 추가/변경한 라우트가 반영됐는지 openapi 로 확인 (예: /api/v1/audit)
curl -s https://chrismarspink-ai-guard-console.hf.space/openapi.json | grep -c '/api/v1/audit'
```

`healthz` 가 200 이고, 새 엔드포인트가 openapi 에 보이면 신규 코드가 라이브다.

---

## 5. Space 환경변수(Secrets) — Settings → Repository secrets

| 변수 | 용도 | 권장 |
|---|---|---|
| `JWT_SECRET` | 관리자 JWT 서명키 | **반드시 강한 값** |
| `FLEET_WEBHOOK_SECRET` | Fleet 웹훅 공유 시크릿 | 강한 값 |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | 초기 관리자 계정 | 배포 후 변경 권장 |
| `ENV` | `production` 설정 시 기본 시크릿이면 **기동 거부**(P3) | 시크릿 설정 후에만 `production` |
| `INSTALL_ENROLLMENT_SECRET` | 설정 시 익스텐션 등록에 `X-Enroll-Secret` 필수(P4) | 조직 배포 시 설정 |
| `ALERT_WEBHOOK_URL` | 차단/기밀 이벤트 시 Slack·SIEM 웹훅 알림(P10) | 선택 |
| `EVENT_RETENTION_DAYS` | 이벤트 보존일(0=무제한)(P7) | 선택 |

> **주의**: 시크릿을 설정하지 않은 채 `ENV=production` 을 주면 부팅이 실패한다(P3 의도된 동작). 시크릿 먼저 설정 → 그다음 `ENV=production`.

---

## 6. 데이터베이스 / 마이그레이션

- **HF 무료 티어는 SQLite + 비영속 디스크** → 재빌드/재시작/슬립 시 데이터 초기화.
  스키마 변경(예: 컬럼 추가)은 `init_db()`(create_all)가 재생성하므로 별도 조치 불필요.
- **영구 Postgres 로 운영**하는 경우엔 데이터 손실 없이 스키마를 바꿔야 하므로 Alembic 사용:
  ```bash
  cd server
  DATABASE_URL=postgresql+psycopg2://... alembic upgrade head
  ```
  모델을 바꾼 뒤 새 마이그레이션 생성:
  ```bash
  DATABASE_URL=sqlite:///./_tmp.db alembic revision --autogenerate -m "설명"
  # 생성된 migrations/versions/*.py 검토 후 커밋
  ```

---

## 7. 롤백

Space 는 force-push 이력만 갖는다. 이전 상태로 되돌리려면 그 시점의 `server/`(git)로 체크아웃한 뒤 다시 3번을 실행하면 된다.

---

## 참고: 두 개의 서버

이 콘솔 서버는 **정책/대시보드/이벤트** 담당이다. **파일 내용 mDeBERTa 분석**은 별도
`classifier-svc`(UECM, 기본 `http://localhost:10030`)가 담당한다 — 그쪽 배포/기동은
`UECM/classifier-svc` 및 `UECM/docker-compose.yml` 참고.
