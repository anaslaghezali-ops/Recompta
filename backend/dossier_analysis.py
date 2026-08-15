from __future__ import annotations

from typing import Any
from uuid import uuid4

from import_job_queue import IMPORT_QUEUE_BUCKET, build_import_storage_path, upload_import_queue_file
from supabase_service import DOCUMENTS_BUCKET, SupabaseService, _document_identity_keys, service_headers


def _next_source_id() -> str:
    from datetime import datetime, timezone

    return f"src-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid4().hex[:6]}"


def _iso_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _processed_invoice_keys(lines: list[dict[str, Any]]) -> set[str]:
    keys: set[str] = set()
    for line in lines:
        source_file = str(line.get("source_file") or "")
        keys.update(_document_identity_keys(source_file))
        source_id = str(line.get("source_id") or "").strip()
        if source_id:
            keys.add(f"sid:{source_id}")
    return keys


def _is_invoice_processed(doc: dict[str, Any], processed_keys: set[str]) -> bool:
    source_id = str(doc.get("source_id") or "").strip()
    if source_id:
        return f"sid:{source_id}" in processed_keys
    doc_keys = _document_identity_keys(doc.get("original_filename") or "")
    return bool(doc_keys & processed_keys)


def _is_bank_processed(doc: dict[str, Any], workspace: dict[str, Any]) -> bool:
    bank = workspace.get("bank_transactions") or []
    if not bank:
        return False
    bank_meta = workspace.get("bank_meta") or {}
    stored_name = str(bank_meta.get("filename") or "").strip()
    if not stored_name:
        return False
    doc_keys = _document_identity_keys(doc.get("original_filename") or "")
    stored_keys = _document_identity_keys(stored_name)
    return bool(doc_keys & stored_keys)


async def list_dossier_documents(db: SupabaseService, dossier_id: int, *, doc_type: str | None = None) -> list[dict[str, Any]]:
    params: dict[str, str] = {
        "dossier_id": f"eq.{dossier_id}",
        "select": "id, dossier_id, doc_type, original_filename, storage_path, mime_type, size_bytes, source_id, created_at",
        "order": "created_at.asc",
        "limit": "500",
    }
    if doc_type:
        params["doc_type"] = f"eq.{doc_type}"

    response = await db.client.get(
        f"{db.base}/rest/v1/dossier_documents",
        params=params,
        headers=service_headers(),
    )
    response.raise_for_status()
    return response.json()


async def queue_dossier_analysis(
    dossier_id: int,
    *,
    doc_type: str = "invoice",
    client_ice: str = "",
) -> dict[str, Any]:
    """Crée des jobs d'import pour les documents stockés mais pas encore analysés."""
    async with SupabaseService() as db:
        workspace = await db.load_workspace(dossier_id)
        documents = await list_dossier_documents(db, dossier_id, doc_type=doc_type)

        if doc_type == "invoice":
            processed_keys = _processed_invoice_keys(list(workspace.get("lines") or []))
            pending = [doc for doc in documents if not _is_invoice_processed(doc, processed_keys)]
        elif doc_type == "bank":
            pending = [doc for doc in documents if not _is_bank_processed(doc, workspace)]
        else:
            raise ValueError(f"Type de document non supporté : {doc_type}")

        if not pending:
            return {
                "queued_jobs": 0,
                "pending_documents": 0,
                "message": "Aucun document en attente d'analyse.",
            }

        options = {"client_ice": client_ice, "analysis_from_documents": True}
        jobs: list[dict[str, Any]] = []

        for doc in pending:
            content = await db.download_storage_file(DOCUMENTS_BUCKET, doc["storage_path"])
            filename = doc.get("original_filename") or "document"
            mime_type = doc.get("mime_type") or "application/octet-stream"
            source_id = doc.get("source_id") or _next_source_id()

            job_response = await db.client.post(
                f"{db.base}/rest/v1/import_jobs",
                headers={**service_headers(), "Prefer": "return=representation"},
                json={
                    "dossier_id": dossier_id,
                    "doc_type": doc_type,
                    "status": "uploading",
                    "total_files": 1,
                    "options": options,
                },
            )
            job_response.raise_for_status()
            job = job_response.json()[0]
            job_id = int(job["id"])

            storage_path = build_import_storage_path(dossier_id, job_id, filename)
            await upload_import_queue_file(
                db,
                storage_path=storage_path,
                content=content,
                mime_type=mime_type,
            )

            file_response = await db.client.post(
                f"{db.base}/rest/v1/import_job_files",
                headers=service_headers(),
                json={
                    "job_id": job_id,
                    "original_filename": filename,
                    "storage_path": storage_path,
                    "mime_type": mime_type,
                    "size_bytes": len(content),
                    "status": "uploaded",
                    "source_id": source_id,
                },
            )
            file_response.raise_for_status()

            patch_response = await db.client.patch(
                f"{db.base}/rest/v1/import_jobs",
                params={"id": f"eq.{job_id}"},
                headers={**service_headers(), "Prefer": "return=representation"},
                json={
                    "status": "queued",
                    "uploaded_files": 1,
                    "total_files": 1,
                    "updated_at": _iso_now(),
                },
            )
            patch_response.raise_for_status()
            jobs.append(patch_response.json()[0])

        await db.log_activity(
            dossier_id,
            "analysis",
            f"Analyse IA lancée — {len(jobs)} document(s) {doc_type}",
            {"doc_type": doc_type, "job_count": len(jobs)},
        )

        return {
            "queued_jobs": len(jobs),
            "pending_documents": len(pending),
            "jobs": jobs,
            "message": f"{len(jobs)} analyse(s) mise(s) en file d'attente.",
        }
