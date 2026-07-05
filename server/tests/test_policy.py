from tests.conftest import admin_headers, install_headers, register_install

SAMPLE_POLICY_BODY = {
    "mode": {"prompt": "confirm", "file": "block"},
    "sites": [{"id": "chatgpt", "urls": ["https://chatgpt.com/*"], "adapterVersion": "1.0.0"}],
    "gradeProfile": "n2sf-v1",
    "mipLabelMap": {"allowO": ["GUID-PUBLIC"], "denyUnlabeled": True},
    "fileCheck": {"contentScan": True, "mipCheck": True},
    "userMessage": {"blocked": "차단됨", "confirm": "확인 필요"},
    "heartbeatMin": 15,
    "logMasking": True,
}


def test_get_policy_requires_install_auth(client):
    r = client.get("/api/v1/policy")
    assert r.status_code == 401


def test_get_policy_returns_seeded_default(client):
    install_id, token = register_install(client)
    r = client.get("/api/v1/policy", headers=install_headers(install_id, token))
    assert r.status_code == 200
    body = r.json()
    assert body["gradeProfile"] == "n2sf-v1"
    assert "policyVersion" in body
    assert body["mode"]["file"] == "block"
    assert body["fileCheck"] == {"contentScan": True, "mipCheck": False}
    assert r.headers.get("etag")


def test_get_policy_also_accepts_admin_token(client):
    # The /admin console reads policy with its admin JWT, no X-Install-Id at
    # all -- this is the auth boundary require_admin_or_install adds.
    r = client.get("/api/v1/policy", headers=admin_headers(client))
    assert r.status_code == 200
    assert r.json()["gradeProfile"] == "n2sf-v1"


def test_get_policy_rejects_admin_token_shaped_wrong(client):
    r = client.get("/api/v1/policy", headers={"Authorization": "Bearer garbage"})
    assert r.status_code == 401


def test_get_policy_etag_returns_304(client):
    install_id, token = register_install(client)
    headers = install_headers(install_id, token)
    r1 = client.get("/api/v1/policy", headers=headers)
    etag = r1.headers["etag"]
    r2 = client.get("/api/v1/policy", headers={**headers, "If-None-Match": etag})
    assert r2.status_code == 304


def test_put_policy_requires_admin(client):
    r = client.put("/api/v1/policy", json=SAMPLE_POLICY_BODY)
    assert r.status_code in (401, 403)


def test_put_policy_with_wrong_admin_token_fails(client):
    r = client.put(
        "/api/v1/policy", json=SAMPLE_POLICY_BODY, headers={"Authorization": "Bearer not-a-real-token"}
    )
    assert r.status_code == 401


def test_put_policy_with_admin_bumps_version(client):
    install_id, token = register_install(client)
    old = client.get("/api/v1/policy", headers=install_headers(install_id, token)).json()

    r = client.put("/api/v1/policy", json=SAMPLE_POLICY_BODY, headers=admin_headers(client))
    assert r.status_code == 200
    new = r.json()
    assert new["policyVersion"] != old["policyVersion"]
    assert new["mode"]["prompt"] == "confirm"
    assert new["heartbeatMin"] == 15
    assert new["fileCheck"] == {"contentScan": True, "mipCheck": True}

    refreshed = client.get("/api/v1/policy", headers=install_headers(install_id, token)).json()
    assert refreshed["policyVersion"] == new["policyVersion"]


def test_put_policy_round_trips_classifier_config(client):
    # P1: the console can push the neural (mDeBERTa) classifier config, and the
    # extension reads it back via GET /policy.
    body = {
        **SAMPLE_POLICY_BODY,
        "classifier": {"url": "http://classifier:10030", "locale": "ko", "neuralBackend": "mdeberta"},
        "serverBaseUrl": "https://console.example",
    }
    r = client.put("/api/v1/policy", json=body, headers=admin_headers(client))
    assert r.status_code == 200
    assert r.json()["classifier"]["neuralBackend"] == "mdeberta"

    install_id, token = register_install(client)
    got = client.get("/api/v1/policy", headers=install_headers(install_id, token)).json()
    assert got["classifier"] == {"url": "http://classifier:10030", "locale": "ko", "neuralBackend": "mdeberta"}
    assert got["serverBaseUrl"] == "https://console.example"


def test_policy_omits_classifier_when_unset(client):
    # A policy that doesn't set classifier/serverBaseUrl must not emit null keys
    # that would clobber the extension's bundled defaults.
    r = client.put("/api/v1/policy", json=SAMPLE_POLICY_BODY, headers=admin_headers(client))
    assert r.status_code == 200
    assert "classifier" not in r.json()
    assert "serverBaseUrl" not in r.json()
