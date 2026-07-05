import datetime as dt

from app.api.events import prune_old_events
from app.core import db as db_module
from app.models.guard_event import GuardEvent
from tests.conftest import admin_headers, install_headers, register_install


def _post_file_event(client, headers, name, chunks_scanned, chunks_total, grade="C"):
    return client.post("/api/v1/events", json={
        "type": "file_block",
        "site": "chatgpt",
        "grade": grade,
        "action": "blocked",
        "ts": "2026-07-04T00:00:00Z",
        "file": {"name": name, "grade": grade, "chunksScanned": chunks_scanned, "chunksTotal": chunks_total},
    }, headers=headers)


def test_dashboard_reports_truncated_large_doc_scans(client):
    install_id, token = register_install(client)
    headers = install_headers(install_id, token)
    _post_file_event(client, headers, "full.txt", 4, 4)       # fully scanned
    _post_file_event(client, headers, "huge.txt", 64, 130)     # truncated by MAX_CHUNKS

    summary = client.get("/api/v1/dashboard/summary", headers=admin_headers(client)).json()
    assert summary["largeDocScans"]["withChunkInfo"] == 2
    assert summary["largeDocScans"]["truncated"] == 1


def test_classifier_health_reports_unconfigured_by_default(client):
    # Seeded default policy has no classifier configured.
    r = client.get("/api/v1/classifier/health", headers=admin_headers(client))
    assert r.status_code == 200
    assert r.json()["configured"] is False


def test_classifier_health_requires_admin(client):
    assert client.get("/api/v1/classifier/health").status_code in (401, 403)


def test_prune_old_events_deletes_by_received_at(client):
    install_id, token = register_install(client)
    headers = install_headers(install_id, token)
    client.post("/api/v1/events", json={
        "type": "heartbeat", "action": "allowed", "ts": "2026-07-04T00:00:00Z",
    }, headers=headers)

    # Backdate received_at directly so retention has something old to prune.
    db = db_module.SessionLocal()
    try:
        ev = db.query(GuardEvent).first()
        ev.received_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=200)
        db.add(ev)
        db.commit()
        deleted = prune_old_events(db, days=90)
        assert deleted == 1
    finally:
        db.close()


def test_prune_endpoint_requires_admin(client):
    assert client.post("/api/v1/events/prune").status_code in (401, 403)
