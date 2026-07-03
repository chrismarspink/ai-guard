from sqlalchemy import Column, DateTime, Integer, JSON, String
from sqlalchemy.sql import func

from app.core.db import Base


class GradeProfileBundle(Base):
    __tablename__ = "grade_profile_bundles"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False, unique=True, index=True)
    bundle = Column(JSON, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
