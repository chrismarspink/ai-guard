from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.auth import require_admin, require_install
from app.core.db import get_session
from app.models.audit_log import AuditLog
from app.models.grade_profile import GradeProfileBundle

router = APIRouter(prefix="/gradeprofile", tags=["gradeprofile"])


@router.get("/{name}")
def get_grade_profile(
    name: str,
    db: Session = Depends(get_session),
    install=Depends(require_install),
):
    bundle = db.query(GradeProfileBundle).filter(GradeProfileBundle.name == name).first()
    if bundle is None:
        raise HTTPException(status_code=404, detail="grade profile not found")
    return JSONResponse(content=bundle.bundle)


class GradeProfileUpsertRequest(BaseModel):
    bundle: dict


@router.post("/{name}")
def upsert_grade_profile(
    name: str,
    body: GradeProfileUpsertRequest,
    db: Session = Depends(get_session),
    admin=Depends(require_admin),
):
    existing = db.query(GradeProfileBundle).filter(GradeProfileBundle.name == name).first()
    action = "gradeprofile_create" if existing is None else "gradeprofile_update"
    if existing is None:
        existing = GradeProfileBundle(name=name, bundle=body.bundle)
    else:
        existing.bundle = body.bundle
    db.add(existing)
    db.add(AuditLog(actor=admin.email, action=action, detail={"name": name}))
    db.commit()
    db.refresh(existing)
    return {"name": existing.name, "id": existing.id}
