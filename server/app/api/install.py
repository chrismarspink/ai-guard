import datetime as dt
import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.auth import generate_install_token, hash_password, require_install
from app.core.db import get_session
from app.models.install import Install

router = APIRouter(prefix="/install", tags=["install"])


class RegisterRequest(BaseModel):
    version: str


class RegisterResponse(BaseModel):
    installId: str
    token: str


@router.post("/register", response_model=RegisterResponse)
def register(body: RegisterRequest, db: Session = Depends(get_session)):
    # No auth here by design (R10 bootstrap problem): a fresh install has no
    # credential yet. The token returned is shown exactly once and only its
    # bcrypt hash is persisted, same treatment as an admin password.
    install_id = str(uuid.uuid4())
    token = generate_install_token()
    install = Install(
        install_id=install_id,
        version=body.version,
        enabled=True,
        bearer_token_hash=hash_password(token),
    )
    db.add(install)
    db.commit()
    return RegisterResponse(installId=install_id, token=token)


class HeartbeatRequest(BaseModel):
    version: str
    enabled: bool
    # Optional device context (chrome.runtime.getPlatformInfo()/navigator.userAgent/
    # the signed-in Chrome profile email) -- added 2026-07-03 so "which device
    # is non-compliant" can show OS/browser/account, not just an install UUID.
    # All optional: older extension builds won't send these.
    platform: str | None = None
    userAgent: str | None = None
    user: str | None = None


@router.post("/heartbeat")
def heartbeat(
    body: HeartbeatRequest,
    db: Session = Depends(get_session),
    install: Install = Depends(require_install),
):
    install.version = body.version
    install.enabled = body.enabled
    install.last_heartbeat_at = dt.datetime.now(dt.timezone.utc)
    if body.platform:
        install.platform = body.platform
    if body.userAgent:
        install.user_agent = body.userAgent
    if body.user:
        install.user_upn = body.user
    db.add(install)
    db.commit()
    return {"status": "ok"}
