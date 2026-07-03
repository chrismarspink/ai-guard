from fastapi import APIRouter, Body, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from app.core.auth import require_admin
from app.core.config import settings
from app.core.db import get_session
from app.models.noncompliant_device import NoncompliantDevice

router = APIRouter(prefix="/fleet", tags=["fleet"])


def require_fleet_secret(
    x_fleet_webhook_secret: str | None = Header(default=None, alias="X-Fleet-Webhook-Secret"),
) -> None:
    # Fleet is a machine caller, not a human admin -- a separate shared-secret
    # boundary rather than admin JWT keeps Fleet's blast radius scoped to just
    # this one endpoint if the secret leaks.
    if not x_fleet_webhook_secret or x_fleet_webhook_secret != settings.FLEET_WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="invalid fleet webhook secret")


@router.post("/webhook", status_code=201, dependencies=[Depends(require_fleet_secret)])
def fleet_webhook(body: dict = Body(...), db: Session = Depends(get_session)):
    # Fleet's webhook body shape varies by config, so only pull out what's
    # useful and keep the rest verbatim in raw_payload for later inspection.
    hostname = body.get("hostname") or body.get("host_hostname") or "unknown"
    host_users = body.get("host_users") or []
    username = host_users[0] if host_users else body.get("username")
    reason = body.get("policy_name") or body.get("reason") or "not_installed"
    # Best-effort: Fleet's own host object carries this under different keys
    # depending on version/config. There's no extension here to ask directly
    # (that's the whole point -- this device failed the "is it installed"
    # check), so if none of these are present we just leave it null.
    platform = body.get("platform") or body.get("os_version") or body.get("os")

    device = NoncompliantDevice(hostname=hostname, username=username, reason=reason, platform=platform, raw_payload=body)
    db.add(device)
    db.commit()
    db.refresh(device)
    return {"id": device.id}


@router.get("/noncompliant")
def list_noncompliant(db: Session = Depends(get_session), admin=Depends(require_admin)):
    devices = db.query(NoncompliantDevice).order_by(NoncompliantDevice.detected_at.desc()).all()
    return [
        {
            "id": d.id,
            "hostname": d.hostname,
            "username": d.username,
            "platform": d.platform,
            "reason": d.reason,
            "status": d.status.value,
            "detectedAt": d.detected_at.isoformat() if d.detected_at else None,
        }
        for d in devices
    ]
