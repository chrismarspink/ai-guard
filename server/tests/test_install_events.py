from tests.conftest import admin_headers, install_headers, register_install


def test_register_then_heartbeat_then_event_roundtrip(client):
    install_id, token = register_install(client, version="1.2.3")
    headers = install_headers(install_id, token)

    r = client.post("/api/v1/install/heartbeat", json={"version": "1.2.3", "enabled": True}, headers=headers)
    assert r.status_code == 200

    event_body = {
        "type": "prompt_block",
        "installId": "some-other-install-id-should-be-ignored",
        "user": "someone@example.com",
        "site": "chatgpt",
        "grade": "C",
        "score": 12.0,
        "detections": [{"type": "KR_RRN", "count": 1}],
        "file": None,
        "action": "blocked",
        "ts": "2026-07-02T00:00:00Z",
    }
    r = client.post("/api/v1/events", json=event_body, headers=headers)
    assert r.status_code == 201, r.text


def test_prompt_anonymized_sent_event_accepted(client):
    install_id, token = register_install(client)
    headers = install_headers(install_id, token)
    event_body = {
        "type": "prompt_anonymized_sent",
        "site": "chatgpt",
        "grade": "C",
        "score": 6.0,
        "detections": [{"type": "KR_RRN", "count": 1}],
        "action": "user_confirmed",
        "ts": "2026-07-03T00:00:00Z",
    }
    r = client.post("/api/v1/events", json=event_body, headers=headers)
    assert r.status_code == 201, r.text


def test_list_events_requires_admin(client):
    r = client.get("/api/v1/events")
    assert r.status_code in (401, 403)


def test_list_events_returns_full_detail_for_admin(client):
    install_id, token = register_install(client, version="2.0.0")
    headers = install_headers(install_id, token)
    event_body = {
        "type": "prompt_block",
        "user": "someone@example.com",
        "site": "chatgpt",
        "grade": "C",
        "score": 12.0,
        "detections": [
            {"type": "KR_RRN", "count": 1, "weight": 6.0, "samples": ["90****-*******"], "contribution": 6.0}
        ],
        "action": "blocked",
        "ts": "2026-07-02T00:00:00Z",
    }
    client.post("/api/v1/events", json=event_body, headers=headers)

    r = client.get("/api/v1/events", headers=admin_headers(client))
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    row = body["events"][0]
    assert row["user"] == "someone@example.com"
    assert row["installId"] == install_id
    assert row["installVersion"] == "2.0.0"
    assert row["detections"][0]["samples"] == ["90****-*******"]
    assert row["detections"][0]["contribution"] == 6.0


def test_heartbeat_without_token_fails(client):
    r = client.post("/api/v1/install/heartbeat", json={"version": "1.0.0", "enabled": True})
    assert r.status_code == 401


def test_heartbeat_with_wrong_token_fails(client):
    install_id, _token = register_install(client)
    r = client.post(
        "/api/v1/install/heartbeat",
        json={"version": "1.0.0", "enabled": True},
        headers=install_headers(install_id, "wrong-token"),
    )
    assert r.status_code == 401


def test_events_with_mismatched_install_id_header_fails(client):
    install_id, token = register_install(client)
    other_install_id, _other_token = register_install(client)
    headers = install_headers(other_install_id, token)  # token doesn't belong to this install_id
    r = client.post(
        "/api/v1/events",
        json={
            "type": "heartbeat",
            "action": "allowed",
            "ts": "2026-07-02T00:00:00Z",
        },
        headers=headers,
    )
    assert r.status_code == 401
