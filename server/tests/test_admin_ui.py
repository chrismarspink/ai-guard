def test_admin_console_loads_without_auth(client):
    # The shell itself carries no sensitive data -- auth happens client-side
    # via the in-page login form calling the already-protected API routes.
    r = client.get("/admin")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    assert "innoecm-ai-guard" in r.text


def test_chart_js_served_locally_not_from_a_cdn(client):
    # Vendored (app/static/chart.umd.min.js) so the console keeps working
    # air-gapped -- this pins that it's actually reachable at that path.
    r = client.get("/static/chart.umd.min.js")
    assert r.status_code == 200
    assert "Chart.js" in r.text


def test_root_redirects_to_admin_console(client):
    # Hosts that default to showing a bare "/" (e.g. Hugging Face Spaces'
    # embedded app view) would otherwise hit a raw {"detail":"Not Found"} --
    # found live 2026-07-03 on the deployed Space.
    r = client.get("/", follow_redirects=False)
    assert r.status_code in (302, 307)
    assert r.headers["location"] == "/admin"
