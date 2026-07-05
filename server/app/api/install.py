import datetime as dt
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.auth import generate_install_token, hash_password, require_install
from app.core.config import settings
from app.core.db import get_session
from app.core.redis_client import incr_with_expiry
from app.models.audit_log import AuditLog
from app.models.install import Install

router = APIRouter(prefix="/install", tags=["install"])


class RegisterRequest(BaseModel):
    version: str


class RegisterResponse(BaseModel):
    installId: str
    token: str


def _client_ip(request: Request) -> str:
    # Behind HF Spaces / any reverse proxy the real client is in
    # X-Forwarded-For (first hop); fall back to the direct peer.
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@router.post("/register", response_model=RegisterResponse)
def register(
    body: RegisterRequest,
    request: Request,
    db: Session = Depends(get_session),
    x_enroll_secret: str | None = Header(default=None, alias="X-Enroll-Secret"),
):
    # P4: a fresh install still has no per-install credential (R10 bootstrap),
    # but registration is no longer wide open:
    #  1. If an org enrollment secret is configured, it must be presented here
    #     (distributed to managed installs via policy), so a random internet
    #     caller can't mint valid install tokens and forge events.
    #  2. Registrations are rate-limited per client IP as defense-in-depth.
    if settings.INSTALL_ENROLLMENT_SECRET:
        if not x_enroll_secret or x_enroll_secret != settings.INSTALL_ENROLLMENT_SECRET:
            raise HTTPException(status_code=401, detail="invalid or missing enrollment secret")

    ip = _client_ip(request)
    count = incr_with_expiry(f"install_reg:{ip}", 3600)
    if count > settings.INSTALL_REGISTER_RATE_PER_HOUR:
        raise HTTPException(status_code=429, detail="registration rate limit exceeded")

    install_id = str(uuid.uuid4())
    token = generate_install_token()
    install = Install(
        install_id=install_id,
        version=body.version,
        enabled=True,
        bearer_token_hash=hash_password(token),
    )
    db.add(install)
    # The token returned is shown exactly once; only its bcrypt hash persists.
    db.add(AuditLog(actor=install_id, action="install_register",
                    detail={"version": body.version, "ip": ip}))
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
