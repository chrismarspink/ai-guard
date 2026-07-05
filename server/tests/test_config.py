import pytest

from app.core.config import DEV_DEFAULT_SECRET, Settings


def test_production_refuses_default_secrets():
    # P3: starting in production on the source-controlled dev default must fail.
    with pytest.raises(ValueError):
        Settings(ENV="production", JWT_SECRET=DEV_DEFAULT_SECRET, FLEET_WEBHOOK_SECRET="real-secret")
    with pytest.raises(ValueError):
        Settings(ENV="production", JWT_SECRET="real-secret", FLEET_WEBHOOK_SECRET=DEV_DEFAULT_SECRET)


def test_production_starts_with_real_secrets():
    s = Settings(ENV="production", JWT_SECRET="a-strong-secret", FLEET_WEBHOOK_SECRET="another-strong-secret")
    assert s.ENV == "production"


def test_development_allows_defaults():
    # Non-production must NOT raise even on the dev default secrets.
    s = Settings(ENV="development", JWT_SECRET=DEV_DEFAULT_SECRET, FLEET_WEBHOOK_SECRET=DEV_DEFAULT_SECRET)
    assert s.JWT_SECRET == DEV_DEFAULT_SECRET
