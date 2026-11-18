#!/usr/bin/env python3
"""Libère l'espace Supabase occupé par la file d'import (bucket « import-queue »).

Chaque facture importée est copiée deux fois : dans la file d'attente (pour
l'extraction) puis dans les documents du dossier. La copie de file d'attente ne
sert plus une fois le job terminé. Ce script supprime :
  - les fichiers des jobs terminés (completed) ;
  - les fichiers des jobs en échec depuis plus de 7 jours ;
  - les fichiers sans job depuis plus de 2 jours.
Les documents des dossiers (bucket « dossier-documents ») ne sont jamais touchés.

Usage (depuis backend/) :
  python scripts/purge_import_queue.py              # liste seulement
  python scripts/purge_import_queue.py --supprimer  # supprime
"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from supabase_service import SupabaseService, service_headers  # noqa: E402

BUCKET = "import-queue"


async def list_objects(db: SupabaseService, prefix: str = "") -> list[dict]:
    """Liste récursive du bucket (l'API Storage renvoie dossiers et fichiers)."""
    out: list[dict] = []
    offset = 0
    while True:
        r = await db.client.post(
            f"{db.base}/storage/v1/object/list/{BUCKET}",
            headers=service_headers(),
            json={"prefix": prefix, "limit": 1000, "offset": offset},
        )
        r.raise_for_status()
        items = r.json()
        for item in items:
            path = f"{prefix}/{item['name']}" if prefix else item["name"]
            if item.get("id") is None:  # sous-dossier
                out.extend(await list_objects(db, path))
            else:
                out.append({
                    "path": path,
                    "size": int((item.get("metadata") or {}).get("size") or 0),
                    "created_at": item.get("created_at") or "",
                })
        if len(items) < 1000:
            return out
        offset += 1000


async def job_status_by_path(db: SupabaseService) -> dict[str, tuple[str, str]]:
    statuses: dict[str, tuple[str, str]] = {}
    offset = 0
    while True:
        r = await db.client.get(
            f"{db.base}/rest/v1/import_job_files",
            params={"select": "storage_path,import_jobs(status,updated_at)", "offset": offset, "limit": 1000},
            headers=service_headers(),
        )
        r.raise_for_status()
        rows = r.json()
        for row in rows:
            job = row.get("import_jobs") or {}
            statuses[row["storage_path"]] = (job.get("status") or "", job.get("updated_at") or "")
        if len(rows) < 1000:
            return statuses
        offset += 1000


def older_than(iso: str, days: int) -> bool:
    if not iso:
        return False
    when = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return when < datetime.now(timezone.utc) - timedelta(days=days)


async def main(apply: bool) -> None:
    async with SupabaseService() as db:
        objects = await list_objects(db)
        statuses = await job_status_by_path(db)
        to_delete, kept = [], []
        for obj in objects:
            status, updated = statuses.get(obj["path"], ("", ""))
            if status == "completed":
                to_delete.append(obj)
            elif status == "failed" and older_than(updated, 7):
                to_delete.append(obj)
            elif not status and older_than(obj["created_at"], 2):
                to_delete.append(obj)
            else:
                kept.append(obj)
        mb = lambda items: sum(o["size"] for o in items) / 1048576  # noqa: E731
        print(f"File d'import : {len(objects)} fichiers, {mb(objects):.1f} Mo")
        print(f"  à supprimer : {len(to_delete)} fichiers, {mb(to_delete):.1f} Mo")
        print(f"  conservés   : {len(kept)} fichiers, {mb(kept):.1f} Mo (jobs en cours ou échecs récents)")
        if not apply:
            print("\nRien n'a été supprimé. Relancez avec --supprimer pour libérer l'espace.")
            return
        await db.delete_storage_files(BUCKET, [o["path"] for o in to_delete])
        print(f"\nSupprimé : {len(to_delete)} fichiers, {mb(to_delete):.1f} Mo libérés.")


if __name__ == "__main__":
    asyncio.run(main("--supprimer" in sys.argv))
