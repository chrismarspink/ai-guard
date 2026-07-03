import datetime as dt
import json
from pathlib import Path

from app.core import db
from app.core.auth import hash_password
from app.core.config import settings
from app.models.admin_user import AdminRole, AdminUser
from app.models.grade_profile import GradeProfileBundle
from app.models.policy import Mode, Policy

DEFAULT_GRADE_PROFILE_NAME = "n2sf-v1"


def seed_admin() -> None:
    if not settings.SEED_ADMIN_EMAIL or not settings.SEED_ADMIN_PASSWORD:
        return
    session = db.SessionLocal()
    try:
        if session.query(AdminUser).count() > 0:
            return
        session.add(
            AdminUser(
                email=settings.SEED_ADMIN_EMAIL,
                password_hash=hash_password(settings.SEED_ADMIN_PASSWORD),
                role=AdminRole.admin,
            )
        )
        session.commit()
    finally:
        session.close()


def _load_default_grade_profile_bundle() -> dict:
    # server/ must also work if copied out of the monorepo (e.g. into its own
    # deployment repo), so a local fallback copy is bundled under app/data/.
    repo_root_path = Path(__file__).resolve().parents[3] / "profiles" / "dist" / f"{DEFAULT_GRADE_PROFILE_NAME}.gradeprofile.json"
    fallback_path = Path(__file__).resolve().parents[1] / "data" / "gradeprofiles" / f"{DEFAULT_GRADE_PROFILE_NAME}.json"
    source = repo_root_path if repo_root_path.exists() else fallback_path
    return json.loads(source.read_text(encoding="utf-8"))


def seed_grade_profile() -> None:
    session = db.SessionLocal()
    try:
        exists = (
            session.query(GradeProfileBundle)
            .filter(GradeProfileBundle.name == DEFAULT_GRADE_PROFILE_NAME)
            .first()
        )
        if exists:
            return
        bundle = _load_default_grade_profile_bundle()
        session.add(GradeProfileBundle(name=DEFAULT_GRADE_PROFILE_NAME, bundle=bundle))
        session.commit()
    finally:
        session.close()


# Mirrors extension/src/policy/default-policy.json's `sites` list. Seeding an
# empty list here would make the extension's isPolicyShaped() check (which
# requires at least one site) reject every freshly-deployed server's policy
# and silently keep using its own bundled default forever -- i.e. the two
# would never actually agree on a shared, server-editable site list until an
# admin manually retyped it into the console once.
DEFAULT_SITES = [
    {"id": "chatgpt", "urls": ["https://chat.openai.com/*", "https://chatgpt.com/*"], "adapterVersion": "1.0.0"},
    {"id": "claude", "urls": ["https://claude.ai/*"], "adapterVersion": "1.0.0"},
    {"id": "gemini", "urls": ["https://gemini.google.com/*"], "adapterVersion": "1.0.0"},
]


def seed_default_policy() -> None:
    session = db.SessionLocal()
    try:
        exists = session.query(Policy).filter(Policy.is_current.is_(True)).first()
        if exists:
            return
        now = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
        session.add(
            Policy(
                policy_version=now,
                mode_prompt=Mode.audit,
                mode_file=Mode.block,
                sites=DEFAULT_SITES,
                grade_profile=DEFAULT_GRADE_PROFILE_NAME,
                mip_label_map={"allowO": [], "denyUnlabeled": True},
                file_check={"contentScan": True, "mipCheck": False},
                user_message={
                    "blocked": "보안 정책에 따라 전송이 차단되었습니다. 보안팀에 보고됩니다.",
                    "confirm": "개인정보 의심 내용이 있습니다. 전송 시 로그가 저장되고 보안팀에 보고됩니다.",
                },
                heartbeat_min=30,
                log_masking=True,
                is_current=True,
                updated_by="system-seed",
            )
        )
        session.commit()
    finally:
        session.close()
