"""P5: read the audit trail (policy edits, logins, install/gradeprofile/fleet
activity, event pruning) in one place for compliance review."""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import require_admin
from app.core.db import get_session
from app.models.audit_log import AuditLog

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("")
def list_audit(
    limit: int = 100,
    offset: int = 0,
    action: str | None = None,
    db: Session = Depends(get_session),
    admin=Depends(require_admin),
):
    limit = min(max(limit, 1), 500)
    offset = max(offset, 0)
    query = db.query(AuditLog)
    if action:
        query = query.filter(AuditLog.action == action)
    total = query.count()
    rows = query.order_by(AuditLog.ts.desc()).offset(offset).limit(limit).all()
    return {
        "total": total,
        "entries": [
            {
                "id": r.id,
                "actor": r.actor,
                "action": r.action,
                "detail": r.detail,
                "ts": r.ts.isoformat() if r.ts else None,
            }
            for r in rows
        ],
    }
