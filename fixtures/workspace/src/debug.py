"""A tiny repository for learning the review flow. Not the competition Flask checkout."""

import os


def get_debug_flag() -> bool:
    """Get debug mode. Empty, 0, false and no are treated as false."""
    value = os.environ.get("FLASK_DEBUG", "").lower()
    return value not in ("", "0", "false", "no")
