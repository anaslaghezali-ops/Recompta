from __future__ import annotations

import re
import secrets
import unicodedata
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote
from uuid import uuid4

from supabase_service import SupabaseService, service_headers

IMPORT_QUEUE_BUCKET = "import-queue"


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _next_source_id() -> str:
    return f"src-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid4().hex[:6]}"


def sanitize_filename(name: str) -> str:
    base = (name or "document").split("/")[-1].split("\\")[-1]
    ascii_name = unicodedata.normalize("NFD", base).encode("ascii", "ignore").decode("ascii")
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "_", ascii_name)
    safe = re.sub(r"_+", "_", safe).strip("_")[:180]
    return safe or "document"


def build_import_storage_path(dossier_id: int, job_id: int, original_filename: str) -> str:
    safe = sanitize_filename(original_filename)
    unique = f"{int(datetime.now(timezone.utc).timestamp() * 1000)}-{secrets.token_hex(4)}"
    return f"jobs/{dossier_id}/{job_id}/{unique}_{safe}"


async def upload_import_queue_file(
    db: SupabaseService,
    *,
    storage_path: str,
    content: bytes,
    mime_type: str,
) -> None:
    encoded = quote(storage_path, safe="/")
    response = await db.client.post(
        f"{db.base}/storage/v1/object/{IMPORT_QUEUE_BUCKET}/{encoded}",
        headers={
            **service_headers(),
            "Content-Type": mime_type or "application/octet-stream",
            "x-upsert": "false",
        },
        content=content,
    )
    response.raise_for_status()


async def complete_invoice_job_upload(
    job_id: int,
    *,
    filename: str,
    content: bytes,
    mime_type: str,
) -> dict[str, Any]:
    async with SupabaseService() as db:
        response = await db.client.get(
            f"{db.base}/rest/v1/import_jobs",
            params={"id": f"eq.{job_id}", "select": "*", "limit": "1"},
            headers=service_headers(),
        )
        response.raise_for_status()
        rows = response.json()
        if not rows:
            raise ValueError("Job introuvable.")
        job = rows[0]
        if job.get("status") not in {"uploading", "queued"}:
            raise ValueError("Ce job n'accepte plus de fichier.")

        dossier_id = int(job["dossier_id"])
        source_id = _next_source_id()
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
                "mime_type": mime_type or "application/octet-stream",
                "size_bytes": len(content),
                "status": "uploaded",
                "source_id": source_id,
            },
        )
        if file_response.status_code >= 400:
            await db.client.delete(
                f"{db.base}/storage/v1/object/{IMPORT_QUEUE_BUCKET}",
                headers=service_headers(),
                json={"prefixes": [storage_path]},
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
        updated = patch_response.json()
        return updated[0] if updated else job
