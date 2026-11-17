"""Tests unitaires crédits vision (sans réseau)."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vision_credits import ensure_vision_credit_available, get_active_cabinet_id, set_active_cabinet_id


def test_fail_closed_without_cabinet() -> None:
    ok, message = asyncio.run(ensure_vision_credit_available(None))
    assert ok is False
    assert "cabinet" in message.lower() or "crédits" in message.lower()


def test_fail_closed_when_rpc_errors() -> None:
    async def _run() -> None:
        with patch(
            "vision_credits.consume_vision_credit",
            new=AsyncMock(return_value={"ok": False, "error": "Quota épuisé", "remaining": 0, "quota": 1}),
        ):
            ok, message = await ensure_vision_credit_available(42)
            assert ok is False
            assert "0/1" in message

    asyncio.run(_run())


def test_contextvar_set_per_task() -> None:
    async def _run() -> None:
        set_active_cabinet_id(7)

        async def child() -> int | None:
            return get_active_cabinet_id()

        assert await asyncio.create_task(child()) == 7

    asyncio.run(_run())


def test_ok_when_consume_succeeds() -> None:
    async def _run() -> None:
        with patch(
            "vision_credits.consume_vision_credit",
            new=AsyncMock(return_value={"ok": True, "remaining": 0, "quota": 1}),
        ):
            ok, message = await ensure_vision_credit_available(42)
            assert ok is True
            assert message == ""

    asyncio.run(_run())


if __name__ == "__main__":
    test_fail_closed_without_cabinet()
    test_fail_closed_when_rpc_errors()
    test_contextvar_set_per_task()
    test_ok_when_consume_succeeds()
    print("ok")
