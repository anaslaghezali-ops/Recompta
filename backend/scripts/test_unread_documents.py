#!/usr/bin/env python3
"""Statut de lecture par document : raison lisible, marquage, migration absente."""

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

import supabase_service  # noqa: E402
from dossier_analysis import _extraction_settled  # noqa: E402
from import_job_worker import extraction_marks, failure_reason  # noqa: E402
from models import ExtractionResult, InvoiceLine  # noqa: E402
from supabase_service import SupabaseService  # noqa: E402


def result(sid: str, lines: int = 0, warnings: list[str] | None = None) -> ExtractionResult:
    return ExtractionResult(
        filename=f"{sid}.pdf",
        source_id=sid,
        warnings=warnings or [],
        lines=[InvoiceLine(fact_num=f"F{i}", m_ht=100, tva=20, m_ttc=120) for i in range(lines)],
    )


def test_reasons() -> None:
    assert "illisible" in failure_reason(result("a", warnings=["Aucune ligne extraite — vérifiez le scan ou relancez l'extraction."]))
    assert "répondu à temps" in failure_reason(None, TimeoutError("x"))
    assert "relancez" in failure_reason(result("a", warnings=["Extraction échouée : HTTPStatusError: 500"]))
    assert failure_reason(result("a", warnings=["PDF protégé par mot de passe"])) == "PDF protégé par mot de passe"


def test_marks_per_file() -> None:
    items = [{"source_id": "a"}, {"source_id": "b"}, {"source_id": "c"}]
    marks = extraction_marks(
        items,
        {"a": result("a", lines=2), "b": result("b"), "c": result("c")},
        {"c": RuntimeError("boom")},
    )
    by_ref = {m["ref"]: m for m in marks}
    assert by_ref["a"]["status"] == "done" and by_ref["a"]["error"] is None
    assert by_ref["b"]["status"] == "failed" and "Aucune facture" in by_ref["b"]["error"]
    assert by_ref["c"]["status"] == "failed" and "RuntimeError" in by_ref["c"]["error"]


def test_marks_analysis_zip_as_one_document() -> None:
    items = [{"source_id": "z1"}, {"source_id": "z2"}]
    marks = extraction_marks(items, {"z1": result("z1"), "z2": result("z2", lines=1)}, {}, document_id=42)
    assert marks == [{"kind": "doc", "ref": 42, "status": "done", "error": None}]


def test_settled_documents_are_not_requeued() -> None:
    assert _extraction_settled({"extraction_status": "ignored"})
    assert _extraction_settled({"extraction_status": "done"})
    assert not _extraction_settled({"extraction_status": "failed"})
    assert not _extraction_settled({})


async def _mark_scenarios() -> None:
    rows = {
        1: {"id": 1, "dossier_id": 7, "source_id": "a", "extraction_attempts": 1, "extraction_status": "failed"},
        2: {"id": 2, "dossier_id": 7, "source_id": "b", "extraction_attempts": 0, "extraction_status": "ignored"},
    }
    missing_columns = {"on": False}

    def handler(request: httpx.Request) -> httpx.Response:
        if missing_columns["on"]:
            return httpx.Response(400, json={"code": "42703", "message": 'column "extraction_attempts" does not exist'})
        q = {k: v[0] for k, v in parse_qs(request.url.query.decode()).items()}
        if request.method == "GET":
            found = [r for r in rows.values() if f"eq.{r['source_id']}" == q.get("source_id") or f"eq.{r['id']}" == q.get("id")]
            return httpx.Response(200, json=found)
        if request.method == "PATCH":
            rows[int(q["id"][3:])].update(json.loads(request.content))
            return httpx.Response(204)
        return httpx.Response(405)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    db = SupabaseService(client)

    assert await db.mark_document_extraction(7, status="done", source_id="a")
    assert rows[1]["extraction_status"] == "done" and rows[1]["extraction_error"] is None
    assert rows[1]["extraction_attempts"] == 2

    assert await db.mark_document_extraction(7, status="failed", source_id="a", error="Scan illisible")
    assert rows[1]["extraction_error"] == "Scan illisible"

    # Écarté par l'utilisateur : le worker ne le remet pas en « échec ».
    assert not await db.mark_document_extraction(7, status="failed", source_id="b", error="x")
    assert rows[2]["extraction_status"] == "ignored"

    # Migration pas encore exécutée : aucune exception, l'import continue.
    missing_columns["on"] = True
    assert not await db.mark_document_extraction(7, status="done", source_id="a")
    assert supabase_service._EXTRACTION_STATUS_SUPPORTED is False
    supabase_service._EXTRACTION_STATUS_SUPPORTED = True

    await client.aclose()


def main() -> int:
    test_reasons()
    test_marks_per_file()
    test_marks_analysis_zip_as_one_document()
    test_settled_documents_are_not_requeued()
    asyncio.run(_mark_scenarios())
    print("OK test_unread_documents")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
