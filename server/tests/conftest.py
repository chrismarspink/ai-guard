import os

# Must be set before app.core.config.Settings() is instantiated at import
# time; conftest is imported before any test module, so this is early enough.
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
# Deliberately unreachable: cache_get/set/delete are soft-fail (see
# app/core/redis_client.py) so tests stay hermetic without a live Redis.
os.environ.setdefault("REDIS_URL", "redis://127.0.0.1:1/0")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret")
os.environ.setdefault("FLEET_WEBHOOK_SECRET", "test-fleet-secret")
os.environ.setdefault("SEED_ADMIN_EMAIL", "admin@test.local")
os.environ.setdefault("SEED_ADMIN_PASSWORD", "test-admin-password-123")

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core import db as db_module


@pytest.fixture()
def client():
    # Fresh in-memory SQLite engine per test so tests don't leak install/event
    # rows into each other's assertions (e.g. dashboard counts).
    test_engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    test_session_local = sessionmaker(bind=test_engine, autoflush=False, autocommit=False, future=True)
    db_module.engine = test_engine
    db_module.SessionLocal = test_session_local

    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


def register_install(client, version: str = "1.0.0") -> tuple[str, str]:
    r = client.post("/api/v1/install/register", json={"version": version})
    assert r.status_code == 200, r.text
    data = r.json()
    return data["installId"], data["token"]


def install_headers(install_id: str, token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "X-Install-Id": install_id}


def admin_token(client) -> str:
    r = client.post(
        "/api/v1/auth/login",
        json={"email": os.environ["SEED_ADMIN_EMAIL"], "password": os.environ["SEED_ADMIN_PASSWORD"]},
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def admin_headers(client) -> dict:
    return {"Authorization": f"Bearer {admin_token(client)}"}
