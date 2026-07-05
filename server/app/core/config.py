from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEV_DEFAULT_SECRET = "dev-only-change-me"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # "production" refuses to start on the dev-default secrets below (P3). Any
    # other value (default "development") keeps the convenient dev defaults.
    ENV: str = "development"
    DATABASE_URL: str = "postgresql+psycopg2://ai_guard:ai_guard@postgres:5432/ai_guard"
    REDIS_URL: str = "redis://redis:6379/0"
    JWT_SECRET: str = DEV_DEFAULT_SECRET
    JWT_EXPIRE_MINUTES: int = 8 * 60
    # Both must be set for the seed to run; unset means "no dev admin" rather than a hardcoded default.
    SEED_ADMIN_EMAIL: str | None = None
    SEED_ADMIN_PASSWORD: str | None = None
    FLEET_WEBHOOK_SECRET: str = DEV_DEFAULT_SECRET
    # P7: delete guard_events older than this many days on startup / via the
    # prune endpoint. 0 disables retention (keep everything) -- opt-in so an
    # existing deployment never silently loses data on upgrade.
    EVENT_RETENTION_DAYS: int = 0
    # P10: if set, high-severity events (blocks / grade C) are POSTed here as a
    # JSON alert (Slack-compatible / generic SIEM webhook). Unset = no alerts.
    ALERT_WEBHOOK_URL: str | None = None

    @model_validator(mode="after")
    def _forbid_default_secrets_in_production(self):
        # Fail fast rather than silently run production with a predictable,
        # source-controlled secret that would let anyone forge admin JWTs /
        # fleet webhooks. Only enforced when ENV=production.
        if self.ENV.lower() == "production":
            offenders = [
                name for name, value in (
                    ("JWT_SECRET", self.JWT_SECRET),
                    ("FLEET_WEBHOOK_SECRET", self.FLEET_WEBHOOK_SECRET),
                )
                if value == DEV_DEFAULT_SECRET
            ]
            if offenders:
                raise ValueError(
                    "Refusing to start with default "
                    + ", ".join(offenders)
                    + " while ENV=production; set them to strong secrets via environment."
                )
        return self


settings = Settings()
