from __future__ import annotations

import asyncio
from pathlib import Path
import sys
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import request_auth


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code

    def json(self):
        return self.payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError(f"Unexpected HTTP status {self.status_code}")


class FakeAsyncClient:
    def __init__(self, response, **_kwargs):
        self.response = response
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, url, *, headers, params=None):
        self.calls.append({"url": url, "headers": headers, "params": params})
        return self.response


def make_request(headers: dict[str, str]) -> Request:
    raw_headers = [(key.lower().encode(), value.encode()) for key, value in headers.items()]
    return Request({
        "type": "http",
        "http_version": "1.1",
        "method": "POST",
        "scheme": "https",
        "path": "/api/test",
        "raw_path": b"/api/test",
        "query_string": b"",
        "headers": raw_headers,
        "server": ("test", 443),
        "client": ("127.0.0.1", 12345),
    })


def test_authentication_requires_bearer_token() -> None:
    async def run():
        try:
            await request_auth.authenticate_request(make_request({"apikey": "public-key"}))
        except HTTPException as exc:
            assert exc.status_code == 401
        else:
            raise AssertionError("Une requête sans Bearer a été acceptée")
    asyncio.run(run())


def test_authentication_checks_supabase_user_endpoint() -> None:
    async def run():
        fake = FakeAsyncClient(FakeResponse({"id": "user-123"}))
        with patch.object(request_auth.httpx, "AsyncClient", return_value=fake):
            result = await request_auth.authenticate_request(make_request({
                "authorization": "Bearer valid-user-token",
                "apikey": "public-project-key",
            }))
        assert result == {"id": "user-123", "access_token": "valid-user-token"}
        assert fake.calls[0]["url"].endswith("/auth/v1/user")
        assert fake.calls[0]["headers"]["apikey"] == "public-project-key"
        assert fake.calls[0]["headers"]["Authorization"] == "Bearer valid-user-token"
    asyncio.run(run())


def test_dossier_access_uses_user_jwt_and_rls() -> None:
    async def run():
        fake = FakeAsyncClient(FakeResponse([{"id": 42}]))
        with patch.object(request_auth.httpx, "AsyncClient", return_value=fake):
            await request_auth.require_dossier_access(42, "user-token", "public-key")
        assert fake.calls[0]["url"].endswith("/rest/v1/client_dossiers")
        assert fake.calls[0]["params"]["id"] == "eq.42"
        assert fake.calls[0]["headers"]["Authorization"] == "Bearer user-token"
    asyncio.run(run())


def test_inaccessible_dossier_is_not_found() -> None:
    async def run():
        fake = FakeAsyncClient(FakeResponse([]))
        with patch.object(request_auth.httpx, "AsyncClient", return_value=fake):
            try:
                await request_auth.require_dossier_access(999, "user-token", "public-key")
            except HTTPException as exc:
                assert exc.status_code == 404
            else:
                raise AssertionError("Un dossier non accessible a été accepté")
    asyncio.run(run())


def test_import_job_lookup_returns_rls_visible_dossier() -> None:
    async def run():
        fake = FakeAsyncClient(FakeResponse([{"id": 9, "dossier_id": 42, "status": "uploading"}]))
        with patch.object(request_auth.httpx, "AsyncClient", return_value=fake):
            row = await request_auth.require_import_job_access(9, "user-token", "public-key")
        assert row["dossier_id"] == 42
        assert fake.calls[0]["params"]["id"] == "eq.9"
        assert fake.calls[0]["headers"]["Authorization"] == "Bearer user-token"
    asyncio.run(run())


def main() -> None:
    test_authentication_requires_bearer_token()
    test_authentication_checks_supabase_user_endpoint()
    test_dossier_access_uses_user_jwt_and_rls()
    test_inaccessible_dossier_is_not_found()
    test_import_job_lookup_returns_rls_visible_dossier()
    print("OK test_request_auth")


if __name__ == "__main__":
    main()
