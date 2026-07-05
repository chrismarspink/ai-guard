"""P10: high-severity DLP alerting.

Best-effort, fire-and-forget POST to a configured webhook (Slack-compatible /
generic SIEM HTTP collector). Dispatched via FastAPI BackgroundTasks so it
never adds latency to, or fails, event ingestion.
"""
from __future__ import annotations

import logging

from app.core.config import settings

log = logging.getLogger("ai-guard.alerts")


def dispatch_alert(payload: dict) -> None:
    url = settings.ALERT_WEBHOOK_URL
    if not url:
        return
    try:
        import httpx

        # A Slack incoming-webhook renders `text`; a plain SIEM collector just
        # stores the whole JSON body -- send both so either consumer works.
        summary = (
            f"[ai-guard] {payload.get('type')} "
            f"grade={payload.get('grade')} site={payload.get('site')} "
            f"user={payload.get('user') or 'unknown'}"
        )
        with httpx.Client(timeout=3.0) as client:
            client.post(url, json={"text": summary, **payload})
    except Exception as exc:  # noqa: BLE001 -- alerting must never break ingestion
        log.warning("alert dispatch failed: %s", exc)
