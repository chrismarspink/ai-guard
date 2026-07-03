import enum

from sqlalchemy import Column, DateTime, Enum, Float, ForeignKey, Integer, JSON, String
from sqlalchemy.sql import func

from app.core.db import Base


class EventType(str, enum.Enum):
    prompt_block = "prompt_block"
    prompt_confirm_sent = "prompt_confirm_sent"
    # Distinct from prompt_confirm_sent so the audit trail can tell "user sent
    # the original S/C text as-is" apart from "user sent a masked version" --
    # added 2026-07-03 alongside the extension's anonymize-then-send feature.
    prompt_anonymized_sent = "prompt_anonymized_sent"
    file_block = "file_block"
    file_confirm = "file_confirm"
    # Grade-O checks were never logged at all before 2026-07-03 (only
    # violations were) -- added so the dashboard's violation-rate chart has a
    # true denominator (total checks), not just a count of flagged ones.
    prompt_allowed = "prompt_allowed"
    file_allowed = "file_allowed"
    heartbeat = "heartbeat"


class EventAction(str, enum.Enum):
    blocked = "blocked"
    user_confirmed = "user_confirmed"
    allowed = "allowed"


class GuardEvent(Base):
    __tablename__ = "guard_events"

    id = Column(Integer, primary_key=True)
    type = Column(Enum(EventType, native_enum=False), nullable=False)
    # References Install.install_id (the externally-facing UUID), not the PK,
    # because that's the identity every other part of the system uses.
    install_id = Column(String, ForeignKey("installs.install_id"), nullable=False, index=True)
    user_upn = Column(String, nullable=True)
    site = Column(String, nullable=True)
    grade = Column(String, nullable=True)
    score = Column(Float, nullable=True)
    detections = Column(JSON, nullable=True, default=list)
    file = Column(JSON, nullable=True)
    action = Column(Enum(EventAction, native_enum=False), nullable=False)
    ts = Column(DateTime(timezone=True), nullable=False)
    received_at = Column(DateTime(timezone=True), server_default=func.now())
