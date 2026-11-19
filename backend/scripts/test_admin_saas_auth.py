from __future__ import annotations

import asyncio
import os
from unittest.mock import patch

from fastapi import HTTPException

import admin_saas


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code

    def json(self):
        return self.payload


class FakeAsyncClient:
    def __init__(self, responses, **_kwargs):
        self.responses = list(responses)
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, url, *, headers, params=None):
        self.calls.append({"url": url, "headers": headers, "params": params})
        return self.responses.pop(0)


def test_super_admin_role_is_required() -> None:
    async def run():
        fake = FakeAsyncClient([
            FakeResponse({"id": "user-1"}),
            FakeResponse([{"role": "super_admin"}]),
        ])
        with patch.dict(os.environ, {"SUPABASE_ANON_KEY": "public-key"}):
            with patch.object(admin_saas.httpx, "AsyncClient", return_value=fake):
                user = await admin_saas.require_super_admin("Bearer valid-token")
        assert user["id"] == "user-1"
        assert fake.calls[0]["url"].endswith("/auth/v1/user")
        assert fake.calls[1]["url"].endswith("/rest/v1/user_roles")
        assert fake.calls[1]["params"]["user_id"] == "eq.user-1"

    asyncio.run(run())


def test_authenticated_non_admin_is_forbidden() -> None:
    async def run():
        fake = FakeAsyncClient([
            FakeResponse({"id": "user-2"}),
            FakeResponse([{"role": "member"}]),
        ])
        with patch.dict(os.environ, {"SUPABASE_ANON_KEY": "public-key"}):
            with patch.object(admin_saas.httpx, "AsyncClient", return_value=fake):
                try:
                    await admin_saas.require_super_admin("Bearer member-token")
                except HTTPException as exc:
                    assert exc.status_code == 403
                else:
                    raise AssertionError("Un membre non-admin a été autorisé")

    asyncio.run(run())


def main() -> None:
    test_super_admin_role_is_required()
    test_authenticated_non_admin_is_forbidden()
    print("OK test_admin_saas_auth")


if __name__ == "__main__":
    main()
