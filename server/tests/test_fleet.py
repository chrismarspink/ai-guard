import os

from tests.conftest import admin_headers

WEBHOOK_BODY = {
    "hostname": "WKS-001",
    "host_users": ["jdoe"],
    "policy_id": 42,
    "policy_name": "ai_guard_extension_installed",
}


def test_webhook_requires_secret(client):
    r = client.post("/api/v1/fleet/webhook", json=WEBHOOK_BODY)
    assert r.status_code == 401


def test_webhook_with_wrong_secret_fails(client):
    r = client.post(
        "/api/v1/fleet/webhook", json=WEBHOOK_BODY, headers={"X-Fleet-Webhook-Secret": "wrong"}
    )
    assert r.status_code == 401


def test_webhook_creates_noncompliant_device(client):
    r = client.post(
        "/api/v1/fleet/webhook",
        json=WEBHOOK_BODY,
        headers={"X-Fleet-Webhook-Secret": os.environ["FLEET_WEBHOOK_SECRET"]},
    )
    assert r.status_code == 201, r.text

    r2 = client.get("/api/v1/fleet/noncompliant", headers=admin_headers(client))
    assert r2.status_code == 200
    devices = r2.json()
    assert len(devices) == 1
    assert devices[0]["hostname"] == "WKS-001"
    assert devices[0]["username"] == "jdoe"


def test_list_noncompliant_requires_admin(client):
    r = client.get("/api/v1/fleet/noncompliant")
    assert r.status_code in (401, 403)
