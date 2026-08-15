from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import httpx

DOCUMENTS_BUCKET = "dossier-documents"


def _document_identity_keys(filename: str) -> set[str]:
    name = str(filename or "").replace("\\", "/").strip("/")
    parts = [part for part in name.split("/") if part]
    keys: set[str] = set()
    if len(parts) >= 2:
        keys.add(f"{parts[-2].lower()}/{parts[-1].lower()}")
    if parts:
        keys.add(parts[-1].lower())
    if not keys:
        keys.add("document")
    return keys


def _document_identity_key(filename: str) -> str:
    keys = _document_identity_keys(filename)
    return sorted(keys, key=len, reverse=True)[0]


def supabase_url() -> str:
    return (os.getenv("SUPABASE_URL") or "https://pbyoxfxngfutoiqjirkx.supabase.co").rstrip("/")


def service_role_key() -> str:
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or ""
    if not key:
        raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY manquante")
    return key


def service_headers(*, prefer: str | None = None) -> dict[str, str]:
    key = service_role_key()
    headers = {
        "Authorization": f"Bearer {key}",
        "apikey": key,
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SupabaseService:
    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self.base = supabase_url()
        self._client = client

    async def __aenter__(self) -> SupabaseService:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=120.0)
        return self

    async def __aexit__(self, *args: object) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=120.0)
        return self._client

    async def promote_stale_uploading_jobs(self, max_age_seconds: int = 90) -> int:
        """Reprend les envois interrompus : fichiers déjà reçus passent en file d'attente."""
        from datetime import timedelta

        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=max_age_seconds)).isoformat()
        response = await self.client.get(
            f"{self.base}/rest/v1/import_jobs",
            params={
                "status": "eq.uploading",
                "uploaded_files": "gt.0",
                "updated_at": f"lt.{cutoff}",
                "select": "id,uploaded_files,total_files",
                "order": "updated_at.asc",
                "limit": "20",
            },
            headers=service_headers(),
        )
        response.raise_for_status()
        promoted = 0
        for job in response.json():
            uploaded = int(job.get("uploaded_files") or 0)
            total = int(job.get("total_files") or 0)
            if uploaded <= 0:
                continue
            patch: dict[str, Any] = {
                "status": "queued",
                "total_files": uploaded,
                "updated_at": _iso_now(),
            }
            if uploaded < total:
                patch["error_summary"] = (
                    f"Envoi interrompu — {uploaded}/{total} fichier(s) reçu(s), traitement partiel."
                )
            await self.update_job(int(job["id"]), patch)
            promoted += 1
        return promoted

    async def fail_stale_empty_uploading_jobs(self, max_age_seconds: int = 300) -> int:
        from datetime import timedelta

        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=max_age_seconds)).isoformat()
        response = await self.client.patch(
            f"{self.base}/rest/v1/import_jobs",
            params={
                "status": "eq.uploading",
                "uploaded_files": "eq.0",
                "updated_at": f"lt.{cutoff}",
            },
            headers={**service_headers(), "Prefer": "return=representation"},
            json={
                "status": "failed",
                "error_summary": "Envoi interrompu avant réception des fichiers.",
                "finished_at": _iso_now(),
                "updated_at": _iso_now(),
            },
        )
        response.raise_for_status()
        return len(response.json())

    async def requeue_stale_processing_jobs(self, max_age_seconds: int = 1800) -> int:
        from datetime import timedelta

        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=max_age_seconds)).isoformat()
        response = await self.client.patch(
            f"{self.base}/rest/v1/import_jobs",
            params={
                "status": "eq.processing",
                "updated_at": f"lt.{cutoff}",
            },
            headers={**service_headers(), "Prefer": "return=representation"},
            json={
                "status": "queued",
                "error_summary": None,
                "started_at": None,
                "updated_at": _iso_now(),
            },
        )
        response.raise_for_status()
        return len(response.json())

    async def fetch_queued_jobs(self, limit: int = 1) -> list[dict[str, Any]]:
        response = await self.client.get(
            f"{self.base}/rest/v1/import_jobs",
            params={
                "status": "eq.queued",
                "order": "created_at.asc",
                "limit": str(limit),
                "select": "*",
            },
            headers=service_headers(),
        )
        response.raise_for_status()
        return response.json()

    async def claim_job(self, job_id: int) -> dict[str, Any] | None:
        response = await self.client.patch(
            f"{self.base}/rest/v1/import_jobs",
            params={"id": f"eq.{job_id}", "status": "eq.queued"},
            headers=service_headers(prefer="return=representation"),
            json={
                "status": "processing",
                "started_at": _iso_now(),
                "updated_at": _iso_now(),
            },
        )
        response.raise_for_status()
        rows = response.json()
        return rows[0] if rows else None

    async def update_job(self, job_id: int, patch: dict[str, Any]) -> None:
        payload = {**patch, "updated_at": _iso_now()}
        response = await self.client.patch(
            f"{self.base}/rest/v1/import_jobs",
            params={"id": f"eq.{job_id}"},
            headers=service_headers(),
            json=payload,
        )
        response.raise_for_status()

    async def fetch_job_files(self, job_id: int) -> list[dict[str, Any]]:
        response = await self.client.get(
            f"{self.base}/rest/v1/import_job_files",
            params={
                "job_id": f"eq.{job_id}",
                "status": "in.(uploaded,queued,processing)",
                "order": "id.asc",
                "select": "*",
            },
            headers=service_headers(),
        )
        response.raise_for_status()
        return response.json()

    async def update_job_file(self, file_id: int, patch: dict[str, Any]) -> None:
        response = await self.client.patch(
            f"{self.base}/rest/v1/import_job_files",
            params={"id": f"eq.{file_id}"},
            headers=service_headers(),
            json=patch,
        )
        response.raise_for_status()

    async def download_storage_file(self, bucket: str, path: str) -> bytes:
        encoded = quote(path, safe="/")
        response = await self.client.get(
            f"{self.base}/storage/v1/object/{bucket}/{encoded}",
            headers=service_headers(),
        )
        response.raise_for_status()
        return response.content

    async def load_workspace(self, dossier_id: int) -> dict[str, Any]:
        response = await self.client.get(
            f"{self.base}/rest/v1/dossier_workspaces",
            params={"dossier_id": f"eq.{dossier_id}", "select": "*"},
            headers=service_headers(),
        )
        response.raise_for_status()
        rows = response.json()
        if not rows:
            return {
                "dossier_id": dossier_id,
                "lines": [],
                "bank_transactions": [],
                "bank_meta": {},
            }
        return rows[0]

    async def save_workspace(
        self,
        dossier_id: int,
        *,
        lines: list[dict[str, Any]],
        bank_transactions: list[dict[str, Any]] | None = None,
        bank_meta: dict[str, Any] | None = None,
    ) -> None:
        existing = await self.load_workspace(dossier_id)
        payload = {
            "dossier_id": dossier_id,
            "lines": lines,
            "bank_transactions": bank_transactions
            if bank_transactions is not None
            else existing.get("bank_transactions") or [],
            "bank_meta": bank_meta if bank_meta is not None else existing.get("bank_meta") or {},
            "updated_at": _iso_now(),
        }
        response = await self.client.post(
            f"{self.base}/rest/v1/dossier_workspaces",
            headers={**service_headers(), "Prefer": "resolution=merge-duplicates,return=minimal"},
            json=payload,
        )
        response.raise_for_status()

    async def log_activity(
        self,
        dossier_id: int,
        event_type: str,
        summary: str,
        meta: dict[str, Any] | None = None,
    ) -> None:
        response = await self.client.post(
            f"{self.base}/rest/v1/dossier_activity",
            headers=service_headers(),
            json={
                "dossier_id": dossier_id,
                "event_type": event_type,
                "summary": summary,
                "meta": meta or {},
            },
        )
        response.raise_for_status()

    async def touch_dossier_status(self, dossier_id: int, line_count: int) -> None:
        status = "in_review" if line_count > 0 else "draft"
        response = await self.client.patch(
            f"{self.base}/rest/v1/client_dossiers",
            params={"id": f"eq.{dossier_id}"},
            headers=service_headers(),
            json={"status": status, "updated_at": _iso_now()},
        )
        response.raise_for_status()

    async def find_dossier_document(
        self,
        dossier_id: int,
        *,
        source_id: str | None = None,
        original_filename: str | None = None,
    ) -> dict[str, Any] | None:
        if source_id:
            response = await self.client.get(
                f"{self.base}/rest/v1/dossier_documents",
                params={
                    "dossier_id": f"eq.{dossier_id}",
                    "source_id": f"eq.{source_id}",
                    "select": "id, storage_path, source_id, original_filename",
                    "limit": "1",
                },
                headers=service_headers(),
            )
            response.raise_for_status()
            rows = response.json()
            if rows:
                return rows[0]

        if not original_filename:
            return None

        target_keys = _document_identity_keys(original_filename)
        response = await self.client.get(
            f"{self.base}/rest/v1/dossier_documents",
            params={
                "dossier_id": f"eq.{dossier_id}",
                "select": "id, storage_path, source_id, original_filename, size_bytes, created_at",
                "order": "created_at.desc",
                "limit": "200",
            },
            headers=service_headers(),
        )
        response.raise_for_status()
        for row in response.json():
            row_keys = _document_identity_keys(row.get("original_filename") or "")
            if target_keys & row_keys:
                return row
        return None

    async def save_dossier_document(
        self,
        dossier_id: int,
        *,
        filename: str,
        content: bytes,
        mime_type: str,
        doc_type: str,
        source_id: str | None = None,
    ) -> dict[str, Any] | None:
        existing = await self.find_dossier_document(
            dossier_id,
            source_id=source_id or None,
            original_filename=filename,
        )
        if existing and int(existing.get("size_bytes") or 0) == len(content):
            return existing

        import re
        import secrets
        import unicodedata

        base = (filename or "document").split("/")[-1]
        ascii_name = unicodedata.normalize("NFD", base).encode("ascii", "ignore").decode("ascii")
        safe = re.sub(r"[^a-zA-Z0-9._-]+", "_", ascii_name)
        safe = re.sub(r"_+", "_", safe).strip("_")[:180] or "document"
        storage_path = f"dossier/{dossier_id}/{int(datetime.now(timezone.utc).timestamp() * 1000)}-{secrets.token_hex(4)}_{safe}"
        encoded = quote(storage_path, safe="/")

        upload_response = await self.client.post(
            f"{self.base}/storage/v1/object/{DOCUMENTS_BUCKET}/{encoded}",
            headers={
                **service_headers(),
                "Content-Type": mime_type or "application/octet-stream",
                "x-upsert": "false",
            },
            content=content,
        )
        upload_response.raise_for_status()

        insert_response = await self.client.post(
            f"{self.base}/rest/v1/dossier_documents",
            headers={**service_headers(), "Prefer": "return=representation"},
            json={
                "dossier_id": dossier_id,
                "doc_type": doc_type,
                "original_filename": filename,
                "storage_path": storage_path,
                "mime_type": mime_type or "application/octet-stream",
                "size_bytes": len(content),
                "source_id": source_id,
            },
        )
        if insert_response.status_code >= 400:
            await self.client.delete(
                f"{self.base}/storage/v1/object/{DOCUMENTS_BUCKET}",
                headers=service_headers(),
                json={"prefixes": [storage_path]},
            )
            insert_response.raise_for_status()

        rows = insert_response.json()
        return rows[0] if rows else None
