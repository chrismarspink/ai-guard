import datetime as dt
import json

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.core.auth import require_admin, require_admin_or_install
from app.core.db import get_session
from app.core.redis_client import cache_delete, cache_get, cache_set
from app.models.admin_user import AdminUser
from app.models.audit_log import AuditLog
from app.models.policy import Mode, Policy

router = APIRouter(tags=["policy"])

POLICY_CACHE_KEY = "policy:current"


class ModeIn(BaseModel):
    prompt: Mode
    file: Mode


class SiteIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    urls: list[str]
    adapterVersion: str = Field(alias="adapterVersion")


class PolicyIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    mode: ModeIn
    sites: list[SiteIn]
    grade_profile: str = Field(alias="gradeProfile")
    mip_label_map: dict = Field(alias="mipLabelMap")
    file_check: dict = Field(alias="fileCheck")
    user_message: dict = Field(alias="userMessage")
    heartbeat_min: int = Field(alias="heartbeatMin")
    log_masking: bool = Field(alias="logMasking")
    # Optional: neural classifier config ({url, locale, neuralBackend}) and the
    # console base URL. Absent on older console clients, so both default to None.
    classifier: dict | None = None
    server_base_url: str | None = Field(default=None, alias="serverBaseUrl")


DEFAULT_FILE_CHECK = {"contentScan": True, "mipCheck": False}


def policy_to_dict(policy: Policy) -> dict:
    return {
        "policyVersion": policy.policy_version,
        "mode": {"prompt": Mode(policy.mode_prompt).value, "file": Mode(policy.mode_file).value},
        "sites": policy.sites or [],
        "gradeProfile": policy.grade_profile,
        "mipLabelMap": policy.mip_label_map or {},
        "fileCheck": policy.file_check or DEFAULT_FILE_CHECK,
        "userMessage": policy.user_message or {},
        "heartbeatMin": policy.heartbeat_min,
        "logMasking": policy.log_masking,
        # Only surface these when set, so a policy that doesn't configure them
        # doesn't override the extension's bundled defaults with nulls.
        **({"serverBaseUrl": policy.server_base_url} if policy.server_base_url else {}),
        **({"classifier": policy.classifier} if policy.classifier else {}),
    }


def _get_current_policy(db: Session) -> Policy | None:
    return (
        db.query(Policy)
        .filter(Policy.is_current.is_(True))
        .order_by(Policy.updated_at.desc())
        .first()
    )


@router.get("/policy")
def get_policy(
    request: Request,
    db: Session = Depends(get_session),
    # Admins reading policy (e.g. the /admin console) isn't a security
    # concern the way an arbitrary unauthenticated read would be -- they
    # already have full write access via PUT below. Installs still need
    # their own token+X-Install-Id pair, unchanged.
    identity=Depends(require_admin_or_install),
):
    cached = cache_get(POLICY_CACHE_KEY)
    if cached is not None:
        data = json.loads(cached)
    else:
        policy = _get_current_policy(db)
        if policy is None:
            raise HTTPException(status_code=404, detail="no policy configured")
        data = policy_to_dict(policy)
        cache_set(POLICY_CACHE_KEY, json.dumps(data))

    etag = f'"{data["policyVersion"]}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return JSONResponse(content=data, headers={"ETag": etag})


@router.put("/policy")
def put_policy(
    body: PolicyIn,
    db: Session = Depends(get_session),
    admin: AdminUser = Depends(require_admin),
):
    previous = _get_current_policy(db)
    before = policy_to_dict(previous) if previous else None
    if previous is not None:
        previous.is_current = False
        db.add(previous)

    new_version = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    new_policy = Policy(
        policy_version=new_version,
        mode_prompt=body.mode.prompt,
        mode_file=body.mode.file,
        sites=[site.model_dump(by_alias=True) for site in body.sites],
        grade_profile=body.grade_profile,
        mip_label_map=body.mip_label_map,
        file_check=body.file_check,
        user_message=body.user_message,
        heartbeat_min=body.heartbeat_min,
        log_masking=body.log_masking,
        classifier=body.classifier,
        server_base_url=body.server_base_url,
        is_current=True,
        updated_by=admin.email,
    )
    db.add(new_policy)
    db.flush()
    after = policy_to_dict(new_policy)
    db.add(AuditLog(actor=admin.email, action="policy_update", detail={"before": before, "after": after}))
    db.commit()
    db.refresh(new_policy)

    cache_delete(POLICY_CACHE_KEY)
    return JSONResponse(content=policy_to_dict(new_policy))
