from sqlalchemy import Column, DateTime, Integer, JSON, String
from sqlalchemy.sql import func

from app.core.db import Base


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True)
    # Either an admin email or an install_id -- the two trust boundaries share
    # one audit trail so a reviewer can see policy edits and install activity
    # in one timeline (see plan doc S8, RBAC/audit log requirement).
    actor = Column(String, nullable=False)
    action = Column(String, nullable=False)
    detail = Column(JSON, nullable=True)
    ts = Column(DateTime(timezone=True), server_default=func.now())
