import datetime as dt

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.core.auth import require_admin, require_install
from app.core.db import get_session
from app.models.admin_user import AdminUser
from app.models.guard_event import EventAction, EventType, GuardEvent
from app.models.install import Install

router = APIRouter(tags=["events"])


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
    return {"id": event.id}


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
    rows = (
        db.query(GuardEvent)
        .order_by(GuardEvent.ts.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    install_versions = {
        i.install_id: i.version
        for i in db.query(Install).filter(Install.install_id.in_([r.install_id for r in rows])).all()
    }
    return {
        "total": db.query(GuardEvent).count(),
        "events": [
            {
                "id": r.id,
                "type": r.type.value,
                "installId": r.install_id,
                "installVersion": install_versions.get(r.install_id),
                "user": r.user_upn,
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
