from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.auth import create_access_token, verify_password
from app.core.db import get_session
from app.models.admin_user import AdminUser

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, db: Session = Depends(get_session)):
    admin = db.query(AdminUser).filter(AdminUser.email == body.email).first()
    if admin is None or not verify_password(body.password, admin.password_hash):
        raise HTTPException(status_code=401, detail="invalid credentials")
    token = create_access_token(subject=admin.email, role=admin.role.value)
    return LoginResponse(access_token=token)
