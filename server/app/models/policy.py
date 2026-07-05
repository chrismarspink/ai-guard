import enum

from sqlalchemy import Boolean, Column, DateTime, Enum, Integer, JSON, String
from sqlalchemy.sql import func

from app.core.db import Base


class Mode(str, enum.Enum):
    block = "block"
    confirm = "confirm"
    audit = "audit"


class Policy(Base):
    __tablename__ = "policies"

    id = Column(Integer, primary_key=True)
    policy_version = Column(String, nullable=False, index=True)
    mode_prompt = Column(Enum(Mode, native_enum=False), nullable=False, default=Mode.audit)
    mode_file = Column(Enum(Mode, native_enum=False), nullable=False, default=Mode.block)
    sites = Column(JSON, nullable=False, default=list)
    grade_profile = Column(String, nullable=False)
    mip_label_map = Column(JSON, nullable=False, default=dict)
    # Added 2026-07-02 alongside the extension's content-scan-primary file
    # check; nullable so pre-existing rows (created before this column
    # existed) don't fail to load -- policy_to_dict() fills the v1 default.
    file_check = Column(JSON, nullable=True)
    user_message = Column(JSON, nullable=False, default=dict)
    heartbeat_min = Column(Integer, nullable=False, default=30)
    log_masking = Column(Boolean, nullable=False, default=True)
    # Optional neural classifier (classifier-svc / mDeBERTa) config and the
    # console base URL the extension reports to. Both are consumed by the
    # extension's policy loader; nullable so pre-existing rows load unchanged.
    classifier = Column(JSON, nullable=True)
    server_base_url = Column(String, nullable=True)
    # Explicit flag rather than "latest by updated_at" so the "current" row is
    # an unambiguous, indexed lookup even if two updates land in the same tick.
    is_current = Column(Boolean, nullable=False, default=False, index=True)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    updated_by = Column(String, nullable=True)
