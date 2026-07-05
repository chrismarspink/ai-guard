import datetime as dt
import json
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.auth import require_admin
from app.core.db import get_session
from app.core.redis_client import cache_get, cache_set
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
    # Window on received_at (server time), not the client-reported ts (P8).
    base = db.query(GuardEvent).filter(GuardEvent.received_at >= since, GuardEvent.type.in_(category_types))
    total = base.count()
    violations = base.filter(GuardEvent.grade.in_(["S", "C"])).count()
    blocked = db.query(GuardEvent).filter(
        GuardEvent.received_at >= since, GuardEvent.type == block_type
    ).count()
    confirm_sent = db.query(GuardEvent).filter(
        GuardEvent.received_at >= since,
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
        db.query(GuardEvent.type, func.date(GuardEvent.received_at), func.count(GuardEvent.id))
        .filter(GuardEvent.received_at >= since)
        .group_by(GuardEvent.type, func.date(GuardEvent.received_at))
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
        GuardEvent.received_at >= since,
        GuardEvent.type == EventType.prompt_anonymized_sent,
        GuardEvent.action == EventAction.user_confirmed,
    ).count()

    # P2: large-document neural scan coverage. A file whose chunksScanned <
    # chunksTotal was truncated by MAX_CHUNKS -- i.e. not fully analyzed, a DLP
    # blind spot worth surfacing.
    file_blobs = (
        db.query(GuardEvent.file)
        .filter(GuardEvent.received_at >= since, GuardEvent.file.isnot(None))
        .all()
    )
    scanned_with_chunks = 0
    truncated_scans = 0
    for (f,) in file_blobs:
        if isinstance(f, dict) and f.get("chunksTotal"):
            scanned_with_chunks += 1
            if (f.get("chunksScanned") or 0) < f["chunksTotal"]:
                truncated_scans += 1
    large_doc_scans = {"withChunkInfo": scanned_with_chunks, "truncated": truncated_scans}

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
        "largeDocScans": large_doc_scans,
    }


SUMMARY_CACHE_KEY = "dashboard:summary"
SUMMARY_CACHE_TTL = 30  # seconds -- a full recompute per admin refresh is a self-DoS as events grow (P7)


def cached_summary(db: Session) -> dict:
    cached = cache_get(SUMMARY_CACHE_KEY)
    if cached is not None:
        return json.loads(cached)
    data = build_summary(db)
    cache_set(SUMMARY_CACHE_KEY, json.dumps(data), ex=SUMMARY_CACHE_TTL)
    return data


@router.get("/summary")
def dashboard_summary(db: Session = Depends(get_session), admin=Depends(require_admin)):
    return cached_summary(db)


@router.get("", response_class=HTMLResponse)
def dashboard_html(request: Request, db: Session = Depends(get_session), admin=Depends(require_admin)):
    summary = cached_summary(db)
    return templates.TemplateResponse(request, "dashboard.html", {"summary": summary})
