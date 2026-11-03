#!/usr/bin/env python3
"""Écriture conditionnelle du worker (compare-and-swap sur updated_at).

PostgREST simulé : une page écrit le dossier entre la relecture du worker et
son écriture ; le worker doit relire, refusionner et ne rien effacer.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from urllib.parse import parse_qs

import httpx

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

from import_job_worker import _merge_workspace_lines  # noqa: E402
from supabase_service import SupabaseService  # noqa: E402


class FakePostgrest:
    def __init__(self) -> None:
        self.rows: dict[int, dict] = {}
        self.before_write = None
        self.patches = 0
        self.tick = 0

    def stamp(self) -> str:
        self.tick += 1
        return f"2026-11-03T03:00:00.{self.tick:06d}+00:00"

    def handler(self, request: httpx.Request) -> httpx.Response:
        query = {k: v[0] for k, v in parse_qs(request.url.query.decode()).items()}
        dossier_id = int(query.get("dossier_id", "eq.0")[3:]) if "dossier_id" in query else None
        if request.method == "GET":
            row = self.rows.get(dossier_id)
            return httpx.Response(200, json=[row] if row else [])
        if self.before_write:
            hook, self.before_write = self.before_write, None
            hook()
        body = json.loads(request.content or b"{}")
        if request.method == "PATCH":
            self.patches += 1
            row = self.rows.get(dossier_id)
            if not row or f"eq.{row['updated_at']}" != query.get("updated_at"):
                return httpx.Response(200, json=[])
            row.update(body)
            return httpx.Response(200, json=[row])
        if request.method == "POST":
            if body["dossier_id"] in self.rows:
                return httpx.Response(409, json={"code": "23505"})
            self.rows[body["dossier_id"]] = {"lines": [], "bank_transactions": [], "bank_meta": {}, **body}
            return httpx.Response(201)
        return httpx.Response(405)


def line(sid: str, **extra) -> dict:
    return {"source_id": sid, "source_file": f"{sid}.pdf", "m_ht": 100.0, **extra}


async def scenario() -> None:
    fake = FakePostgrest()
    client = httpx.AsyncClient(transport=httpx.MockTransport(fake.handler))
    db = SupabaseService(client)

    # 1. Une page enregistre une modification entre la relecture et l'écriture.
    fake.rows[1] = {"dossier_id": 1, "lines": [line("a")], "bank_transactions": [], "bank_meta": {}, "updated_at": fake.stamp()}

    def page_edit() -> None:
        fake.rows[1].update({"lines": [line("a", m_ht=999.0)], "updated_at": fake.stamp()})

    fake.before_write = page_edit
    new_lines = [line("b", taux=0.2), line("b", taux=0.1)]
    saved = await db.update_workspace(1, lambda cur: {"lines": _merge_workspace_lines(cur["lines"], new_lines)})
    stored = fake.rows[1]["lines"]
    assert [l["source_id"] for l in stored] == ["a", "b", "b"], stored
    assert stored[0]["m_ht"] == 999.0, "modification de la page conservée"
    assert fake.patches == 2, "1er essai refusé, 2e accepté"
    assert saved["lines"] == stored

    # 2. Relevé importé : les lignes ne sont pas réécrites.
    def page_edit_2() -> None:
        fake.rows[1].update({"lines": [line("a", m_ht=1.0)], "updated_at": fake.stamp()})

    fake.before_write = page_edit_2
    await db.save_workspace(1, lines=None, bank_transactions=[{"id": 1}], bank_meta={"filename": "r.pdf"})
    assert fake.rows[1]["lines"] == [line("a", m_ht=1.0)], fake.rows[1]["lines"]
    assert fake.rows[1]["bank_transactions"] == [{"id": 1}]

    # 3. Dossier sans ligne en base, créé par une page au même moment.
    def page_create() -> None:
        fake.rows[2] = {"dossier_id": 2, "lines": [line("p")], "bank_transactions": [], "bank_meta": {}, "updated_at": fake.stamp()}

    fake.before_write = page_create
    await db.update_workspace(2, lambda cur: {"lines": _merge_workspace_lines(cur["lines"], [line("w")])})
    assert [l["source_id"] for l in fake.rows[2]["lines"]] == ["p", "w"], fake.rows[2]["lines"]

    # 4. Le jeton de version avance toujours.
    before = fake.rows[1]["updated_at"]
    fake.rows[1]["updated_at"] = "2099-01-01T00:00:00+00:00"
    await db.save_workspace(1, lines=[line("z")])
    assert fake.rows[1]["updated_at"] > "2099-01-01T00:00:00+00:00", fake.rows[1]["updated_at"]
    assert before

    await client.aclose()


def main() -> int:
    asyncio.run(scenario())
    print("OK test_workspace_cas")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
