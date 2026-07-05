from app.core.config import settings

_client = None
_unavailable = False


def _get_client():
    # Lazy + sticky-failure: Redis is a cache, not a source of truth here, so
    # a dev/test environment without Redis running must not break the API.
    global _client, _unavailable
    if _unavailable:
        return None
    if _client is None:
        try:
            import redis

            candidate = redis.Redis.from_url(
                settings.REDIS_URL, socket_connect_timeout=0.2, socket_timeout=0.2
            )
            candidate.ping()
            _client = candidate
        except Exception:
            _unavailable = True
            return None
    return _client


def cache_get(key: str) -> str | None:
    client = _get_client()
    if client is None:
        return None
    try:
        value = client.get(key)
        return value.decode("utf-8") if value is not None else None
    except Exception:
        return None


def cache_set(key: str, value: str, ex: int = 300) -> None:
    client = _get_client()
    if client is None:
        return
    try:
        client.set(key, value, ex=ex)
    except Exception:
        pass


def cache_delete(key: str) -> None:
    client = _get_client()
    if client is None:
        return
    try:
        client.delete(key)
    except Exception:
        pass


def incr_with_expiry(key: str, window_sec: int) -> int:
    """Atomic INCR that sets the TTL on first hit -- for fixed-window rate
    limiting. Returns the running count, or 0 when Redis is unavailable (so a
    missing cache degrades to "no limit" rather than blocking requests)."""
    client = _get_client()
    if client is None:
        return 0
    try:
        count = client.incr(key)
        if count == 1:
            client.expire(key, window_sec)
        return int(count)
    except Exception:
        return 0
