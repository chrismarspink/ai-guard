from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_URL: str = "postgresql+psycopg2://ai_guard:ai_guard@postgres:5432/ai_guard"
    REDIS_URL: str = "redis://redis:6379/0"
    JWT_SECRET: str = "dev-only-change-me"
    JWT_EXPIRE_MINUTES: int = 8 * 60
    # Both must be set for the seed to run; unset means "no dev admin" rather than a hardcoded default.
    SEED_ADMIN_EMAIL: str | None = None
    SEED_ADMIN_PASSWORD: str | None = None
    FLEET_WEBHOOK_SECRET: str = "dev-only-change-me"


settings = Settings()
