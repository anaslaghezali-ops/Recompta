"""Lectures en parallèle avec plafond strict (EXTRACTION_CONCURRENCY).

Vérifie, sans réseau ni base :
1. plusieurs imports tournent en même temps ;
2. jamais plus de N lectures simultanées, même si le navigateur relance
   /process en boucle et si /api/extract lit en même temps ;
3. un import n'est jamais démarré deux fois ;
4. les imports en cours sont exclus de la remise en file ;
5. l'état exposé (health) est cohérent.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["EXTRACTION_CONCURRENCY"] = "2"

import import_job_worker as w  # noqa: E402

N_JOBS = 6
running = 0
peak = 0
processed: list[int] = []
excluded_seen: list[list[int]] = []


class FakeDb:
    queue = list(range(1, N_JOBS + 1))
    claimed: set[int] = set()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return None

    async def fail_stale_empty_uploading_jobs(self):
        return 0

    async def promote_stale_uploading_jobs(self):
        return 0

    async def requeue_stale_processing_jobs(self, exclude_ids=None):
        excluded_seen.append(sorted(exclude_ids or []))
        return 0

    async def fetch_queued_jobs(self, limit=1):
        return [{"id": j} for j in FakeDb.queue if j not in FakeDb.claimed][:limit]

    async def claim_job(self, job_id):
        if job_id in FakeDb.claimed:
            return None
        FakeDb.claimed.add(job_id)
        return {"id": job_id}

    async def update_job(self, job_id, patch):
        return None


async def fake_read(label: str) -> None:
    global running, peak
    async with w.extraction_slot(label):
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.05)
        running -= 1


async def fake_process_import_job(job, db):
    # Un import = 2 factures lues en parallèle (comme un ZIP).
    await asyncio.gather(fake_read(f"job{job['id']}-a"), fake_read(f"job{job['id']}-b"))
    processed.append(int(job["id"]))
    return {"job_id": job["id"], "status": "completed"}


async def main() -> None:
    w.SupabaseService = FakeDb
    w.process_import_job = fake_process_import_job

    # Navigateur qui relance /process toutes les 10 ms + /api/extract en parallèle.
    async def browser_spam():
        for _ in range(60):
            await w.process_pending_import_jobs(max_jobs=25)
            assert len(w._active_jobs) <= 2, f"trop d'imports actifs : {len(w._active_jobs)}"
            await asyncio.sleep(0.01)

    async def direct_extract():
        await asyncio.gather(*(fake_read(f"direct{i}") for i in range(4)))

    await asyncio.gather(browser_spam(), direct_extract())
    while FakeDb.queue and len(processed) < N_JOBS:
        await w.process_pending_import_jobs(max_jobs=25)
        await w.wait_for_job_finished(0.2)
    await w.wait_for_active_jobs()

    assert peak <= 2, f"plafond dépassé : {peak} lectures simultanées"
    assert peak == 2, f"pas de parallélisme : pic {peak}"
    assert sorted(processed) == list(range(1, N_JOBS + 1)), processed
    assert len(processed) == len(set(processed)), "import traité deux fois"
    assert any(ex for ex in excluded_seen), "imports actifs jamais exclus de la remise en file"
    status = w.import_runtime_status()
    assert status["extraction_concurrency"] == 2
    assert status["extractions_running"] == 0 and status["import_jobs_running"] == 0
    assert status["memory_mb"] > 0, status
    print(f"OK — {N_JOBS} imports, pic {peak} lectures simultanées (max 2), mémoire {status['memory_mb']} Mo")


if __name__ == "__main__":
    asyncio.run(main())
