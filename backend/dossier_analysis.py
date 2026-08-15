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


def _source_ids_with_lines(lines: list[dict[str, Any]]) -> set[str]:
    return {
        str(line.get("source_id") or "").strip()
        for line in lines
        if str(line.get("source_id") or "").strip()
    }


def _is_invoice_processed(
    doc: dict[str, Any],
    processed_keys: set[str],
    source_ids_with_lines: set[str] | None = None,
) -> bool:
    source_id = str(doc.get("source_id") or "").strip()
    if source_id:
        if source_ids_with_lines is not None:
            return source_id in source_ids_with_lines
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


def _is_zip_filename(filename: str) -> bool:
    return str(filename or "").lower().endswith(".zip")


def _zip_archive_stem(filename: str) -> str:
    from pathlib import PurePosixPath

    base = PurePosixPath(str(filename or "").replace("\\", "/")).name
    return base[:-4] if base.lower().endswith(".zip") else base


def _zip_basename(filename: str) -> str:
    from pathlib import PurePosixPath

    return PurePosixPath(str(filename or "").replace("\\", "/")).name.lower()


def _zip_upload_bounds(zip_doc: dict[str, Any], documents: list[dict[str, Any]]) -> tuple[str, str | None]:
    """Fenêtre temporelle d'une version d'archive (ré-upload du même nom)."""
    zip_created = str(zip_doc.get("created_at") or "")
    base = _zip_basename(zip_doc.get("original_filename") or "")
    next_created: str | None = None
    for doc in documents:
        if doc.get("id") == zip_doc.get("id"):
            continue
        if not _is_zip_filename(doc.get("original_filename") or ""):
            continue
        if _zip_basename(doc.get("original_filename") or "") != base:
            continue
        other_created = str(doc.get("created_at") or "")
        if other_created > zip_created and (next_created is None or other_created < next_created):
            next_created = other_created
    return zip_created, next_created


def _doc_in_zip_window(doc: dict[str, Any], zip_created: str, next_zip_created: str | None) -> bool:
    created = str(doc.get("created_at") or "")
    if created < zip_created:
        return False
    if next_zip_created and created >= next_zip_created:
        return False
    return True


def _zip_child_documents(zip_doc: dict[str, Any], documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    stem_lower = _zip_archive_stem(zip_doc.get("original_filename") or "").lower()
    stem_prefix = stem_lower.split("-")[0].strip()
    zip_id = zip_doc.get("id")
    zip_created, next_zip_created = _zip_upload_bounds(zip_doc, documents)
    children: list[dict[str, Any]] = []

    for doc in documents:
        if doc.get("id") == zip_id:
            continue
        if not _doc_in_zip_window(doc, zip_created, next_zip_created):
            continue
        name = str(doc.get("original_filename") or "").replace("\\", "/")
        parts = [part for part in name.split("/") if part]
        if len(parts) < 2 or _is_zip_filename(parts[-1]):
            continue
        folder_lower = parts[0].lower()
        if (
            folder_lower == stem_lower
            or stem_lower.startswith(folder_lower)
            or folder_lower == stem_prefix
        ):
            children.append(doc)

    if children:
        return children

    # Archive unique + PDFs dans des sous-dossiers (ex. « Mose food/… »).
    zips = [doc for doc in documents if _is_zip_filename(doc.get("original_filename") or "")]
    if len(zips) != 1 or zips[0].get("id") != zip_id:
        return []
    return [
        doc
        for doc in documents
        if doc.get("id") != zip_id
        and _doc_in_zip_window(doc, zip_created, next_zip_created)
        and not _is_zip_filename(doc.get("original_filename") or "")
        and (doc.get("doc_type") or "invoice") == "invoice"
        and len([part for part in str(doc.get("original_filename") or "").replace("\\", "/").split("/") if part]) >= 2
    ]


def _should_skip_zip_for_analysis(
    doc: dict[str, Any],
    documents: list[dict[str, Any]],
    processed_keys: set[str],
    source_ids_with_lines: set[str] | None = None,
) -> bool:
    if not _is_zip_filename(doc.get("original_filename") or ""):
        return False
    children = _zip_child_documents(doc, documents)
    if not children:
        return False
    # Archive déjà décompressée : ne pas re-mettre le ZIP en file (seulement les PDFs).
    return True


async def _inflight_analysis_doc_keys(
    db: SupabaseService,
    dossier_id: int,
    *,
    doc_type: str,
) -> tuple[set[str], set[str]]:
    """source_ids et clés de nom de fichier déjà présents dans des jobs d'analyse actifs."""
    response = await db.client.get(
        f"{db.base}/rest/v1/import_jobs",
        params={
            "dossier_id": f"eq.{dossier_id}",
            "doc_type": f"eq.{doc_type}",
            "status": "in.(uploading,queued,processing)",
            "select": "id,options",
            "order": "created_at.desc",
            "limit": "200",
        },
        headers=service_headers(),
    )
    response.raise_for_status()

    source_ids: set[str] = set()
    filename_keys: set[str] = set()
    for job in response.json():
        options = job.get("options") or {}
        if not options.get("analysis_from_documents"):
            continue
        files_response = await db.client.get(
            f"{db.base}/rest/v1/import_job_files",
            params={
                "job_id": f"eq.{job['id']}",
                "select": "source_id,original_filename",
                "limit": "50",
            },
            headers=service_headers(),
        )
        files_response.raise_for_status()
        for row in files_response.json():
            source_id = str(row.get("source_id") or "").strip()
            if source_id:
                source_ids.add(source_id)
            filename_keys.update(_document_identity_keys(row.get("original_filename") or ""))
    return source_ids, filename_keys


def _doc_already_inflight(
    doc: dict[str, Any],
    inflight_source_ids: set[str],
    inflight_filename_keys: set[str],
) -> bool:
    source_id = str(doc.get("source_id") or "").strip()
    if source_id and source_id in inflight_source_ids:
        return True
    doc_keys = _document_identity_keys(doc.get("original_filename") or "")
    return bool(doc_keys & inflight_filename_keys)


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
            lines = list(workspace.get("lines") or [])
            processed_keys = _processed_invoice_keys(lines)
            source_ids_with_lines = _source_ids_with_lines(lines)
            pending = [
                doc for doc in documents
                if not _is_invoice_processed(doc, processed_keys, source_ids_with_lines)
                and not _should_skip_zip_for_analysis(
                    doc, documents, processed_keys, source_ids_with_lines,
                )
            ]
        elif doc_type == "bank":
            pending = [doc for doc in documents if not _is_bank_processed(doc, workspace)]
        else:
            raise ValueError(f"Type de document non supporté : {doc_type}")

        inflight_source_ids, inflight_filename_keys = await _inflight_analysis_doc_keys(
            db, dossier_id, doc_type=doc_type,
        )
        to_queue: list[dict[str, Any]] = []
        skipped_inflight = 0
        for doc in pending:
            if _doc_already_inflight(doc, inflight_source_ids, inflight_filename_keys):
                skipped_inflight += 1
                continue
            to_queue.append(doc)

        if not to_queue:
            if skipped_inflight:
                return {
                    "queued_jobs": 0,
                    "pending_documents": len(pending),
                    "skipped_inflight": skipped_inflight,
                    "message": (
                        f"{skipped_inflight} document(s) déjà en cours d'extraction — "
                        "attendez la fin du traitement."
                    ),
                }
            return {
                "queued_jobs": 0,
                "pending_documents": 0,
                "skipped_inflight": 0,
                "message": "Aucun document en attente d'analyse.",
            }

        options = {"client_ice": client_ice, "analysis_from_documents": True}
        jobs: list[dict[str, Any]] = []

        for doc in to_queue:
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

        message = f"{len(jobs)} analyse(s) mise(s) en file d'attente."
        if skipped_inflight:
            message += f" {skipped_inflight} déjà en cours."

        return {
            "queued_jobs": len(jobs),
            "pending_documents": len(pending),
            "skipped_inflight": skipped_inflight,
            "jobs": jobs,
            "message": message,
        }
