import datetime as dt

from fastapi import APIRouter, BackgroundTasks, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.core.alerts import dispatch_alert
from app.core.auth import require_admin, require_install
from app.core.config import settings
from app.core.db import get_session
from app.models.admin_user import AdminUser
from app.models.audit_log import AuditLog
from app.models.guard_event import EventAction, EventType, GuardEvent
from app.models.install import Install

router = APIRouter(tags=["events"])

# High-severity event types that trigger a P10 alert (blocks). Grade "C" on any
# type also triggers one (e.g. a C-grade prompt the user confirmed and sent).
ALERT_EVENT_TYPES = {EventType.prompt_block, EventType.file_block}


class DetectionIn(BaseModel):
    type: str
    count: int
    # Optional: the extension's T1 engine already computes these (see
    # engine/t1-engine.ts's Detection), but they were previously dropped
    # silently (Pydantic ignores unknown fields) -- capturing them is what
    # lets the audit log show *which* masked values and *how much* each
    # finding contributed, not just a bare type+count.
    weight: float | None = None
    samples: list[str] = []
    contribution: float | None = None


class FileInfoIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    name: str
    # grade/score/mipChecked added for the 2026-07-02 content-scan-primary
    # file check (extension task); optional so pre-existing MIP-only events
    # (mipChecked unset) keep validating unchanged.
    grade: str | None = None
    score: float | None = None
    mipChecked: bool | None = Field(default=None, alias="mipChecked")
    labelGuid: str | None = Field(default=None, alias="labelGuid")
    labelName: str | None = Field(default=None, alias="labelName")
    # P2: neural (mDeBERTa) large-document scan coverage. chunksScanned <
    # chunksTotal means MAX_CHUNKS truncated the scan -- a DLP blind spot the
    # dashboard surfaces so admins know a large file wasn't fully analyzed.
    chunksScanned: int | None = Field(default=None, alias="chunksScanned")
    chunksTotal: int | None = Field(default=None, alias="chunksTotal")


class EventIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    type: EventType
    # installId/user are accepted (client sends them per the plan's §3.3
    # schema) but never trusted -- see R10 note in require_install / below.
    installId: str | None = None
    user: str | None = None
    site: str | None = None
    grade: str | None = None
    score: float | None = None
    detections: list[DetectionIn] = []
    file: FileInfoIn | None = None
    action: EventAction
    ts: dt.datetime


@router.post("/events", status_code=201)
def post_event(
    body: EventIn,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_session),
    install: Install = Depends(require_install),
):
    event = GuardEvent(
        type=body.type,
        install_id=install.install_id,  # authenticated identity, not body.installId
        user_upn=body.user,
        site=body.site,
        grade=body.grade,
        score=body.score,
        detections=[d.model_dump() for d in body.detections],
        file=body.file.model_dump(by_alias=True) if body.file else None,
        action=body.action,
        ts=body.ts,
    )
    db.add(event)
    db.commit()
    db.refresh(event)

    # P10: fire-and-forget alert on blocks / grade C (after the response).
    if settings.ALERT_WEBHOOK_URL and (body.type in ALERT_EVENT_TYPES or body.grade == "C"):
        background_tasks.add_task(dispatch_alert, {
            "type": body.type.value,
            "grade": body.grade,
            "site": body.site,
            "user": body.user,
            "installId": install.install_id,
            "action": body.action.value,
            "ts": body.ts.isoformat(),
            "file": body.file.name if body.file else None,
        })
    return {"id": event.id}


def prune_old_events(db: Session, days: int) -> int:
    """P7: delete events older than `days` (by server receive time). No-op when
    days <= 0. Returns the number of rows deleted."""
    if days <= 0:
        return 0
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
    deleted = (
        db.query(GuardEvent)
        .filter(GuardEvent.received_at < cutoff)
        .delete(synchronize_session=False)
    )
    db.commit()
    return deleted


@router.post("/events/prune")
def prune_events(
    days: int | None = None,
    db: Session = Depends(get_session),
    admin: AdminUser = Depends(require_admin),
):
    effective = settings.EVENT_RETENTION_DAYS if days is None else days
    deleted = prune_old_events(db, effective)
    db.add(AuditLog(actor=admin.email, action="events_prune",
                    detail={"retentionDays": effective, "deleted": deleted}))
    db.commit()
    return {"retentionDays": effective, "deleted": deleted}


@router.get("/events")
def list_events(
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_session),
    admin: AdminUser = Depends(require_admin),
):
    # "Who violated what" (2026-07-03 ask) needs the individual rows, not the
    # by-type/by-day counts dashboard/summary already aggregates -- this is
    # the detail view behind that. Capped at 500/page: an unbounded admin
    # query against a table that grows with every prompt/file check would be
    # a self-inflicted DoS as event volume grows.
    limit = min(max(limit, 1), 500)
    offset = max(offset, 0)
    # Order by server receive time, not the client-reported `ts` (which the
    # extension sets and could be skewed/backdated) -- received_at is the
    # authoritative, tamper-resistant ordering key (P8).
    rows = (
        db.query(GuardEvent)
        .order_by(GuardEvent.received_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    # Join the Install rows so each event line can show the device/account the
    # extension reports on heartbeat (platform, userAgent, signed-in email) --
    # the event row itself only carries an opaque install_id, so device/account
    # were previously not visible in the log.
    installs = {
        i.install_id: i
        for i in db.query(Install).filter(Install.install_id.in_([r.install_id for r in rows])).all()
    }
    return {
        "total": db.query(GuardEvent).count(),
        "events": [
            {
                "id": r.id,
                "type": r.type.value,
                "installId": r.install_id,
                "installVersion": installs[r.install_id].version if r.install_id in installs else None,
                # Account: prefer the value on the event; fall back to the
                # signed-in Chrome email captured on the install's heartbeat.
                "user": r.user_upn or (installs[r.install_id].user_upn if r.install_id in installs else None),
                "platform": installs[r.install_id].platform if r.install_id in installs else None,
                "userAgent": installs[r.install_id].user_agent if r.install_id in installs else None,
                "site": r.site,
                "grade": r.grade,
                "score": r.score,
                "detections": r.detections or [],
                "file": r.file,
                "action": r.action.value,
                "ts": r.ts.isoformat(),
                "receivedAt": r.received_at.isoformat() if r.received_at else None,
            }
            for r in rows
        ],
    }
