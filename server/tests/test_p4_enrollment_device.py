from app.core.config import settings
from app.models.audit_log import AuditLog
from app.core import db as db_module
from tests.conftest import admin_headers, install_headers, register_install


def test_register_requires_enrollment_secret_when_configured(client, monkeypatch):
    monkeypatch.setattr(settings, "INSTALL_ENROLLMENT_SECRET", "org-secret")
    # Missing/incorrect secret -> 401.
    assert client.post("/api/v1/install/register", json={"version": "1.0.0"}).status_code == 401
    assert client.post("/api/v1/install/register", json={"version": "1.0.0"},
                       headers={"X-Enroll-Secret": "wrong"}).status_code == 401
    # Correct secret -> 200.
    ok = client.post("/api/v1/install/register", json={"version": "1.0.0"},
                     headers={"X-Enroll-Secret": "org-secret"})
    assert ok.status_code == 200
    assert ok.json()["installId"]


def test_register_open_when_no_secret_configured(client):
    # Default (no enrollment secret) keeps registration open for dev.
    assert client.post("/api/v1/install/register", json={"version": "1.0.0"}).status_code == 200


def test_register_writes_audit_log(client):
    install_id, _ = register_install(client)
    db = db_module.SessionLocal()
    try:
        logs = db.query(AuditLog).filter(AuditLog.action == "install_register").all()
        assert any(log.actor == install_id for log in logs)
    finally:
        db.close()


def test_events_log_surfaces_device_and_account(client):
    install_id, token = register_install(client)
    headers = install_headers(install_id, token)
    # Heartbeat carries the device/account context (as the extension sends it).
    client.post("/api/v1/install/heartbeat", json={
        "version": "1.0.0", "enabled": True,
        "platform": "mac", "userAgent": "Chrome/130", "user": "jane@corp.com",
    }, headers=headers)
    # An event that itself carries no user still shows the account via the join.
    client.post("/api/v1/events", json={
        "type": "prompt_block", "site": "chatgpt", "grade": "C",
        "action": "blocked", "ts": "2026-07-04T00:00:00Z",
    }, headers=headers)

    row = client.get("/api/v1/events", headers=admin_headers(client)).json()["events"][0]
    assert row["platform"] == "mac"
    assert row["userAgent"] == "Chrome/130"
    assert row["user"] == "jane@corp.com"
