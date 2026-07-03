---
title: ai-guard-console
emoji: 🛡️
colorFrom: blue
colorTo: gray
sdk: docker
app_port: 8080
pinned: false
---

# innoecm-ai-guard — policy/management console (demo)

Docker Space running the FastAPI policy/management server from
[chrismarspink/ai-guard](https://github.com/chrismarspink/ai-guard) (`server/`),
adapted for single-container hosting: SQLite instead of Postgres, no Redis
(the app already soft-fails to "no cache" when Redis is unreachable).

- Admin console: `/admin`
- Health check: `/healthz`

**Demo limitations**: free-tier Spaces sleep after inactivity (cold start on
next visit) and have no persistent disk by default, so the SQLite database
resets on rebuild/restart/sleep unless this Space has Persistent Storage
enabled. Not intended for production traffic.

Set `JWT_SECRET`, `FLEET_WEBHOOK_SECRET`, and optionally `SEED_ADMIN_EMAIL`/
`SEED_ADMIN_PASSWORD` under this Space's Settings → Repository secrets before
relying on it for anything beyond a quick look.
