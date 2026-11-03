#!/usr/bin/env python3
"""Worker de bout en bout : un import avec une facture lue et une illisible.

Vérifie que la facture illisible est marquée « failed » avec une raison, que
le fichier n'est pas déclaré « terminé » à tort, et que la lue est « done ».
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import import_job_worker  # noqa: E402
from models import ExtractionResult, InvoiceLine  # noqa: E402


class FakeDb:
    def __init__(self) -> None:
        self.workspace = {"lines": [], "bank_transactions": [], "bank_meta": {}, "updated_at": None}
        self.marks: list[dict] = []
        self.job_files: dict[int, dict] = {}
        self.job: dict = {}

    async def fetch_job_files(self, job_id):
        return [
            {"id": 1, "storage_path": "q/ok.pdf", "original_filename": "ok.pdf", "mime_type": "application/pdf", "source_id": "src-ok"},
            {"id": 2, "storage_path": "q/flou.jpg", "original_filename": "flou.jpg", "mime_type": "image/jpeg", "source_id": "src-flou"},
        ]

    async def download_storage_file(self, bucket, path):
        return path.encode()

    async def save_dossier_document(self, dossier_id, **kwargs):
        return {"id": 99, "source_id": kwargs.get("source_id")}

    async def load_workspace(self, dossier_id):
        return dict(self.workspace)

    async def update_workspace(self, dossier_id, mutate):
        self.workspace.update(mutate(dict(self.workspace)))
        return dict(self.workspace)

    async def mark_document_extraction(self, dossier_id, **kwargs):
        self.marks.append(kwargs)
        return True

    async def update_job(self, job_id, patch):
        self.job.update(patch)

    async def update_job_file(self, file_id, patch):
        self.job_files.setdefault(file_id, {}).update(patch)

    async def get_dossier_client_id(self, dossier_id):
        return None

    async def touch_dossier_status(self, dossier_id, count):
        pass

    async def log_activity(self, *args, **kwargs):
        pass


async def fake_extract(filename, content, mime):
    if "flou" in filename:
        return ExtractionResult(filename=filename, lines=[], warnings=[], engine="ai")
    return ExtractionResult(
        filename=filename,
        engine="ai",
        lines=[InvoiceLine(fact_num="F1", m_ht=100, tva=20, m_ttc=120, taux=0.2, lib_frss="ALPHA")],
    )


async def scenario() -> None:
    import_job_worker.extract_invoice = fake_extract
    db = FakeDb()
    out = await import_job_worker.process_invoice_import_job({"id": 5, "dossier_id": 7, "options": {}}, db)

    assert out["status"] == "completed", out
    assert len(db.workspace["lines"]) == 1
    marks = {m["source_id"]: m for m in db.marks}
    assert marks["src-ok"]["status"] == "done", marks
    assert marks["src-flou"]["status"] == "failed", marks
    assert "Aucune facture reconnue" in marks["src-flou"]["error"], marks
    assert db.job_files[1]["status"] == "done" and db.job_files[1]["line_count"] == 1, db.job_files
    assert db.job_files[2]["status"] == "failed" and db.job_files[2]["line_count"] == 0, db.job_files
    assert db.job["failed_files"] == 1 and "1 fichier(s) en erreur" in (db.job["error_summary"] or ""), db.job


def main() -> int:
    asyncio.run(scenario())
    print("OK test_worker_unread_e2e")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
