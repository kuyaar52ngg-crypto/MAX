"""anti_ban package: rate limiting, state monitoring, audit and watchdog
infrastructure protecting the GREEN-API instance from behavioural bans.

This package is built incrementally. The first module exposes the
configuration dataclass and the ``Instance_State`` constants used by the
rest of the system.
"""

from anti_ban.config import (
    AntiBanConfig,
    HEALTHY,
    UNHEALTHY,
    NEUTRAL,
    UNKNOWN,
)

__all__ = [
    "AntiBanConfig",
    "HEALTHY",
    "UNHEALTHY",
    "NEUTRAL",
    "UNKNOWN",
]
