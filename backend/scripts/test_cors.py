#!/usr/bin/env python3
"""Vérifie les origines CORS autorisées par le serveur (sans réseau)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Avant l'import de main : load_dotenv ne remplace pas une variable déjà définie.
os.environ["OPENAI_API_KEY"] = ""
os.environ["CORS_ALLOWED_ORIGINS"] = ""
os.environ["IMPORT_WORKER_ENABLED"] = "0"

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

try:
    from fastapi.testclient import TestClient
except Exception:  # noqa: BLE001  (httpx absent)
    from starlette.testclient import TestClient

import main

GH_PAGES = "https://anaslaghezali-ops.github.io"
CODESPACE = "https://abc-8000.app.github.dev"
LOCAL = "http://localhost:5500"
LOCAL_IP = "http://127.0.0.1:8000"
EVIL = "https://evil.example"
VPS = "https://vps.example.ma"


def preflight(client, origin: str):
    return client.options(
        "/api/health",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )


def assert_allowed(client, origin: str) -> None:
    r = preflight(client, origin)
    assert r.status_code == 200, (origin, r.status_code, r.text)
    assert r.headers.get("access-control-allow-origin") == origin, (origin, dict(r.headers))
    r = client.get("/api/health", headers={"Origin": origin})
    assert r.status_code == 200, (origin, r.status_code)
    assert r.headers.get("access-control-allow-origin") == origin, (origin, dict(r.headers))
    assert "access-control-allow-credentials" not in r.headers
    assert "content-disposition" in r.headers.get("access-control-expose-headers", "").lower()


def assert_refused(client, origin: str) -> None:
    r = preflight(client, origin)
    assert "access-control-allow-origin" not in r.headers, (origin, dict(r.headers))
    r = client.get("/api/health", headers={"Origin": origin})
    assert "access-control-allow-origin" not in r.headers, (origin, dict(r.headers))


def small_app(env: dict[str, str]) -> TestClient:
    app = FastAPI()

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    app.add_middleware(CORSMiddleware, **main.cors_settings(env))
    return TestClient(app)


def test_default_origins_on_real_app() -> None:
    client = TestClient(main.app)  # sans "with" : pas de démarrage du worker
    for origin in (GH_PAGES, CODESPACE, LOCAL, LOCAL_IP):
        assert_allowed(client, origin)
    for origin in (
        EVIL,
        VPS,
        "https://anaslaghezali-ops.github.io.evil.example",
        "https://evil.app.github.dev.evil.example",
        "http://localhost.evil.example",
        "https://localhost:5500",
    ):
        assert_refused(client, origin)
    # Requête sans Origin (même origine / curl) : rien ne change.
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert r.json()["ai_configured"] is False


def test_extra_origin_from_env() -> None:
    client = small_app({"CORS_ALLOWED_ORIGINS": f" {VPS}/ , https://autre.example.ma"})
    for origin in (VPS, "https://autre.example.ma", GH_PAGES, CODESPACE, LOCAL):
        assert_allowed(client, origin)
    assert_refused(client, EVIL)


def test_star_restores_old_behaviour() -> None:
    settings = main.cors_settings({"CORS_ALLOWED_ORIGINS": "*"})
    assert settings["allow_origins"] == ["*"] and settings["allow_credentials"] is False
    client = small_app({"CORS_ALLOWED_ORIGINS": "*"})
    r = client.get("/api/health", headers={"Origin": EVIL})
    assert r.headers.get("access-control-allow-origin") == "*"


def test_settings_without_env() -> None:
    s = main.cors_settings({})
    assert s["allow_origins"] == [GH_PAGES]
    assert s["allow_credentials"] is False
    assert s["allow_methods"] == ["*"] and s["allow_headers"] == ["*"]
    assert s["expose_headers"] == ["Content-Disposition"]


def main_() -> None:
    test_settings_without_env()
    test_default_origins_on_real_app()
    test_extra_origin_from_env()
    test_star_restores_old_behaviour()
    print("OK test_cors")


if __name__ == "__main__":
    main_()
