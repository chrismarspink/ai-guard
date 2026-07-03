from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from app.core.config import settings


def _make_engine(url: str):
    # sqlite needs check_same_thread=False because FastAPI's TestClient and
    # uvicorn workers touch the connection from different threads than it was
    # created on; Postgres doesn't have this restriction.
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    return create_engine(url, connect_args=connect_args, future=True)


# Kept as module-level names (not captured into closures) so tests can swap
# them out (see tests/conftest.py) before the app's startup event runs.
engine = _make_engine(settings.DATABASE_URL)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()


def get_session():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def init_db():
    # v1 uses create_all rather than Alembic migrations; see README for the
    # follow-up note. Safe to call repeatedly (only creates missing tables).
    Base.metadata.create_all(bind=engine)
