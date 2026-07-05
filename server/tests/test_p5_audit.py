from tests.conftest import admin_headers, admin_token, register_install


def test_audit_requires_admin(client):
    assert client.get("/api/v1/audit").status_code in (401, 403)


def test_login_and_register_are_audited(client):
    # A successful admin login + an install register should both appear.
    admin_token(client)          # triggers admin_login
    register_install(client)     # triggers install_register
    body = client.get("/api/v1/audit", headers=admin_headers(client)).json()
    actions = {e["action"] for e in body["entries"]}
    assert "admin_login" in actions
    assert "install_register" in actions


def test_failed_login_is_audited(client):
    client.post("/api/v1/auth/login", json={"email": "admin@test.local", "password": "wrong"})
    body = client.get("/api/v1/audit", headers=admin_headers(client), params={"action": "admin_login_failed"}).json()
    assert body["total"] >= 1
    assert all(e["action"] == "admin_login_failed" for e in body["entries"])


def test_gradeprofile_upsert_is_audited(client):
    client.post("/api/v1/gradeprofile/custom-v1", json={"bundle": {"x": 1}}, headers=admin_headers(client))
    body = client.get("/api/v1/audit", headers=admin_headers(client)).json()
    actions = {e["action"] for e in body["entries"]}
    assert "gradeprofile_create" in actions
