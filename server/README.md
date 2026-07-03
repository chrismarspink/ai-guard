# innoecm-ai-guard — 정책/관리 서버 (server/)

Policy distribution + event-collection backend for the innoecm-ai-guard Chrome
extension, plus Fleet/osquery install-compliance ingestion. See
`../innoecm-ai-guard_개발계획서.md` for the full product spec (Korean); this
README covers only how to run and use this service.

## Run it (Docker — required)

```bash
cp .env.example .env   # edit JWT_SECRET / FLEET_WEBHOOK_SECRET / SEED_ADMIN_* before real use
docker compose up --build
```

The API is then at `http://localhost:8090/api/v1/...`, health check at
`GET /healthz`. Postgres and Redis run as their own compose services; data
persists in the `ai_guard_pgdata` named volume. `docker-compose.yml` maps
host `8090` to the container's internal `8080` — deliberately not `8080:8080`,
since some hosts already have an unrelated service bound to host port 8080
(you'll get a `502`/connection-refused from *that* service, not ours, if you
try `8080` here). If `8090` is also taken on your machine, change the first
number in that port mapping and update `serverBaseUrl` in
`extension/src/policy/default-policy.json` to match.

### Admin console

`http://localhost:8090/admin` — a self-contained HTML+JS page (no build step,
no external CDN dependency, so it also works air-gapped) with a login form,
a policy viewer/editor (PUT `/policy`), and the dashboard summary. It's the
practical alternative to hand-writing `curl`/Bearer-token calls for day-to-day
policy changes; `curl` is still documented in
[`../docs/testing-guide.md`](../docs/testing-guide.md) since that's what CI/
scripts should use. The page itself loads without auth (it has no data of its
own) — logging in via the form is what obtains the admin JWT its JS then
attaches to every API call, stored only in `sessionStorage` (cleared when the
tab closes).

### Dev admin seed (read this before deploying anywhere real)

If `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` are both set at startup and no
`AdminUser` row exists yet, one is created with those credentials. This exists
purely so a fresh dev environment has a way to call `POST /auth/login` at all.
**Do not set these in a shared or production environment** — leave them blank
(the default) so no account is created, or rotate/delete the seeded account
immediately after first login if you did set them.

## Run it without Docker (for local iteration / tests)

```bash
python -m venv .venv && .venv/Scripts/activate   # or source .venv/bin/activate on macOS/Linux
pip install -r requirements.txt
pytest -q
DATABASE_URL=sqlite:///./dev.db uvicorn app.main:app --reload --port 8090
```

## Data model / migrations

Tables are created with SQLAlchemy `create_all()` at startup — there is no
Alembic migration system in this v1. That's a deliberate scope cut: this
codebase has one schema revision so far, and hand-rolling migration tooling
now would be pure speculation about future schema changes. Add Alembic when
the first real schema change is needed.

**Important consequence**: `create_all()` only creates *missing tables*, not
missing *columns* on tables that already exist. If you pull a change that
adds a column (e.g. `fileCheck` was added to `policies` on 2026-07-02) and
your Postgres container already has an old volume, the app will crash on
startup with `UndefinedColumn`. Fix: `docker compose down -v` (drops the dev
volume, `-v` is safe here since it's throwaway dev data) then
`docker compose up --build` again.

**A second flavor of the same gap, found the hard way**: `Enum(EventType,
native_enum=False)` (see `app/models/guard_event.py`) stores as a `VARCHAR`
sized to the *longest enum member at table-creation time* — adding a longer
member later (e.g. `prompt_anonymized_sent`, added 2026-07-03) doesn't widen
an already-existing column, so inserts fail with
`StringDataRightTruncation`. Same fix (`docker compose down -v`). Worse: this
is **invisible to `pytest`**, because the test suite runs against an
in-memory SQLite engine that doesn't enforce `VARCHAR(N)` length limits at
all — a test can pass while the real Postgres-backed deployment 500s on the
exact same insert. If you add or rename an enum member, verify against a
real `docker compose up` Postgres, not just `pytest`, before calling it done.

## CORS (bug found and fixed 2026-07-03)

The extension's service worker calls this API cross-origin
(`chrome-extension://<id>` → `http://<server>`). The `Authorization`/
`X-Install-Id` headers on every install/policy/events call force the browser
to send a CORS preflight (`OPTIONS`) before the real request. Without
`CORSMiddleware` (see `app/main.py`), that preflight got a bare `405` and the
browser never sent the real request at all — **silently**, with nothing in
the server access log except the failed `OPTIONS` line, so it looked
exactly like "the extension never tried" rather than "the extension tried
and got blocked." `allow_origins=["*"]` is intentional and safe here: this
API's auth is bearer-token based, not cookies, so there's no ambient-credential
CSRF risk for CORS to guard against, and an extension's origin can't be
allowlisted in advance anyway (it varies per install/user). Regression test:
`tests/test_cors.py`.

## Auth model (two separate trust boundaries)

- **Admin** (`/auth/login` → JWT bearer): humans managing policy/dashboards.
  Short-lived JWT (`JWT_EXPIRE_MINUTES`, default 8h), `HS256` signed with
  `JWT_SECRET`.
- **Install** (`/install/register` → per-install bearer token): the Chrome
  extension. Registration is unauthenticated by necessity (a fresh install has
  no credential yet) but returns the token exactly once; only its bcrypt hash
  is stored. Every subsequent install call must send both
  `Authorization: Bearer <token>` and `X-Install-Id: <installId>`, and the
  server always uses the *authenticated* install_id for writes — it never
  trusts an `installId` field inside a request body. This is the direct
  mitigation for risk R10 in the plan doc (extension impersonation / event
  forgery): a leaked/guessed install_id alone, or a token alone, is not
  enough to act as another install.
- **Fleet webhook** (`X-Fleet-Webhook-Secret` shared secret): Fleet is a
  machine caller with no user identity, so it gets its own boundary rather
  than reusing admin JWT or install tokens.

`GET /policy` is the one endpoint both trust boundaries read: `require_admin_or_install`
accepts either an admin JWT (no `X-Install-Id` header) or an install bearer +
`X-Install-Id` pair. Admins reading policy isn't a new exposure — they already
have full write access via `PUT /policy` — this just lets the `/admin` console
reuse the same endpoint instead of needing its own read path.

## API summary

| Method | Path | Auth |
|---|---|---|
| POST | `/api/v1/auth/login` | none (issues admin JWT) |
| GET | `/api/v1/policy` | admin JWT **or** install bearer |
| PUT | `/api/v1/policy` | admin JWT |
| GET | `/api/v1/gradeprofile/{name}` | install bearer |
| POST | `/api/v1/gradeprofile/{name}` | admin JWT (upsert a bundle) |
| POST | `/api/v1/events` | install bearer |
| GET | `/api/v1/events` | admin JWT (paginated, `limit`/`offset`, max 500/page) |
| POST | `/api/v1/install/register` | none (bootstrap) |
| POST | `/api/v1/install/heartbeat` | install bearer |
| POST | `/api/v1/fleet/webhook` | `X-Fleet-Webhook-Secret` |
| GET | `/api/v1/fleet/noncompliant` | admin JWT |
| GET | `/api/v1/dashboard/summary` | admin JWT (JSON) |
| GET | `/api/v1/dashboard` | admin JWT (server-rendered HTML) |
| GET | `/admin` | none (shell page; its JS calls the above with a JWT it obtains via login) |
| GET | `/healthz` | none |

`GET /policy` supports `ETag`/`If-None-Match` on `policyVersion` (304 when
unchanged) and is cached in Redis (`policy:current`, invalidated on every
`PUT /policy`). Redis is a pure cache here — if it's unreachable, reads/writes
silently fall back to Postgres instead of failing (see
`app/core/redis_client.py`); this is a real cache, not a pub/sub system, since
that's all this v1 scope calls for.

`POST /events` and `PUT /policy` bodies follow the plan doc's §3.2/§3.3 JSON
shapes exactly (camelCase field names like `policyVersion`, `mipLabelMap`,
`installId`), plus one addition not in the original plan doc: `fileCheck:
{contentScan, mipCheck}`, added 2026-07-02 alongside the extension's
content-scan-primary file check (see the root README's "구현 범위" section).
Policy rows created before this field existed fall back to
`{contentScan: true, mipCheck: false}` when read.

## Dashboard

`GET /api/v1/dashboard` is a server-rendered Jinja2 HTML page (protected by
the same admin JWT as everything else — pass it as a bearer token). This is
intentionally the whole v1 dashboard: per the plan doc, the real target is
integrating a summary module into the existing InnoECM React console, not a
standalone SPA, so building one here would be scope creep.

### Detailed audit log (added 2026-07-03)

`GET /api/v1/dashboard/summary`'s `eventsByTypeDay` is aggregate counts —
useful for a trend chart, useless for "who actually sent this and what did
we detect." `GET /api/v1/events` is the row-level view behind it: every
field a `POST /events` call carried, including per-detection `weight`/
`samples`/`contribution` (previously accepted by the extension but silently
dropped server-side since `DetectionIn` only declared `type`/`count` — now
captured). The `/admin` console's "감사 로그" tab renders this as a table.

"Who" depends on the extension having sent a `user` field, which requires
the `identity.email` permission (see `extension/README.md`) and only
resolves to a non-empty value on a Chrome-managed (enterprise) profile —
events from unmanaged/personal profiles, or from extension builds older
than 2026-07-03, show `user: null`.

### Violation-rate charts + device telemetry (added 2026-07-03)

`dashboard_summary()` now also returns:
- `violationStats.{prompt,file}`: `total`/`violations`/`violationRatePct`/`blocked`/`confirmSent`
  (+ `anonymizedSent` for prompts) over the last 30 days. "Violation" means
  `grade != "O"`, independent of what the policy's mode actually did about it
  (an audit-mode pass-through of a C-grade prompt still counts). This needed
  a real denominator, which didn't exist before: grade-O checks were never
  logged at all. Two new `EventType` members, `prompt_allowed`/`file_allowed`,
  are logged by the extension for every genuine clean pass now — a real
  trade-off (log volume scales with total usage, not just violations), not
  something to walk back silently if it turns out to be too noisy.
- `installs`: every `Install` row's `platform`/`userAgent`/`user`/`version`/
  `lastHeartbeatAt`/`compliant`, populated from the extension's heartbeat
  body (`chrome.runtime.getPlatformInfo()`/`navigator.userAgent`/profile
  email) — "which device is non-compliant" now has an actual OS/browser/
  account answer for installed extensions, not just an opaque UUID.
  `NoncompliantDevice.platform` is the same idea for Fleet-detected
  (not-installed) devices, populated best-effort from whatever the webhook
  payload happens to include (there's no extension there to ask).

The `/admin` console's "대시보드" tab renders `violationStats` as four
Chart.js bar charts (violation rate, prompt/file processing outcomes, device
compliance) plus a device list table. Chart.js is vendored at
`app/static/chart.umd.min.js` (downloaded once from jsdelivr, MIT-licensed)
and served by this app's own `StaticFiles` mount rather than loaded from a
CDN at runtime, so the console keeps working air-gapped.

## Grade profile seeding

On startup, the `n2sf-v1` grade-profile bundle is loaded from
`../profiles/dist/n2sf-v1.gradeprofile.json` (repo root) if present. If this
server is deployed/copied without the rest of the monorepo, it falls back to
the bundled copy at `app/data/gradeprofiles/n2sf-v1.json` (see
`app/core/seed.py`), so `GET /gradeprofile/n2sf-v1` still works standalone.

## Deploying a demo to Hugging Face Spaces (free hosting)

HF Spaces' "Docker SDK" runs exactly one container, so `docker-compose.yml`
(server + Postgres + Redis) doesn't apply directly. `Dockerfile.hf` is a
single-container variant for this: SQLite instead of Postgres, and Redis
simply left unconfigured (`app/core/redis_client.py` already soft-fails to
"no cache" when Redis is unreachable — see the CORS section above for the
same "cache, not source of truth" reasoning). Verified locally with
`docker build -f Dockerfile.hf` + `docker run` (no Postgres/Redis
containers) — health check, admin login, install register/policy fetch,
and dashboard summary all work standalone.

```bash
pip install -U huggingface_hub
hf auth login                       # paste a Write-scoped token from
                                     # https://huggingface.co/settings/tokens
./deploy-to-hf.sh <hf-username>/<space-name>
```

The script assembles `app/` + `requirements.txt` + `Dockerfile.hf` (renamed
to `Dockerfile`) + `hf-space-readme.md` (renamed to `README.md`, carries the
YAML frontmatter HF's Docker SDK requires) into a throwaway temp directory
and force-pushes it as that Space's entire git history — deliberate, since
the Space is meant to always reflect "whatever `server/` looks like right
now," not accumulate its own commit history. Create the Space itself first
(hf.co → New Space → SDK: Docker) before running this.

Set `JWT_SECRET`/`FLEET_WEBHOOK_SECRET`/`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`
under the Space's Settings → Repository secrets — never commit real values
for these. Free-tier limitations: sleeps after inactivity (cold start on the
next visit), and no persistent disk by default (SQLite data resets on
rebuild/restart/sleep unless the Space's Persistent Storage add-on is
enabled) — fine for a demo, not for anything you need to keep.

## Environment variables

| Var | Purpose |
|---|---|
| `DATABASE_URL` | SQLAlchemy URL (Postgres in Docker; tests override to in-memory SQLite) |
| `REDIS_URL` | policy-cache backend |
| `JWT_SECRET` | admin JWT signing key |
| `FLEET_WEBHOOK_SECRET` | shared secret Fleet must send as `X-Fleet-Webhook-Secret` |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | dev-only bootstrap admin (see above) |

## Tests

```bash
pip install -r requirements.txt
pytest -q
```

Tests override the DB to an isolated in-memory SQLite engine per test (see
`tests/conftest.py`) and don't require Postgres, Redis, or Docker to be
running.
