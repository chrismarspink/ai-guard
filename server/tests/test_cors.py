# Regression test for a real bug found 2026-07-03: the extension's service
# worker calls this API cross-origin (chrome-extension://<id> -> server), and
# the Authorization/X-Install-Id headers on every install/policy/events call
# force a CORS preflight. Without CORSMiddleware, that preflight 405s and the
# browser never sends the real request at all -- silently, with nothing in
# the server log except the failed OPTIONS. This test would have caught it.
def test_preflight_allows_extension_origin_and_auth_headers(client):
    r = client.options(
        "/api/v1/install/register",
        headers={
            "Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,x-install-id,content-type",
        },
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "*"
    allowed_headers = r.headers["access-control-allow-headers"].lower()
    assert "authorization" in allowed_headers
    assert "x-install-id" in allowed_headers


def test_actual_response_carries_cors_header(client):
    r = client.get("/healthz", headers={"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"})
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") == "*"
