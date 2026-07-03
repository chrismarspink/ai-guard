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
