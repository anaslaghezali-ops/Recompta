from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Annotated

from dotenv import load_dotenv

# Charge backend/.env même si uvicorn est lancé depuis un autre répertoire
_backend_dir = Path(__file__).resolve().parent
load_dotenv(_backend_dir / ".env")
load_dotenv(_backend_dir.parent / ".env")

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from admin_saas import require_super_admin, router as admin_router
from bank_statement import BankStatementResult, extract_bank_statement
from excel_export import export_filename, export_to_bytes
from dossier_analysis import queue_dossier_analysis
from import_job_queue import complete_job_upload
from import_job_worker import (
    extraction_slot,
    process_pending_import_jobs,
    wait_for_job_finished,
)
from request_auth import (
    authenticate_request,
    require_cabinet_user,
    require_dossier_access,
    require_import_job_access,
)
from invoice_extractor import extract_invoice
from models import ExportRequest, ExtractionResult
from normalize_results import (
    activate_client_ice_exclusions,
    deactivate_client_ice_exclusions,
    normalize_extraction_results,
)
from source_id import split_source_tag
from zip_utils import (
    IMPORT_EXTRACTION_BATCH_SIZE,
    MAX_SINGLE_FILE_BYTES,
    MAX_ZIP_ARCHIVE_BYTES,
    ImportBudgetExceeded,
    InvoiceExtractionBudget,
    is_zip_file,
    iter_invoice_files_batched,
)

app = FastAPI(title="Recompta API", version="0.2.0")
app.include_router(admin_router)


# Déclaré avant CORSMiddleware pour rester à l'intérieur de celui-ci : une erreur
# non gérée doit renvoyer un JSON *avec* les en-têtes CORS, sinon le navigateur
# affiche une erreur CORS trompeuse au lieu du vrai message.
@app.middleware("http")
async def json_errors_with_cors(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception:  # noqa: BLE001
        import logging

        logging.getLogger(__name__).exception("Erreur interne sur %s", request.url.path)
        return JSONResponse(
            status_code=500,
            content={"detail": "Erreur interne du serveur. Réessayez ultérieurement."},
        )


# Origines autorisées à appeler l'API depuis un navigateur.
# Le site servi par ce serveur (backend/static/) est sur la même origine : pas de CORS.
DEFAULT_CORS_ORIGINS = ("https://anaslaghezali-ops.github.io",)
# Développement local (tout port) et Codespaces (adresse qui change).
DEFAULT_CORS_ORIGIN_REGEX = (
    r"http://(localhost|127\.0\.0\.1)(:\d+)?"
    r"|https://[a-z0-9-]+\.app\.github\.dev"
)


def cors_settings(env: dict[str, str] | None = None) -> dict:
    """Paramètres CORSMiddleware calculés depuis l'environnement.

    CORS_ALLOWED_ORIGINS : origines en plus, séparées par des virgules (ex. le futur VPS).
    CORS_ALLOWED_ORIGINS=* : toutes les origines (ancien comportement, secours).
    allow_credentials reste False (obligatoire avec "*"; l'API utilise un jeton Bearer).
    """
    source = os.environ if env is None else env
    extra = [o.strip().rstrip("/") for o in source.get("CORS_ALLOWED_ORIGINS", "").split(",")]
    extra = [o for o in extra if o]
    common = {
        "allow_credentials": False,
        "allow_methods": ["*"],
        "allow_headers": ["*"],
        "expose_headers": ["Content-Disposition"],
    }
    if "*" in extra:
        return {"allow_origins": ["*"], **common}
    origins = list(DEFAULT_CORS_ORIGINS)
    origins += [o for o in extra if o not in origins]
    return {"allow_origins": origins, "allow_origin_regex": DEFAULT_CORS_ORIGIN_REGEX, **common}


app.add_middleware(CORSMiddleware, **cors_settings())


# La vérification de clé est un aller-retour réseau vers OpenAI, appelé avant
# chaque extraction. On le met en cache pour ne pas le payer à chaque import.
_KEY_CHECK_TTL = 60.0
_key_check_cache: dict[str, float | bool | str] = {"at": 0.0, "verified": False, "message": ""}
_worker_task: asyncio.Task | None = None
MAX_EXTRACT_REQUEST_FILES = 20
MAX_EXTRACT_REQUEST_BYTES = 100 * 1024 * 1024


async def read_upload_limited(upload: UploadFile, *, max_bytes: int) -> bytes:
    """Lit un upload par blocs et refuse le dépassement avant de charger tout le fichier."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(min(1024 * 1024, max_bytes - total + 1))
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"Fichier trop volumineux (maximum {max_bytes // (1024 * 1024)} Mio).",
            )
        chunks.append(chunk)
    return b"".join(chunks)


def upload_limit(filename: str, mime_type: str) -> int:
    return MAX_ZIP_ARCHIVE_BYTES if is_zip_file(filename, mime_type) else MAX_SINGLE_FILE_BYTES


def import_worker_enabled() -> bool:
    if os.getenv("IMPORT_WORKER_ENABLED", "1").strip().lower() in {"0", "false", "no"}:
        return False
    return bool(os.getenv("SUPABASE_SERVICE_ROLE_KEY"))


async def _import_worker_loop() -> None:
    poll_seconds = float(os.getenv("IMPORT_WORKER_POLL_SECONDS", "8"))
    while True:
        handled = 0
        try:
            if import_worker_enabled():
                handled = len(await process_pending_import_jobs(max_jobs=3))
        except Exception:  # noqa: BLE001
            import traceback

            traceback.print_exc()
        if handled:
            # Des imports viennent de démarrer : on regarde vite s'il reste de la place.
            await asyncio.sleep(0.5)
        else:
            # Rien à démarrer (file vide ou toutes les places prises) : on attend
            # qu'un import se termine, ou le délai normal.
            await wait_for_job_finished(poll_seconds)


@app.on_event("startup")
async def start_import_worker() -> None:
    global _worker_task
    if import_worker_enabled():
        _worker_task = asyncio.create_task(_import_worker_loop())


@app.on_event("shutdown")
async def stop_import_worker() -> None:
    global _worker_task
    if _worker_task is not None:
        _worker_task.cancel()
        try:
            await _worker_task
        except asyncio.CancelledError:
            pass
        _worker_task = None


@app.get("/api/health")
async def health(refresh: bool = False) -> dict:
    from invoice_extractor import ai_available, preferred_engine, verify_openai_key

    configured = ai_available()
    verified = False
    ai_message = ""
    if configured:
        age = asyncio.get_running_loop().time() - float(_key_check_cache["at"])
        if refresh or age > _KEY_CHECK_TTL:
            verified, ai_message = await verify_openai_key()
            _key_check_cache.update(
                {
                    "at": asyncio.get_running_loop().time(),
                    "verified": verified,
                    "message": ai_message,
                }
            )
        else:
            verified = bool(_key_check_cache["verified"])
            ai_message = str(_key_check_cache["message"])

    return {
        "status": "ok",
        "extraction_engine": preferred_engine(),
        "ai_configured": configured,
        "ai_verified": verified,
        "ai_message": "" if verified else ("Service IA indisponible." if configured else ""),
        "import_worker_enabled": import_worker_enabled(),
        "import_worker_poll_seconds": float(os.getenv("IMPORT_WORKER_POLL_SECONDS", "8")),
        # Le frontend Freemium refuse l'extraction IA si ce flag est absent (backend trop ancien).
        "vision_credits_enforced": True,
        "vision_credits_version": 2,
    }


@app.get("/api/reference")
async def reference() -> dict:
    return {
        "headers": [
            "OR",
            "FACT_NUM",
            "DESIGNATION",
            "M_HT",
            "TVA",
            "M_TTC",
            "IF",
            "LIB_FRSS",
            "ICE_FRS",
            "TAUX",
            "ID_PAIE",
            "DATE_PAIE",
            "DATE_FAC",
            "CODE TVA",
        ],
        "designations": [
            "MATIERES CONSOMMABLES",
            "PRESTATIONS",
            "TELEPHONIE",
            "FRAIS BANCAIRE",
        ],
        "taux": [0.0, 0.1, 0.2],
        "id_paie": [1, 4],
        "code_tva_mapping": {
            "MATIERES CONSOMMABLES @ 20%": 146,
            "MATIERES CONSOMMABLES @ 10%": 150,
            "PRESTATIONS @ 20%": 140,
            "TELEPHONIE @ 20%": 140,
            "FRAIS BANCAIRE @ 10%": 142,
        },
        "accepted_uploads": [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tiff", ".zip"],
    }



@app.post("/api/extract", response_model=list[ExtractionResult])
async def extract_files(
    request: Request,
    files: Annotated[list[UploadFile], File(...)],
    client_ice: Annotated[str, Form()] = "",
) -> list[ExtractionResult]:
    require_cabinet_user(await authenticate_request(request))
    if not files:
        raise HTTPException(status_code=400, detail="Aucun fichier fourni")
    if len(files) > MAX_EXTRACT_REQUEST_FILES:
        raise HTTPException(status_code=413, detail=f"Maximum {MAX_EXTRACT_REQUEST_FILES} fichiers par requête.")

    total_upload_bytes = 0
    results: list[ExtractionResult] = []
    pending: list[tuple[str, bytes, str, str]] = []
    budget = InvoiceExtractionBudget()
    token = activate_client_ice_exclusions(client_ice)
    try:
        async def extract_one(
            name: str, data: bytes, mime: str, source_id: str
        ) -> ExtractionResult:
            # Une facture illisible ne doit jamais faire échouer tout le lot.
            async with extraction_slot(name):
                try:
                    result = await extract_invoice(name, data, mime)
                    result.filename = name
                    result.source_id = source_id
                    return result
                except Exception as exc:  # noqa: BLE001
                    return ExtractionResult(
                        filename=name,
                        source_id=source_id,
                        lines=[],
                        confidence="low",
                        warnings=[f"Extraction échouée : {type(exc).__name__}: {exc}"],
                    )

        async def flush_pending() -> None:
            if not pending:
                return
            batch = list(pending)
            pending.clear()
            results.extend(await asyncio.gather(*(extract_one(*item) for item in batch)))

        for upload in files:
            upload_name = upload.filename or "inconnu"
            mime_type = upload.content_type or "application/octet-stream"
            content = await read_upload_limited(upload, max_bytes=upload_limit(upload_name, mime_type))
            total_upload_bytes += len(content)
            if total_upload_bytes > MAX_EXTRACT_REQUEST_BYTES:
                raise HTTPException(status_code=413, detail="Lot trop volumineux (maximum 100 Mio par requête).")
            original_name, source_id = split_source_tag(upload_name)
            extracted_count = 0
            stream = iter_invoice_files_batched(original_name, content, mime_type, budget=budget)
            try:
                for relative_name, file_content, file_mime in stream:
                    extracted_count += 1
                    display_name = relative_name if relative_name != original_name else original_name
                    pending.append((display_name, file_content, file_mime, source_id))
                    if len(pending) >= IMPORT_EXTRACTION_BATCH_SIZE:
                        await flush_pending()
            except ImportBudgetExceeded as exc:
                raise HTTPException(status_code=413, detail=str(exc)) from exc
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            finally:
                stream.close()
                del content

            if not extracted_count:
                results.append(
                    ExtractionResult(
                        filename=original_name,
                        source_id=source_id,
                        lines=[],
                        warnings=[
                            "Type non supporté. Utilisez des PDF, images (JPG/PNG) ou un fichier ZIP."
                        ],
                    )
                )

        await flush_pending()
        return normalize_extraction_results(results, client_ice=client_ice)
    finally:
        deactivate_client_ice_exclusions(token)


@app.post("/api/import-bank-statement", response_model=BankStatementResult)
async def import_bank_statement(
    request: Request,
    file: Annotated[UploadFile, File(...)],
) -> BankStatementResult:
    require_cabinet_user(await authenticate_request(request))
    upload_name = file.filename or "releve_bancaire"
    mime_type = file.content_type or "application/octet-stream"
    content = await read_upload_limited(file, max_bytes=MAX_SINGLE_FILE_BYTES)
    return await extract_bank_statement(upload_name, content, mime_type)


@app.post("/api/import-jobs/{job_id}/upload")
async def upload_import_job_file(
    request: Request,
    job_id: int,
    file: Annotated[UploadFile, File(...)],
) -> dict:
    """Reçoit le fichier depuis le navigateur et le place en file d'attente Supabase."""
    if not import_worker_enabled():
        raise HTTPException(
            status_code=503,
            detail="Worker inactif : ajoutez SUPABASE_SERVICE_ROLE_KEY dans backend/.env.",
        )

    user = await authenticate_request(request)
    require_cabinet_user(user)
    visible_job = await require_import_job_access(job_id, user["access_token"], request.headers.get("apikey", ""))
    filename = file.filename or "document"
    mime_type = file.content_type or "application/octet-stream"
    content = await read_upload_limited(file, max_bytes=upload_limit(filename, mime_type))
    if not content:
        raise HTTPException(status_code=400, detail="Fichier vide.")

    try:
        job = await complete_job_upload(
            job_id,
            filename=filename,
            content=content,
            mime_type=mime_type,
            expected_dossier_id=int(visible_job["dossier_id"]),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    async def kick_worker() -> None:
        try:
            await process_pending_import_jobs(max_jobs=3)
        except Exception:  # noqa: BLE001
            import traceback

            traceback.print_exc()

    asyncio.create_task(kick_worker())
    return {"job": job}


@app.post("/api/dossiers/{dossier_id}/analyze")
async def analyze_dossier_documents(
    request: Request,
    dossier_id: int,
    doc_type: str = "invoice",
    client_ice: str = "",
    max_documents: int | None = None,
) -> dict:
    """Lance l'analyse IA en arrière-plan pour les documents stockés non encore traités."""
    if not import_worker_enabled():
        raise HTTPException(
            status_code=503,
            detail="Worker inactif : ajoutez SUPABASE_SERVICE_ROLE_KEY dans backend/.env.",
        )
    user = await authenticate_request(request)
    require_cabinet_user(user)
    await require_dossier_access(dossier_id, user["access_token"], request.headers.get("apikey", ""))
    if doc_type not in {"invoice", "bank"}:
        raise HTTPException(status_code=400, detail="doc_type doit être invoice ou bank.")

    limit = None
    if max_documents is not None:
        try:
            limit = max(0, int(max_documents))
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="max_documents invalide") from exc

    try:
        result = await queue_dossier_analysis(
            dossier_id,
            doc_type=doc_type,
            client_ice=client_ice.strip(),
            max_documents=limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if result.get("queued_jobs", 0) > 0:

        queued_count = int(result.get("queued_jobs") or 0)

        async def kick_worker() -> None:
            try:
                batch_size = max(1, min(queued_count, 25))
                await process_pending_import_jobs(max_jobs=batch_size)
            except Exception:  # noqa: BLE001
                import traceback

                traceback.print_exc()

        asyncio.create_task(kick_worker())

    return result


@app.post("/api/import-jobs/process")
async def process_import_jobs(request: Request, limit: int = 1) -> dict:
    """Déclenche le traitement des jobs en file d'attente (réponse immédiate, travail en arrière-plan)."""
    # Le worker traite une file globale avec Service Role : seul un super-admin
    # peut déclencher manuellement un lot. Le worker de fond reste automatique.
    await require_super_admin(request.headers.get("authorization"))
    if not import_worker_enabled():
        raise HTTPException(
            status_code=503,
            detail="Worker inactif : ajoutez SUPABASE_SERVICE_ROLE_KEY dans backend/.env.",
        )

    batch_size = max(1, min(limit, 25))

    async def run_worker() -> None:
        try:
            await process_pending_import_jobs(max_jobs=batch_size)
        except Exception:  # noqa: BLE001
            import traceback

            traceback.print_exc()

    asyncio.create_task(run_worker())
    return {
        "accepted": True,
        "max_jobs": batch_size,
        "message": "Traitement démarré en arrière-plan.",
    }


@app.post("/api/export")
async def export_excel(request: ExportRequest) -> Response:
    if not request.lines:
        raise HTTPException(status_code=400, detail="Aucune ligne à exporter")

    content = export_to_bytes(request)
    filename = export_filename(request.client_name, request.period)
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/preview-filename")
async def preview_filename(client_name: str = Form(...), period: str = Form(...)) -> dict[str, str]:
    return {"filename": export_filename(client_name, period)}


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def unknown_api_route(path: str) -> None:
    raise HTTPException(status_code=404, detail=f"Route API inconnue : /api/{path}")


# Un seul frontend : docs/ (GitHub Pages + uvicorn). Évite 3 copies de supabase-config.js.
_docs_dir = Path(__file__).resolve().parent.parent / "docs"
app.mount("/", StaticFiles(directory=str(_docs_dir), html=True), name="static")
