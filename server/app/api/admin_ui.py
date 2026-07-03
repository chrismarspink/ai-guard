from fastapi import APIRouter, Request

from app.api.dashboard import templates

router = APIRouter(tags=["admin-ui"])

# No auth dependency on this route itself: the HTML/JS shell has no sensitive
# data of its own -- it only becomes useful after the in-page login form
# obtains an admin JWT and starts calling the already-authenticated API
# endpoints (GET/PUT /policy, GET /dashboard/summary) from client-side JS.


@router.get("/admin")
def admin_console(request: Request):
    return templates.TemplateResponse(request, "admin.html", {})
