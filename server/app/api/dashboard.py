import datetime as dt
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.auth import require_admin
from app.core.db import get_session
from app.models.guard_event import EventAction, EventType, GuardEvent
from app.models.install import Install
from app.models.noncompliant_device import DeviceStatus, NoncompliantDevice
from app.models.policy import Policy

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))

PROMPT_EVENT_TYPES = [
    EventType.prompt_allowed,
    EventType.prompt_block,
    EventType.prompt_confirm_sent,
    EventType.prompt_anonymized_sent,
]
FILE_EVENT_TYPES = [EventType.file_allowed, EventType.file_block, EventType.file_confirm]


def _violation_stats(db: Session, since: dt.datetime, category_types: list, block_type, sent_types: list) -> dict:
    # "Violation" = grade != O, regardless of what the policy's mode eventually
    # did about it (even an audit-mode pass-through of a C-grade prompt is
    # still a violation for this rate -- it just wasn't blocked). Separate
    # from blocked/confirmSent, which are about the *action taken*.
    base = db.query(GuardEvent).filter(GuardEvent.ts >= since, GuardEvent.type.in_(category_types))
    total = base.count()
    violations = base.filter(GuardEvent.grade.in_(["S", "C"])).count()
    blocked = db.query(GuardEvent).filter(
        GuardEvent.ts >= since, GuardEvent.type == block_type
    ).count()
    confirm_sent = db.query(GuardEvent).filter(
        GuardEvent.ts >= since,
        GuardEvent.type.in_(sent_types),
        GuardEvent.action == EventAction.user_confirmed,
    ).count()
    return {
        "total": total,
        "violations": violations,
        "violationRatePct": round(violations / total * 100, 1) if total else 0.0,
        "blocked": blocked,
        "confirmSent": confirm_sent,
    }


def build_summary(db: Session) -> dict:
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=30)

    rows = (
        db.query(GuardEvent.type, func.date(GuardEvent.ts), func.count(GuardEvent.id))
        .filter(GuardEvent.ts >= since)
        .group_by(GuardEvent.type, func.date(GuardEvent.ts))
        .all()
    )
    events_by_type_day = [
        {"type": event_type.value if hasattr(event_type, "value") else event_type, "date": str(day), "count": count}
        for event_type, day, count in rows
    ]

    noncompliant_devices = (
        db.query(NoncompliantDevice)
        .filter(NoncompliantDevice.status != DeviceStatus.resolved)
        .order_by(NoncompliantDevice.detected_at.desc())
        .all()
    )

    current_policy = (
        db.query(Policy).filter(Policy.is_current.is_(True)).order_by(Policy.updated_at.desc()).first()
    )
    heartbeat_min = current_policy.heartbeat_min if current_policy else 30

    installs = db.query(Install).all()
    total_installs = len(installs)
    now = dt.datetime.now(dt.timezone.utc)
    threshold = now - dt.timedelta(minutes=2 * heartbeat_min)
    compliant_installs = 0
    install_rows = []
    for install in installs:
        last = install.last_heartbeat_at
        is_compliant = False
        if last is not None:
            if last.tzinfo is None:
                last = last.replace(tzinfo=dt.timezone.utc)
            if last >= threshold and install.enabled:
                is_compliant = True
        if is_compliant:
            compliant_installs += 1
        install_rows.append(
            {
                "installId": install.install_id,
                "user": install.user_upn,
                "platform": install.platform,
                "userAgent": install.user_agent,
                "version": install.version,
                "enabled": install.enabled,
                "lastHeartbeatAt": install.last_heartbeat_at.isoformat() if install.last_heartbeat_at else None,
                "compliant": is_compliant,
            }
        )
    compliance_pct = round((compliant_installs / total_installs) * 100, 1) if total_installs else 0.0

    violation_stats = {
        "prompt": _violation_stats(
            db, since, PROMPT_EVENT_TYPES, EventType.prompt_block,
            [EventType.prompt_confirm_sent, EventType.prompt_anonymized_sent],
        ),
        "file": _violation_stats(db, since, FILE_EVENT_TYPES, EventType.file_block, [EventType.file_confirm]),
    }
    # Anonymized-sent is already counted inside prompt.confirmSent (both are
    # "user chose to send after being flagged") -- broken out separately too
    # since it's a distinct enough action to be worth its own chart series.
    violation_stats["prompt"]["anonymizedSent"] = db.query(GuardEvent).filter(
        GuardEvent.ts >= since,
        GuardEvent.type == EventType.prompt_anonymized_sent,
        GuardEvent.action == EventAction.user_confirmed,
    ).count()

    return {
        "eventsByTypeDay": events_by_type_day,
        "violationStats": violation_stats,
        "installs": install_rows,
        "noncompliantCount": len(noncompliant_devices),
        "noncompliantDevices": [
            {
                "id": d.id,
                "hostname": d.hostname,
                "username": d.username,
                "platform": d.platform,
                "reason": d.reason,
                "status": d.status.value,
                "detectedAt": d.detected_at.isoformat() if d.detected_at else None,
            }
            for d in noncompliant_devices
        ],
        "installCompliance": {
            "totalInstalls": total_installs,
            "compliantInstalls": compliant_installs,
            "compliancePct": compliance_pct,
        },
    }


@router.get("/summary")
def dashboard_summary(db: Session = Depends(get_session), admin=Depends(require_admin)):
    return build_summary(db)


@router.get("", response_class=HTMLResponse)
def dashboard_html(request: Request, db: Session = Depends(get_session), admin=Depends(require_admin)):
    summary = build_summary(db)
    return templates.TemplateResponse(request, "dashboard.html", {"summary": summary})
