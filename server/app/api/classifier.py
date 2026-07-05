"""P2: neural classifier (classifier-svc / mDeBERTa) visibility for the console.

Proxies the policy-configured classifier's /health so the admin console can
show whether the neural tier is up, which backend/model, and supported
locales -- without the console needing network access to the sidecar itself.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.policy import _get_current_policy, policy_to_dict
from app.core.auth import require_admin
from app.core.db import get_session

router = APIRouter(prefix="/classifier", tags=["classifier"])


@router.get("/health")
def classifier_health(db: Session = Depends(get_session), admin=Depends(require_admin)):
    policy = _get_current_policy(db)
    cfg = (policy_to_dict(policy).get("classifier") if policy else None) or {}
    url = cfg.get("url")
    if not url:
        return {"configured": False, "reachable": False,
                "message": "no classifier configured in the current policy"}
    base = url.rstrip("/")
    try:
        import httpx

        with httpx.Client(timeout=5.0) as client:
            resp = client.get(f"{base}/health")
            resp.raise_for_status()
            data = resp.json()
        return {
            "configured": True,
            "url": url,
            "backend": cfg.get("neuralBackend"),
            "reachable": True,
            "neural": data.get("neural"),
            "supportedLocales": data.get("supportedLocales"),
        }
    except Exception as exc:  # noqa: BLE001
        return {"configured": True, "url": url, "reachable": False, "message": str(exc)}
