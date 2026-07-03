from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import app.models  # noqa: F401  registers all tables on Base before create_all
from app.api import admin_ui, auth, dashboard, events, fleet, gradeprofile, install, policy
from app.core import db, seed


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    seed.seed_admin()
    seed.seed_grade_profile()
    seed.seed_default_policy()
    yield


app = FastAPI(title="innoecm-ai-guard policy/management server", version="0.1.0", lifespan=lifespan)

# The extension's service worker calls this API cross-origin
# (chrome-extension://<id> -> http://<server>). Without this, the browser's
# CORS preflight (triggered by the Authorization/X-Install-Id headers on
# every install/policy/events call) gets a 405 on OPTIONS and the browser
# never sends the real request at all -- found 2026-07-03 by noticing the
# extension made zero real requests, only repeated failed OPTIONS preflights,
# in the server access log. Wildcard origins are safe here because auth is
# bearer-token based (not cookies), so allow_credentials must stay False --
# an extension origin can't be known in advance (it varies per install), and
# there's no ambient-credential/CSRF risk this middleware would otherwise
# need to guard against.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz", tags=["health"])
def healthz():
    return {"status": "ok"}


# Chart.js is vendored here (app/static/chart.umd.min.js, MIT license) rather
# than loaded from a CDN, so the admin console keeps working air-gapped and
# doesn't depend on a third party staying up.
app.mount("/static", StaticFiles(directory=str(Path(__file__).resolve().parent / "static")), name="static")


app.include_router(auth.router, prefix="/api/v1")
app.include_router(policy.router, prefix="/api/v1")
app.include_router(gradeprofile.router, prefix="/api/v1")
app.include_router(events.router, prefix="/api/v1")
app.include_router(install.router, prefix="/api/v1")
app.include_router(fleet.router, prefix="/api/v1")
app.include_router(dashboard.router, prefix="/api/v1")
# No /api/v1 prefix: this is a console page (its own JS calls the /api/v1/*
# endpoints with absolute paths), not part of the API surface itself.
app.include_router(admin_ui.router)
