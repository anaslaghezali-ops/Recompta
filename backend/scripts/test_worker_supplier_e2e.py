#!/usr/bin/env python3
"""Worker de bout en bout : IF / nom complétés depuis le carnet et le dossier."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import import_job_worker  # noqa: E402
from models import ExtractionResult, InvoiceLine  # noqa: E402


class FakeDb:
    client = None

    def __init__(self) -> None:
        # Ligne déjà dans le dossier, IF absent : doit être complétée elle aussi.
        self.workspace = {"lines": [
            {"source_id": "old", "lib_frss": "Achibest", "ice_frs": "000229475000050", "if": "", "fact_num": "FV1", "m_ht": 10, "tva": 2, "m_ttc": 12, "taux": 0.2},
        ], "bank_transactions": [], "bank_meta": {}, "updated_at": None}

    async def fetch_job_files(self, job_id):
        return [{"id": 1, "storage_path": "q/a.pdf", "original_filename": "a.pdf", "mime_type": "application/pdf", "source_id": "src-a"}]

    async def download_storage_file(self, bucket, path):
        return b"%PDF"

    async def save_dossier_document(self, dossier_id, **kwargs):
        return {"id": 1, "source_id": kwargs.get("source_id")}

    async def get_dossier_client_id(self, dossier_id):
        return 1

    async def list_client_suppliers(self, client_id):
        return [{"ice": "000229475000050", "if_number": "1102277", "official_name": "ACHIBEST FOOD SARL"}]

    async def load_workspace(self, dossier_id):
        return dict(self.workspace)

    async def update_workspace(self, dossier_id, mutate):
        self.workspace.update(mutate(dict(self.workspace)))
        return dict(self.workspace)

    async def mark_document_extraction(self, *a, **k):
        return True

    async def update_job(self, *a, **k):
        pass

    async def update_job_file(self, *a, **k):
        pass

    async def touch_dossier_status(self, *a, **k):
        pass

    async def log_activity(self, *a, **k):
        pass


async def fake_extract(filename, content, mime):
    return ExtractionResult(filename=filename, engine="ai", lines=[
        InvoiceLine(fact_num="FV26-032025", m_ht=2755, tva=551, m_ttc=3306, taux=0.2,
                    lib_frss="AICHIBEST FOOD", ice_frs="000229475000050", if_fournisseur="110277"),
        InvoiceLine(fact_num="23-07-2026", m_ht=2755, tva=551, m_ttc=3306, taux=0.2,
                    lib_frss="AICHIBEST FOOD", ice_frs="000229475000050"),
    ])


async def scenario() -> None:
    import_job_worker.extract_invoice = fake_extract

    async def fake_cabinet(dossier_id, client=None):
        return 1

    import_job_worker.cabinet_id_for_dossier = fake_cabinet
    db = FakeDb()
    await import_job_worker.process_invoice_import_job({"id": 1, "dossier_id": 7, "options": {"client_ice": "003641228000030"}}, db)
    lines = db.workspace["lines"]
    new = [l for l in lines if l.get("source_id") == "src-a"]
    assert len(new) == 1, [l.get("fact_num") for l in new]  # date lue comme n° retirée
    assert new[0]["if"] == "1102277" and new[0]["lib_frss"] == "ACHIBEST FOOD SARL", new[0]
    old = [l for l in lines if l.get("source_id") == "old"][0]
    assert old["if"] == "1102277" and old["lib_frss"] == "ACHIBEST FOOD SARL", old


def main() -> int:
    asyncio.run(scenario())
    print("OK test_worker_supplier_e2e")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
