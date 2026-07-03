import enum

from sqlalchemy import Column, DateTime, Enum, Integer, String
from sqlalchemy.sql import func

from app.core.db import Base


class AdminRole(str, enum.Enum):
    admin = "admin"
    viewer = "viewer"


class AdminUser(Base):
    __tablename__ = "admin_users"

    id = Column(Integer, primary_key=True)
    email = Column(String, nullable=False, unique=True, index=True)
    password_hash = Column(String, nullable=False)
    role = Column(Enum(AdminRole, native_enum=False), nullable=False, default=AdminRole.admin)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
