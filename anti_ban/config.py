"""Configuration dataclass and Instance_State constants for anti-ban protection.

This module defines the immutable :class:`AntiBanConfig` dataclass holding
all tunable parameters (delays, limits, watchdog timings, etc.) used by the
rest of the ``anti_ban`` package, and the four constants describing the
GREEN-API ``stateInstance`` value space:

* :data:`HEALTHY`   – states in which bulk operations may run.
* :data:`UNHEALTHY` – states that must abort any active bulk operation.
* :data:`NEUTRAL`   – states that neither block nor guarantee operation.
* :data:`UNKNOWN`   – sentinel string for missing or malformed responses.

Defaults match Requirement 9.2 of the ``anti-ban-protection`` spec and the
``AntiBanConfig`` block of the design document.
"""

from __future__ import annotations

from dataclasses import dataclass

__all__ = [
    "AntiBanConfig",
    "HEALTHY",
    "UNHEALTHY",
    "NEUTRAL",
    "UNKNOWN",
]


@dataclass(frozen=True)
class AntiBanConfig:
    """Immutable configuration for anti-ban protection.

    Field names and defaults mirror the ``AntiBanConfig`` Prisma model and
    the Python dataclass defined in ``design.md``. The dataclass is frozen
    so it can be safely shared across worker threads without locking.
    """

    # --- Per-request pacing (Requirement 1.2, 1.6) ------------------------
    delay_min: float = 3.0
    delay_max: float = 7.0

    # --- Batching and long pauses (Requirement 1.1, 1.7) ------------------
    batch_size: int = 50
    long_pause_every_n: int = 50
    long_pause_seconds: float = 60.0

    # --- Volume caps (Requirement 1.4, 1.5, 2.4) --------------------------
    daily_check_limit: int = 1000
    hourly_check_limit: int = 200
    daily_message_limit: int = 500

    # --- Broadcast-specific pacing (Requirement 2.1, 2.2, 2.3) ------------
    broadcast_delay_min: float = 5.0
    broadcast_jitter_max: float = 3.0

    # --- State monitor / watchdog (Requirement 3.2, 5.3, 5.4) -------------
    state_poll_interval_seconds: int = 30
    watchdog_timeout_seconds: int = 120
    watchdog_check_interval_seconds: int = 10
    cancel_check_interval_seconds: float = 1.0
    sse_client_timeout_seconds: int = 60

    # --- Retry / backoff policy (Requirement 4.1, 4.2, 4.3) ---------------
    max_retries: int = 5
    max_consecutive_429: int = 3

    # --- Sliding-window rate limit (Requirement 1.3) ----------------------
    sliding_window_n: int = 20
    sliding_window_t: int = 60

    # --- Audit / incident log (Requirement 8.3) ---------------------------
    incident_history_limit: int = 100

    # --- Backoff base (Requirement 4.1) -----------------------------------
    backoff_base_seconds: float = 5.0

    # --- Zero-response-ratio warning (Requirement 2.5) --------------------
    response_ratio_window_hours: int = 24
    response_ratio_min_outgoing: int = 50
    warn_on_zero_response_ratio: bool = True


# --- Instance_State constants -------------------------------------------------
#
# Values follow the GREEN-API ``getStateInstance`` contract:
# https://green-api.com/v3/docs/api/account/GetStateInstance/
#
# ``frozenset`` is used so the constants are hashable, immutable, and safe
# to share across threads without copying. ``UNKNOWN`` is a sentinel string
# returned by ``State_Monitor`` when the API errors out or returns an
# unexpected payload (Requirement 3.6).

HEALTHY: frozenset[str] = frozenset({"authorized"})
UNHEALTHY: frozenset[str] = frozenset({"yellowCard", "blocked", "notAuthorized"})
NEUTRAL: frozenset[str] = frozenset({"starting", "sleepMode"})
UNKNOWN: str = "unknown"
