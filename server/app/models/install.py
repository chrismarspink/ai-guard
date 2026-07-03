from sqlalchemy import Boolean, Column, DateTime, Integer, String
from sqlalchemy.sql import func

from app.core.db import Base


class Install(Base):
    __tablename__ = "installs"

    id = Column(Integer, primary_key=True)
    install_id = Column(String, nullable=False, unique=True, index=True)
    user_upn = Column(String, nullable=True)
    # OS/browser context, sent by the extension on heartbeat (chrome.runtime
    # getPlatformInfo()/navigator.userAgent) -- added 2026-07-03 so "which
    # device" answers more than just an opaque install UUID.
    platform = Column(String, nullable=True)
    user_agent = Column(String, nullable=True)
    version = Column(String, nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)
    last_heartbeat_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    # Never store the raw bearer token (R10) -- only its bcrypt hash.
    bearer_token_hash = Column(String, nullable=False)
