import enum

from sqlalchemy import Column, DateTime, Enum, Integer, JSON, String
from sqlalchemy.sql import func

from app.core.db import Base


class DeviceStatus(str, enum.Enum):
    open = "open"
    acknowledged = "acknowledged"
    resolved = "resolved"


class NoncompliantDevice(Base):
    __tablename__ = "noncompliant_devices"

    id = Column(Integer, primary_key=True)
    hostname = Column(String, nullable=False)
    username = Column(String, nullable=True)
    # Best-effort: only populated when Fleet's webhook payload happens to
    # carry a platform/os_version field (its shape varies by config) -- see
    # fleet.py. Unlike Install.platform, there's no extension running here to
    # ask, so this can legitimately stay null.
    platform = Column(String, nullable=True)
    reason = Column(String, nullable=False, default="not_installed")
    detected_at = Column(DateTime(timezone=True), server_default=func.now())
    status = Column(Enum(DeviceStatus, native_enum=False), nullable=False, default=DeviceStatus.open)
    raw_payload = Column(JSON, nullable=True)
