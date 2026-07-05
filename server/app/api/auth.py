from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.auth import create_access_token, verify_password
from app.core.db import get_session
from app.models.admin_user import AdminUser
from app.models.audit_log import AuditLog

router = APIRouter(prefix="/auth", tags=["auth"])


def _client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, request: Request, db: Session = Depends(get_session)):
    admin = db.query(AdminUser).filter(AdminUser.email == body.email).first()
    if admin is None or not verify_password(body.password, admin.password_hash):
        # P5: audit failed logins too -- brute-force/enumeration signal.
        db.add(AuditLog(actor=body.email, action="admin_login_failed",
                        detail={"ip": _client_ip(request)}))
        db.commit()
        raise HTTPException(status_code=401, detail="invalid credentials")
    token = create_access_token(subject=admin.email, role=admin.role.value)
    db.add(AuditLog(actor=admin.email, action="admin_login",
                    detail={"ip": _client_ip(request)}))
    db.commit()
    return LoginResponse(access_token=token)
