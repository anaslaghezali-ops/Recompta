#!/usr/bin/env python3
"""Authentification des routes /api.

Supabase simulé (Auth + PostgREST avec RLS) : un appel anonyme, un compte sans
cabinet ou un membre d'un autre cabinet ne doit jamais atteindre le traitement.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from urllib.parse import parse_qs

import httpx

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "service-test"
os.environ["SUPABASE_ANON_KEY"] = "anon-test"
os.environ["IMPORT_WORKER_ENABLED"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import main  # noqa: E402

# jeton → (user_id, rôle, cabinet, dossiers visibles, jobs visibles)
USERS = {
    "tok-alice": {"id": "u-alice", "role": None, "member": True, "dossiers": {1}, "jobs": {10}},
    "tok-bob": {"id": "u-bob", "role": None, "member": True, "dossiers": {2}, "jobs": {20}},
    "tok-orphan": {"id": "u-orphan", "role": None, "member": False, "dossiers": set(), "jobs": set()},
    "tok-admin": {"id": "u-admin", "role": "super_admin", "member": False, "dossiers": {1, 2}, "jobs": {10, 20}},
}
calls: list[str] = []


def fake_supabase(request: httpx.Request) -> httpx.Response:
    calls.append(request.url.path)
    assert request.headers.get("apikey") == "anon-test", "apikey = clé anon, jamais service_role"
    token = request.headers.get("authorization", "").removeprefix("Bearer ")
    user = USERS.get(token)
    path = request.url.path
    query = {k: v[0] for k, v in parse_qs(request.url.query.decode()).items()}

    if path == "/auth/v1/user":
        if not user:
            return httpx.Response(401, json={"msg": "invalid JWT"})
        return httpx.Response(200, json={"id": user["id"], "email": f"{user['id']}@test.ma"})
    if not user:
        return httpx.Response(401, json={"message": "JWT invalid"})
    if path == "/rest/v1/user_roles":
        return httpx.Response(200, json=[{"role": user["role"]}] if user["role"] else [])
    if path == "/rest/v1/cabinet_members":
        return httpx.Response(200, json=[{"cabinet_id": 1}] if user["member"] else [])
    if path == "/rest/v1/client_dossiers":
        wanted = int(query["id"].removeprefix("eq."))
        return httpx.Response(200, json=[{"id": wanted}] if wanted in user["dossiers"] else [])
    if path == "/rest/v1/import_jobs":
        wanted = int(query["id"].removeprefix("eq."))
        return httpx.Response(200, json=[{"id": wanted}] if wanted in user["jobs"] else [])
    return httpx.Response(404, json={})


auth._transport = httpx.MockTransport(fake_supabase)
client = TestClient(main.app)

PDF = {"file": ("f.pdf", b"%PDF-1.4 test", "application/pdf")}
PDFS = {"files": ("f.pdf", b"%PDF-1.4 test", "application/pdf")}


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def check(label: str, response: httpx.Response, expected: int) -> None:
    assert response.status_code == expected, f"{label}: {response.status_code} ≠ {expected} — {response.text}"
    print(f"  ok  {label} → {expected}")


def test_anonymous_is_rejected() -> None:
    check("extract sans jeton", client.post("/api/extract", files=PDFS), 401)
    check("relevé sans jeton", client.post("/api/import-bank-statement", files=PDF), 401)
    check("upload sans jeton", client.post("/api/import-jobs/10/upload", files=PDF), 401)
    check("analyze sans jeton", client.post("/api/dossiers/1/analyze"), 401)
    check("process sans jeton", client.post("/api/import-jobs/process"), 401)
    check("extract jeton invalide", client.post("/api/extract", files=PDFS, headers=bearer("faux")), 401)
    check(
        "en-tête non Bearer",
        client.post("/api/import-jobs/process", headers={"Authorization": "Basic abc"}),
        401,
    )


def test_account_without_cabinet_cannot_spend_ai() -> None:
    headers = bearer("tok-orphan")
    check("extract sans cabinet", client.post("/api/extract", files=PDFS, headers=headers), 403)
    check("relevé sans cabinet", client.post("/api/import-bank-statement", files=PDF, headers=headers), 403)
    check("process sans cabinet", client.post("/api/import-jobs/process", headers=headers), 403)


def test_other_cabinet_is_invisible() -> None:
    bob = bearer("tok-bob")
    check("upload job d'un autre cabinet", client.post("/api/import-jobs/10/upload", files=PDF, headers=bob), 404)
    check("analyze dossier d'un autre cabinet", client.post("/api/dossiers/1/analyze", headers=bob), 404)
    check("upload job inexistant", client.post("/api/import-jobs/999/upload", files=PDF, headers=bob), 404)


def test_authorized_calls_pass_the_gate() -> None:
    # Worker désactivé dans ce test : 503 « Worker inactif » prouve que le
    # contrôle d'accès est passé et que la route a été exécutée.
    for token in ("tok-alice", "tok-admin"):
        headers = bearer(token)
        check(f"upload autorisé ({token})", client.post("/api/import-jobs/10/upload", files=PDF, headers=headers), 503)
        check(f"analyze autorisé ({token})", client.post("/api/dossiers/1/analyze", headers=headers), 503)
        check(f"process autorisé ({token})", client.post("/api/import-jobs/process", headers=headers), 503)

    # Type non supporté : la route s'exécute sans appel IA et répond normalement.
    response = client.post(
        "/api/extract",
        files={"files": ("notes.txt", b"hello", "text/plain")},
        headers=bearer("tok-alice"),
    )
    check("extract autorisé", response, 200)
    assert response.json()[0]["warnings"], response.json()


def test_public_routes_stay_public() -> None:
    check("reference", client.get("/api/reference"), 200)
    check("health", client.get("/api/health"), 200)


def test_session_is_cached() -> None:
    auth.clear_auth_cache()
    calls.clear()
    for _ in range(5):
        client.post("/api/import-jobs/process", headers=bearer("tok-alice"))
    assert calls.count("/auth/v1/user") == 1, calls
    print("  ok  jeton validé une seule fois sur 5 appels")


def test_missing_keys_fail_closed() -> None:
    auth.clear_auth_cache()
    saved = {k: os.environ.pop(k) for k in ("SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY")}
    try:
        check("clés absentes", client.post("/api/import-jobs/process", headers=bearer("tok-alice")), 503)
    finally:
        os.environ.update(saved)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            print(name)
            fn()
    print("OK")
