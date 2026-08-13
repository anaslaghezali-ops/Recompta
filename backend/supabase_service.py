from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import httpx


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
                "status": "in.(uploaded,queued)",
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
