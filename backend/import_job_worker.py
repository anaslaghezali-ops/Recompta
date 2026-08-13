from __future__ import annotations

import asyncio
import os
import traceback
from datetime import datetime, timezone
from typing import Any

from bank_parser import normalize_ai_transactions, parse_bank_file
from bank_statement import extract_bank_statement
from invoice_extractor import extract_invoice
from models import ExtractionResult, InvoiceLine
from normalize_results import (
    activate_client_ice_exclusions,
    deactivate_client_ice_exclusions,
    normalize_extraction_results,
)
from supabase_service import SupabaseService

IMPORT_QUEUE_BUCKET = "import-queue"


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def invoice_line_to_workspace_dict(
    line: InvoiceLine,
    *,
    source_file: str,
    source_id: str,
    extraction_engine: str,
) -> dict[str, Any]:
    designation = line.designation.value if hasattr(line.designation, "value") else str(line.designation)
    field_confidence = {
        key: (value.level if hasattr(value, "level") else value)
        for key, value in (line.field_confidence or {}).items()
    }
    return {
        "source_file": source_file,
        "source_id": source_id,
        "fact_num": line.fact_num,
        "designation": designation,
        "m_ht": line.m_ht,
        "tva": line.tva,
        "m_ttc": line.m_ttc,
        "if": line.if_fournisseur or "",
        "lib_frss": line.lib_frss or "",
        "ice_frs": line.ice_frs or "",
        "ice_inferred": line.ice_inferred,
        "if_inferred": line.if_inferred,
        "ttc_reconstructed": line.ttc_reconstructed,
        "tva_calculated": line.tva_calculated,
        "amounts_sanitized": line.amounts_sanitized,
        "supplier_from_folder": line.supplier_from_folder,
        "date_paie_from_bank": line.date_paie_from_bank,
        "extraction_engine": extraction_engine or line.extraction_engine,
        "user_verified_fields": [],
        "field_confidence": field_confidence,
        "taux": line.taux,
        "id_paie": line.id_paie,
        "date_paie": line.date_paie.isoformat() if line.date_paie else "",
        "date_fac": line.date_fac.isoformat() if line.date_fac else "",
    }


def extraction_concurrency() -> int:
    try:
        value = int(os.getenv("EXTRACTION_CONCURRENCY", "4"))
    except ValueError:
        return 4
    return max(1, min(value, 12))


def _is_spreadsheet(filename: str, mime_type: str) -> bool:
    lower = (filename or "").lower()
    if lower.endswith((".csv", ".txt", ".xlsx", ".xls")):
        return True
    return mime_type in (
        "text/csv",
        "text/plain",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


async def process_bank_import_job(job: dict[str, Any], db: SupabaseService) -> dict[str, Any]:
    job_id = int(job["id"])
    dossier_id = int(job["dossier_id"])
    files = await db.fetch_job_files(job_id)

    if not files:
        await db.update_job(
            job_id,
            {
                "status": "failed",
                "error_summary": "Aucun fichier à traiter.",
                "finished_at": _iso_now(),
            },
        )
        return {"job_id": job_id, "processed": 0, "failed": 0, "status": "failed"}

    file_row = files[0]
    file_id = int(file_row["id"])
    storage_path = file_row["storage_path"]
    filename = file_row["original_filename"]
    mime_type = file_row.get("mime_type") or "application/octet-stream"

    processed = 0
    failed = 0
    transaction_count = 0

    await db.update_job_file(file_id, {"status": "processing"})

    try:
        content = await db.download_storage_file(IMPORT_QUEUE_BUCKET, storage_path)

        await db.save_dossier_document(
            dossier_id,
            filename=filename,
            content=content,
            mime_type=mime_type,
            doc_type="bank",
            source_id=file_row.get("source_id") or None,
        )

        if _is_spreadsheet(filename, mime_type):
            transactions, bank_meta, warnings = parse_bank_file(filename, content)
            engine = "spreadsheet"
        else:
            result = await extract_bank_statement(filename, content, mime_type)
            transactions = normalize_ai_transactions(
                [item.model_dump() for item in result.transactions]
            )
            bank_meta = {
                "filename": filename,
                "bankName": result.bank_name or "BANQUE",
                "bankIce": result.bank_ice or "",
                "bankIf": result.bank_if or "",
            }
            warnings = list(result.warnings or [])
            engine = result.engine or "ai"

        if not transactions:
            raise RuntimeError(warnings[0] if warnings else "Aucun mouvement détecté dans le relevé.")

        workspace = await db.load_workspace(dossier_id)
        lines = list(workspace.get("lines") or [])

        await db.save_workspace(
            dossier_id,
            lines=lines,
            bank_transactions=transactions,
            bank_meta=bank_meta,
        )

        transaction_count = len(transactions)
        processed = 1
        await db.update_job_file(
            file_id,
            {
                "status": "done",
                "line_count": transaction_count,
                "processed_at": _iso_now(),
                "error_message": None,
            },
        )
        await db.update_job(job_id, {"processed_files": processed})

        summary = f"Relevé importé — {transaction_count} mouvement(s)"
        if warnings:
            summary += f" ({warnings[0]})"

        await db.log_activity(
            dossier_id,
            "import_job",
            summary,
            {
                "job_id": job_id,
                "doc_type": "bank",
                "transactions": transaction_count,
                "engine": engine,
            },
        )

        final_status = "completed"
        error_summary = None
    except Exception as exc:  # noqa: BLE001
        failed = 1
        final_status = "failed"
        error_summary = f"{type(exc).__name__}: {exc}"
        await db.update_job_file(
            file_id,
            {
                "status": "failed",
                "error_message": error_summary,
                "processed_at": _iso_now(),
            },
        )

    await db.update_job(
        job_id,
        {
            "status": final_status,
            "processed_files": processed,
            "failed_files": failed,
            "error_summary": error_summary,
            "finished_at": _iso_now(),
        },
    )

    return {
        "job_id": job_id,
        "processed": processed,
        "failed": failed,
        "transactions": transaction_count,
        "status": final_status,
    }


async def process_invoice_import_job(job: dict[str, Any], db: SupabaseService) -> dict[str, Any]:
    job_id = int(job["id"])
    dossier_id = int(job["dossier_id"])
    options = job.get("options") or {}
    client_ice = str(options.get("client_ice") or "")

    files = await db.fetch_job_files(job_id)
    if not files:
        await db.update_job(
            job_id,
            {
                "status": "failed",
                "error_summary": "Aucun fichier à traiter.",
                "finished_at": _iso_now(),
            },
        )
        return {"job_id": job_id, "processed": 0, "failed": 0, "status": "failed"}

    workspace = await db.load_workspace(dossier_id)
    lines: list[dict[str, Any]] = list(workspace.get("lines") or [])

    processed = int(job.get("processed_files") or 0)
    failed = int(job.get("failed_files") or 0)
    extraction_results: list[ExtractionResult] = []
    semaphore = asyncio.Semaphore(extraction_concurrency())

    async def process_file(file_row: dict[str, Any]) -> ExtractionResult | None:
        nonlocal processed, failed
        file_id = int(file_row["id"])
        storage_path = file_row["storage_path"]
        filename = file_row["original_filename"]
        source_id = file_row.get("source_id") or ""
        mime_type = file_row.get("mime_type") or "application/octet-stream"

        await db.update_job_file(file_id, {"status": "processing"})

        async with semaphore:
            try:
                content = await db.download_storage_file(IMPORT_QUEUE_BUCKET, storage_path)
                await db.save_dossier_document(
                    dossier_id,
                    filename=filename,
                    content=content,
                    mime_type=mime_type,
                    doc_type="invoice",
                    source_id=source_id or None,
                )
                result = await extract_invoice(filename, content, mime_type)
                result.filename = filename
                result.source_id = source_id
                line_count = len(result.lines)
                await db.update_job_file(
                    file_id,
                    {
                        "status": "done",
                        "line_count": line_count,
                        "processed_at": _iso_now(),
                        "error_message": None,
                    },
                )
                processed += 1
                await db.update_job(job_id, {"processed_files": processed})
                return result
            except Exception as exc:  # noqa: BLE001
                failed += 1
                await db.update_job_file(
                    file_id,
                    {
                        "status": "failed",
                        "error_message": f"{type(exc).__name__}: {exc}",
                        "processed_at": _iso_now(),
                    },
                )
                await db.update_job(job_id, {"failed_files": failed})
                return ExtractionResult(
                    filename=filename,
                    source_id=source_id,
                    lines=[],
                    warnings=[f"Extraction échouée : {type(exc).__name__}: {exc}"],
                )

    token = activate_client_ice_exclusions(client_ice)
    new_lines: list[dict[str, Any]] = []
    try:
        raw_results = await asyncio.gather(*(process_file(file_row) for file_row in files))
        extraction_results = [item for item in raw_results if item is not None]

        normalized = normalize_extraction_results(extraction_results, client_ice=client_ice)
        for result in normalized:
            for line in result.lines:
                new_lines.append(
                    invoice_line_to_workspace_dict(
                        line,
                        source_file=result.filename,
                        source_id=result.source_id,
                        extraction_engine=result.engine,
                    )
                )

        if new_lines:
            lines.extend(new_lines)
            await db.save_workspace(dossier_id, lines=lines)
            await db.touch_dossier_status(dossier_id, len(lines))
            await db.log_activity(
                dossier_id,
                "import_job",
                f"Import terminé — {len(new_lines)} ligne(s) extraite(s)",
                {"job_id": job_id, "new_lines": len(new_lines), "failed_files": failed},
            )
    finally:
        deactivate_client_ice_exclusions(token)

    total = int(job.get("total_files") or len(files))
    if processed == 0:
        final_status = "failed"
        error_summary = "Aucun fichier n'a pu être extrait."
    elif failed > 0:
        final_status = "completed"
        error_summary = f"{failed} fichier(s) en erreur sur {total}."
    else:
        final_status = "completed"
        error_summary = None

    await db.update_job(
        job_id,
        {
            "status": final_status,
            "processed_files": processed,
            "failed_files": failed,
            "error_summary": error_summary,
            "finished_at": _iso_now(),
        },
    )

    return {
        "job_id": job_id,
        "processed": processed,
        "failed": failed,
        "new_lines": len(new_lines),
        "status": final_status,
    }


async def process_import_job(job: dict[str, Any], db: SupabaseService) -> dict[str, Any]:
    doc_type = job.get("doc_type") or "invoice"
    if doc_type == "bank":
        return await process_bank_import_job(job, db)
    return await process_invoice_import_job(job, db)


async def process_pending_import_jobs(*, max_jobs: int = 1) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    async with SupabaseService() as db:
        queued = await db.fetch_queued_jobs(limit=max_jobs)
        for job in queued:
            claimed = await db.claim_job(int(job["id"]))
            if not claimed:
                continue
            try:
                results.append(await process_import_job(claimed, db))
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                await db.update_job(
                    int(job["id"]),
                    {
                        "status": "failed",
                        "error_summary": "Erreur interne du worker.",
                        "finished_at": _iso_now(),
                    },
                )
                results.append({"job_id": job["id"], "status": "failed", "error": "worker_exception"})
    return results
