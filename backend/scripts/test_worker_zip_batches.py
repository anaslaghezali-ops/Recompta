#!/usr/bin/env python3
"""Vérifie que le worker traite les membres ZIP avec la taille de lot configurée."""

from __future__ import annotations

import asyncio
from io import BytesIO
from pathlib import Path
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import import_job_worker  # noqa: E402
from models import ExtractionResult, InvoiceLine  # noqa: E402


class FakeDb:
    client = None

    def __init__(self, archive: bytes) -> None:
        self.archive = archive
        self.workspace = {"lines": [], "bank_transactions": [], "bank_meta": {}, "updated_at": None}
        self.job: dict = {}
        self.job_files: dict[int, dict] = {}
        self.saved_documents: list[str] = []
        self.marks: list[dict] = []

    async def fetch_job_files(self, job_id):
        return [{
            "id": 10,
            "storage_path": "queue/factures.zip",
            "original_filename": "factures.zip",
            "mime_type": "application/zip",
            "source_id": "src-parent",
        }]

    async def download_storage_file(self, bucket, path):
        return self.archive

    async def save_dossier_document(self, dossier_id, **kwargs):
        self.saved_documents.append(kwargs["filename"])
        return {"id": len(self.saved_documents), "source_id": kwargs.get("source_id")}

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

    async def list_client_suppliers(self, client_id):
        return []


def make_archive() -> bytes:
    stream = BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
        payload = b"%PDF-" + bytes(range(1, 250)) * 3
        for name in ("a.pdf", "b.pdf", "c.pdf"):
            archive.writestr(name, payload)
    return stream.getvalue()


async def scenario() -> None:
    active = 0
    maximum_active = 0
    calls: list[str] = []

    async def fake_extract(filename, content, mime):
        nonlocal active, maximum_active
        active += 1
        maximum_active = max(maximum_active, active)
        calls.append(filename)
        await asyncio.sleep(0.005)
        active -= 1
        return ExtractionResult(
            filename=filename,
            engine="ai",
            lines=[
                InvoiceLine(
                    fact_num=filename,
                    m_ht=100,
                    tva=20,
                    m_ttc=120,
                    taux=0.2,
                    lib_frss="FOURNISSEUR",
                )
            ],
        )

    async def fake_cabinet(dossier_id, client=None):
        return 1

    old_extract = import_job_worker.extract_invoice
    old_cabinet = import_job_worker.cabinet_id_for_dossier
    old_batch_size = import_job_worker.IMPORT_EXTRACTION_BATCH_SIZE
    old_slots = import_job_worker._extraction_slots
    try:
        import_job_worker.extract_invoice = fake_extract
        import_job_worker.cabinet_id_for_dossier = fake_cabinet
        import_job_worker.IMPORT_EXTRACTION_BATCH_SIZE = 1
        import_job_worker._extraction_slots = asyncio.Semaphore(12)

        db = FakeDb(make_archive())
        result = await import_job_worker.process_invoice_import_job(
            {"id": 5, "dossier_id": 7, "options": {}}, db
        )

        assert result["status"] == "completed", result
        assert len(calls) == 3, calls
        assert maximum_active == 1, maximum_active
        assert len(db.saved_documents) == 3, db.saved_documents
        assert len(db.workspace["lines"]) == 3, db.workspace["lines"]
        assert db.job_files[10]["status"] == "done", db.job_files
        assert db.job["failed_files"] == 0, db.job
    finally:
        import_job_worker.extract_invoice = old_extract
        import_job_worker.cabinet_id_for_dossier = old_cabinet
        import_job_worker.IMPORT_EXTRACTION_BATCH_SIZE = old_batch_size
        import_job_worker._extraction_slots = old_slots


def main() -> int:
    asyncio.run(scenario())
    print("OK test_worker_zip_batches")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
