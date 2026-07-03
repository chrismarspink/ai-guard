import datetime as dt
import secrets

from fastapi import Depends, Header, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import get_session
from app.models.admin_user import AdminUser
from app.models.install import Install

ALGORITHM = "HS256"

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
# auto_error=False so we can return a uniform 401 (missing vs. malformed) instead
# of FastAPI's default 403 for an absent Authorization header.
bearer_scheme = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def generate_install_token() -> str:
    return secrets.token_urlsafe(32)


def create_access_token(subject: str, role: str) -> str:
    expire = dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=settings.JWT_EXPIRE_MINUTES)
    payload = {"sub": subject, "role": role, "exp": expire}
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=ALGORITHM)


def require_admin(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_session),
) -> AdminUser:
    if credentials is None:
        raise HTTPException(status_code=401, detail="missing bearer token")
    try:
        payload = jwt.decode(credentials.credentials, settings.JWT_SECRET, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="invalid or expired token")
    admin = db.query(AdminUser).filter(AdminUser.email == payload.get("sub")).first()
    if admin is None:
        raise HTTPException(status_code=401, detail="admin not found")
    return admin


def require_install(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    x_install_id: str | None = Header(default=None, alias="X-Install-Id"),
    db: Session = Depends(get_session),
) -> Install:
    # R10 (event forgery / extension impersonation): the token is bound to a
    # specific install_id at registration time, and both must be presented
    # and cross-checked here. Callers below this dependency use install.install_id
    # from the *authenticated* row, never a value the caller sent in a body.
    if credentials is None or not x_install_id:
        raise HTTPException(status_code=401, detail="missing install credentials")
    install = db.query(Install).filter(Install.install_id == x_install_id).first()
    if install is None or not install.bearer_token_hash:
        raise HTTPException(status_code=401, detail="unknown install")
    if not verify_password(credentials.credentials, install.bearer_token_hash):
        raise HTTPException(status_code=401, detail="invalid install token")
    return install


def require_admin_or_install(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    x_install_id: str | None = Header(default=None, alias="X-Install-Id"),
    db: Session = Depends(get_session),
) -> AdminUser | Install:
    # GET /policy is read by both the extension (install token, no
    # X-Install-Id ambiguity possible since it's required) and the /admin
    # console (admin JWT, no X-Install-Id header at all). Try admin first
    # since that's the cheaper/simpler check (no X-Install-Id needed).
    if credentials is not None and not x_install_id:
        try:
            payload = jwt.decode(credentials.credentials, settings.JWT_SECRET, algorithms=[ALGORITHM])
        except JWTError:
            payload = None
        if payload is not None:
            admin = db.query(AdminUser).filter(AdminUser.email == payload.get("sub")).first()
            if admin is not None:
                return admin
    return require_install(credentials, x_install_id, db)
