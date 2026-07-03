from tests.conftest import admin_headers, install_headers, register_install


def test_dashboard_summary_requires_admin(client):
    r = client.get("/api/v1/dashboard/summary")
    assert r.status_code in (401, 403)


def test_dashboard_summary_with_admin(client):
    install_id, token = register_install(client)
    client.post(
        "/api/v1/install/heartbeat",
        json={"version": "1.0.0", "enabled": True, "platform": "mac", "userAgent": "Mozilla/5.0 Chrome/120.0", "user": "dev@innotium.com"},
        headers=install_headers(install_id, token),
    )

    r = client.get("/api/v1/dashboard/summary", headers=admin_headers(client))
    assert r.status_code == 200
    body = r.json()
    assert "eventsByTypeDay" in body
    assert "installCompliance" in body
    assert body["installCompliance"]["totalInstalls"] == 1
    assert body["installCompliance"]["compliantInstalls"] == 1
    assert body["installCompliance"]["compliancePct"] == 100.0

    assert len(body["installs"]) == 1
    install_row = body["installs"][0]
    assert install_row["installId"] == install_id
    assert install_row["platform"] == "mac"
    assert install_row["userAgent"] == "Mozilla/5.0 Chrome/120.0"
    assert install_row["user"] == "dev@innotium.com"
    assert install_row["compliant"] is True


def test_dashboard_violation_stats(client):
    install_id, token = register_install(client)
    headers = install_headers(install_id, token)

    def post_event(body):
        payload = {"site": "chatgpt", "ts": "2026-07-03T00:00:00Z", **body}
        r = client.post("/api/v1/events", json=payload, headers=headers)
        assert r.status_code == 201, r.text

    post_event({"type": "prompt_allowed", "grade": "O", "score": 0, "action": "allowed"})
    post_event({"type": "prompt_allowed", "grade": "O", "score": 0, "action": "allowed"})
    post_event({"type": "prompt_block", "grade": "C", "score": 6.0, "action": "blocked"})
    post_event({"type": "prompt_confirm_sent", "grade": "S", "score": 1.0, "action": "user_confirmed"})
    post_event({"type": "prompt_anonymized_sent", "grade": "C", "score": 6.0, "action": "user_confirmed"})
    post_event({"type": "file_allowed", "grade": "O", "score": 0, "action": "allowed"})
    post_event({"type": "file_block", "grade": "C", "score": 6.0, "action": "blocked"})

    body = client.get("/api/v1/dashboard/summary", headers=admin_headers(client)).json()
    prompt = body["violationStats"]["prompt"]
    file_ = body["violationStats"]["file"]

    assert prompt["total"] == 5
    assert prompt["violations"] == 3  # C, S, C
    assert prompt["violationRatePct"] == 60.0
    assert prompt["blocked"] == 1
    assert prompt["confirmSent"] == 2  # prompt_confirm_sent + prompt_anonymized_sent, both user_confirmed
    assert prompt["anonymizedSent"] == 1

    assert file_["total"] == 2
    assert file_["violations"] == 1
    assert file_["violationRatePct"] == 50.0
    assert file_["blocked"] == 1
    assert file_["confirmSent"] == 0


def test_dashboard_html_requires_admin(client):
    r = client.get("/api/v1/dashboard")
    assert r.status_code in (401, 403)


def test_dashboard_html_with_admin(client):
    r = client.get("/api/v1/dashboard", headers=admin_headers(client))
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
