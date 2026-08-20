from __future__ import annotations

import asyncio
import os
import traceback
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from bank_parser import normalize_ai_transactions, parse_bank_file
from bank_statement import extract_bank_statement
from invoice_extractor import extract_invoice
from models import ExtractionResult, InvoiceLine
from normalize_results import (
    activate_client_ice_exclusions,
    deactivate_client_ice_exclusions,
    normalize_extraction_results,
)
from supabase_service import SupabaseService, _document_identity_keys
from supplier_notebook import apply_official_supplier_names
from vision_credits import cabinet_id_for_dossier, reset_active_cabinet_id, set_active_cabinet_id
from zip_utils import iter_invoice_files, storage_path_for_zip_member

IMPORT_QUEUE_BUCKET = "import-queue"


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def pipeline_debug_enabled() -> bool:
    return os.getenv("EXTRACTION_PIPELINE_DEBUG", "").strip().lower() in {"1", "true", "yes"}


def _summarize_result_lines(result: ExtractionResult) -> list[dict[str, Any]]:
    return [
        {
            "fact_num": line.fact_num,
            "taux": line.taux,
            "m_ht": line.m_ht,
            "tva": line.tva,
            "m_ttc": line.m_ttc,
        }
        for line in (result.lines or [])
    ]


def _build_pipeline_debug_report(
    *,
    work_items: list[dict[str, Any]],
    skipped_items: int,
    raw_results: list[ExtractionResult],
    normalized: list[ExtractionResult],
    new_lines: list[dict[str, Any]],
    merged_lines: list[dict[str, Any]],
    current_line_count: int,
) -> dict[str, Any]:
    by_source: dict[str, dict[str, Any]] = {}
    for raw, norm in zip(raw_results, normalized):
        key = str(raw.source_id or raw.filename)
        by_source[key] = {
            "filename": raw.filename,
            "source_id": raw.source_id,
            "engine": raw.engine,
            "after_extract": len(raw.lines or []),
            "after_normalize": len(norm.lines or []),
            "extract_lines": _summarize_result_lines(raw),
            "normalized_lines": _summarize_result_lines(norm),
            "warnings": list(norm.warnings or [])[:5],
        }
    return {
        "skipped_work_items": skipped_items,
        "work_items": len(work_items),
        "new_lines_before_merge": len(new_lines),
        "lines_before_merge": current_line_count,
        "lines_after_merge": len(merged_lines),
        "files": by_source,
    }


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


def _next_source_id() -> str:
    return f"src-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{uuid4().hex[:6]}"


def _display_name(relative_name: str) -> str:
    return relative_name.replace("\\", "/").split("/")[-1] or relative_name


def _processed_invoice_keys(lines: list[dict[str, Any]]) -> set[str]:
    keys: set[str] = set()
    for line in lines:
        source_file = str(line.get("source_file") or "")
        keys.update(_document_identity_keys(source_file))
        source_id = str(line.get("source_id") or "").strip()
        if source_id:
            keys.add(f"sid:{source_id}")
    return keys


def _work_item_already_processed(item: dict[str, Any], processed_keys: set[str]) -> bool:
    source_id = str(item.get("source_id") or "").strip()
    if source_id:
        return f"sid:{source_id}" in processed_keys
    filename = str(item.get("filename") or "")
    doc_keys = _document_identity_keys(filename)
    return bool(doc_keys & processed_keys)


_dossier_locks: dict[int, asyncio.Lock] = {}


def _dossier_lock(dossier_id: int) -> asyncio.Lock:
    lock = _dossier_locks.get(dossier_id)
    if lock is None:
        lock = asyncio.Lock()
        _dossier_locks[dossier_id] = lock
    return lock


def _workspace_line_dedup_key(line: dict[str, Any]) -> tuple:
    """Clé de dédup : une facture multi-TVA = plusieurs lignes pour le même source_id."""
    source_id = str(line.get("source_id") or "").strip()
    fact_num = str(line.get("fact_num") or "").strip().lower()
    try:
        taux = round(float(line.get("taux") or 0), 4)
    except (TypeError, ValueError):
        taux = 0.0
    if source_id:
        return ("sid", source_id, fact_num, taux)
    identity = tuple(sorted(_document_identity_keys(str(line.get("source_file") or ""))))
    return ("file", identity, fact_num, taux)


def _merge_workspace_lines(existing: list[dict[str, Any]], new_lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged = list(existing)
    seen_keys = {_workspace_line_dedup_key(line) for line in existing}

    for line in new_lines:
        key = _workspace_line_dedup_key(line)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        merged.append(line)
    return merged


def extraction_concurrency() -> int:
    try:
        value = int(os.getenv("EXTRACTION_CONCURRENCY", "4"))
    except ValueError:
        return 4
    return max(1, min(value, 12))


def persist_source_document(job: dict[str, Any]) -> bool:
    """Les jobs d'analyse recopient un fichier déjà dans dossier_documents : ne pas le réécrire."""
    options = job.get("options") or {}
    return not bool(options.get("analysis_from_documents"))


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

    cabinet_id = await cabinet_id_for_dossier(dossier_id, db.client)
    credits_token = set_active_cabinet_id(cabinet_id)

    try:
        content = await db.download_storage_file(IMPORT_QUEUE_BUCKET, storage_path)

        if persist_source_document(job):
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
    finally:
        reset_active_cabinet_id(credits_token)

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

    work_items: list[dict[str, Any]] = []
    archive_failures = 0

    for file_row in files:
        file_id = int(file_row["id"])
        storage_path = file_row["storage_path"]
        filename = file_row["original_filename"]
        mime_type = file_row.get("mime_type") or "application/octet-stream"
        parent_source = file_row.get("source_id") or _next_source_id()

        await db.update_job_file(file_id, {"status": "processing"})
        try:
            content = await db.download_storage_file(IMPORT_QUEUE_BUCKET, storage_path)
            expanded = iter_invoice_files(filename, content, mime_type)
            if not expanded:
                raise RuntimeError("Aucune facture exploitable (PDF, image ou ZIP).")

            if len(expanded) == 1:
                relative_name, file_content, file_mime = expanded[0]
                if persist_source_document(job):
                    await db.save_dossier_document(
                        dossier_id,
                        filename=relative_name,
                        content=file_content,
                        mime_type=file_mime,
                        doc_type="invoice",
                        source_id=parent_source,
                    )

            zip_expanded = len(expanded) > 1
            for relative_name, file_content, file_mime in expanded:
                normalized_name = (
                    storage_path_for_zip_member(filename, relative_name)
                    if zip_expanded
                    else relative_name.replace("\\", "/")
                )
                source_id = parent_source if len(expanded) == 1 else _next_source_id()
                if zip_expanded and persist_source_document(job):
                    saved = await db.save_dossier_document(
                        dossier_id,
                        filename=normalized_name,
                        content=file_content,
                        mime_type=file_mime,
                        doc_type="invoice",
                        source_id=source_id,
                    )
                    if saved and saved.get("source_id"):
                        source_id = str(saved["source_id"])
                work_items.append(
                    {
                        "parent_file_id": file_id,
                        "filename": normalized_name,
                        "content": file_content,
                        "mime_type": file_mime,
                        "source_id": source_id,
                    }
                )
        except Exception as exc:  # noqa: BLE001
            archive_failures += 1
            await db.update_job_file(
                file_id,
                {
                    "status": "failed",
                    "error_message": f"{type(exc).__name__}: {exc}",
                    "processed_at": _iso_now(),
                },
            )

    if not work_items:
        await db.update_job(
            job_id,
            {
                "status": "failed",
                "processed_files": 0,
                "failed_files": archive_failures,
                "error_summary": "Aucune facture exploitable dans l'archive.",
                "finished_at": _iso_now(),
            },
        )
        return {"job_id": job_id, "processed": 0, "failed": archive_failures, "status": "failed"}

    await db.update_job(
        job_id,
        {
            "total_files": len(work_items),
            "uploaded_files": len(work_items),
            "processed_files": 0,
            "failed_files": 0,
        },
    )

    processed_keys = _processed_invoice_keys(lines)
    pending_items = [item for item in work_items if not _work_item_already_processed(item, processed_keys)]
    skipped_items = len(work_items) - len(pending_items)
    work_items = pending_items

    if not work_items:
        final_status = "failed"
        error_summary = (
            f"{skipped_items} fichier(s) déjà extrait(s), rien à refaire."
            if skipped_items
            else "Aucun fichier n'a pu être extrait."
        )
        await db.update_job(
            job_id,
            {
                "status": final_status,
                "processed_files": 0,
                "failed_files": 0 if skipped_items else archive_failures,
                "error_summary": error_summary,
                "finished_at": _iso_now(),
            },
        )
        done_parents = {item["parent_file_id"] for item in work_items} if work_items else {
            int(file_row["id"]) for file_row in files
        }
        for file_id in done_parents:
            await db.update_job_file(
                file_id,
                {
                    "status": "done",
                    "processed_at": _iso_now(),
                    "error_message": None,
                },
            )
        return {
            "job_id": job_id,
            "processed": 0,
            "failed": 0,
            "new_lines": 0,
            "status": final_status,
            "skipped": skipped_items,
        }

    processed = 0
    failed = 0
    extraction_results: list[ExtractionResult] = []
    semaphore = asyncio.Semaphore(extraction_concurrency())
    cabinet_id = await cabinet_id_for_dossier(dossier_id, db.client)
    if cabinet_id is None:
        import logging

        logging.getLogger(__name__).warning(
            "vision credits: cabinet_id introuvable pour dossier %s — extractions IA bloquées",
            dossier_id,
        )
    credits_token = set_active_cabinet_id(cabinet_id)

    async def process_item(item: dict[str, Any]) -> ExtractionResult:
        nonlocal processed, failed
        filename = item["filename"]
        source_id = item["source_id"]
        item_token = set_active_cabinet_id(cabinet_id)
        async with semaphore:
            try:
                result = await extract_invoice(filename, item["content"], item["mime_type"])
                result.filename = filename
                result.source_id = source_id
                if result.lines:
                    processed += 1
                else:
                    failed += 1
                    if not result.warnings:
                        result.warnings = ["Aucune ligne extraite — vérifiez le scan ou relancez l'extraction."]
                await db.update_job(job_id, {"processed_files": processed, "failed_files": failed})
                return result
            except Exception as exc:  # noqa: BLE001
                failed += 1
                await db.update_job(job_id, {"processed_files": processed, "failed_files": failed})
                return ExtractionResult(
                    filename=filename,
                    source_id=source_id,
                    lines=[],
                    warnings=[f"Extraction échouée : {type(exc).__name__}: {exc}"],
                )
            finally:
                reset_active_cabinet_id(item_token)

    token = activate_client_ice_exclusions(client_ice)
    new_lines: list[dict[str, Any]] = []
    try:
        raw_results = await asyncio.gather(*(process_item(item) for item in work_items))
        extraction_results = [item for item in raw_results if item is not None]

        normalized = normalize_extraction_results(extraction_results, client_ice=client_ice)
        file_summaries = []
        for result in normalized:
            file_summaries.append({
                "filename": result.filename,
                "source_id": result.source_id,
                "line_count": len(result.lines or []),
                "warnings": list(result.warnings or [])[:3],
            })
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
            try:
                client_id = await db.get_dossier_client_id(dossier_id)
                if client_id:
                    notebook = await db.list_client_suppliers(client_id)
                    apply_official_supplier_names(new_lines, notebook)
            except Exception:  # noqa: BLE001
                pass

        if new_lines:
            async with _dossier_lock(dossier_id):
                latest = await db.load_workspace(dossier_id)
                current_lines = list(latest.get("lines") or [])
                merged_lines = _merge_workspace_lines(current_lines, new_lines)
                await db.save_workspace(dossier_id, lines=merged_lines)
                await db.touch_dossier_status(dossier_id, len(merged_lines))
            activity_meta: dict[str, Any] = {
                "job_id": job_id,
                "new_lines": len(new_lines),
                "failed_files": failed,
                "files": file_summaries,
            }
            if pipeline_debug_enabled():
                activity_meta["pipeline_debug"] = _build_pipeline_debug_report(
                    work_items=work_items,
                    skipped_items=skipped_items,
                    raw_results=extraction_results,
                    normalized=normalized,
                    new_lines=new_lines,
                    merged_lines=merged_lines,
                    current_line_count=len(current_lines),
                )
            await db.log_activity(
                dossier_id,
                "import_job",
                f"Import terminé — {len(new_lines)} ligne(s) extraite(s)",
                activity_meta,
            )
    finally:
        deactivate_client_ice_exclusions(token)
        reset_active_cabinet_id(credits_token)

    total = len(work_items)
    credit_blocked = 0
    for result in extraction_results:
        for warning in result.warnings or []:
            text = str(warning or "").lower()
            if "quota" in text and ("crédit" in text or "credit" in text):
                credit_blocked += 1
                break

    if processed == 0:
        final_status = "failed"
        warning_bits = []
        for result in extraction_results:
            for warning in (result.warnings or [])[:2]:
                if warning and warning not in warning_bits:
                    warning_bits.append(warning)
        if credit_blocked > 0:
            error_summary = (
                f"{credit_blocked} scan(s) non extraits — quota IA épuisé ce mois."
            )
        else:
            error_summary = warning_bits[0] if warning_bits else "Aucun fichier n'a pu être extrait."
    elif failed > 0 or archive_failures > 0:
        final_status = "completed"
        other_failed = max(failed + archive_failures - credit_blocked, 0)
        if credit_blocked > 0 and other_failed == 0:
            error_summary = (
                f"{processed} extrait(s) — {credit_blocked} scan(s) non extraits "
                f"(quota IA épuisé)."
            )
        elif credit_blocked > 0:
            error_summary = (
                f"{failed + archive_failures} fichier(s) en erreur sur {total} "
                f"dont {credit_blocked} faute de crédits."
            )
        else:
            error_summary = f"{failed + archive_failures} fichier(s) en erreur sur {total}."
    else:
        final_status = "completed"
        error_summary = None

    await db.update_job(
        job_id,
        {
            "status": final_status,
            "processed_files": processed,
            "failed_files": failed + archive_failures,
            "error_summary": error_summary,
            "finished_at": _iso_now(),
        },
    )

    done_parents = {item["parent_file_id"] for item in work_items}
    for file_id in done_parents:
        count = sum(1 for item in work_items if item["parent_file_id"] == file_id)
        await db.update_job_file(
            file_id,
            {
                "status": "done",
                "line_count": count,
                "processed_at": _iso_now(),
                "error_message": None,
            },
        )

    return {
        "job_id": job_id,
        "processed": processed,
        "failed": failed + archive_failures,
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
        await db.fail_stale_empty_uploading_jobs()
        await db.promote_stale_uploading_jobs()
        await db.requeue_stale_processing_jobs()
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
