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

from bank_statement import BankStatementResult, extract_bank_statement
from excel_export import export_filename, export_to_bytes
from invoice_extractor import extract_invoice
from models import ExportRequest, ExtractionResult
from normalize_results import (
    activate_client_ice_exclusions,
    deactivate_client_ice_exclusions,
    normalize_extraction_results,
)
from zip_utils import iter_invoice_files

app = FastAPI(title="Recompta API", version="0.2.0")


# Déclaré avant CORSMiddleware pour rester à l'intérieur de celui-ci : une erreur
# non gérée doit renvoyer un JSON *avec* les en-têtes CORS, sinon le navigateur
# affiche une erreur CORS trompeuse au lieu du vrai message.
@app.middleware("http")
async def json_errors_with_cors(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"detail": f"Erreur serveur : {type(exc).__name__}: {exc}"},
        )


# allow_credentials doit rester False avec allow_origins="*" (spec CORS).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)


# La vérification de clé est un aller-retour réseau vers OpenAI, appelé avant
# chaque extraction. On le met en cache pour ne pas le payer à chaque import.
_KEY_CHECK_TTL = 60.0
_key_check_cache: dict[str, float | bool | str] = {"at": 0.0, "verified": False, "message": ""}


@app.get("/api/health")
async def health(refresh: bool = False) -> dict:
    from invoice_extractor import ai_available, preferred_engine, tesseract_available, verify_openai_key

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
        "ai_message": ai_message,
        "tesseract_available": tesseract_available(),
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
        "taux": [0.1, 0.2],
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


def extraction_concurrency() -> int:
    """Extractions simultanées par requête (chaque appel IA dure plusieurs secondes)."""
    try:
        value = int(os.getenv("EXTRACTION_CONCURRENCY", "4"))
    except ValueError:
        return 4
    return max(1, min(value, 12))


@app.post("/api/extract", response_model=list[ExtractionResult])
async def extract_files(
    files: Annotated[list[UploadFile], File(...)],
    client_ice: Annotated[str, Form()] = "",
) -> list[ExtractionResult]:
    if not files:
        raise HTTPException(status_code=400, detail="Aucun fichier fourni")

    results: list[ExtractionResult] = []
    pending: list[tuple[str, bytes, str]] = []
    token = activate_client_ice_exclusions(client_ice)
    try:
        for upload in files:
            content = await upload.read()
            upload_name = upload.filename or "inconnu"
            mime_type = upload.content_type or "application/octet-stream"
            invoice_files = iter_invoice_files(upload_name, content, mime_type)

            if not invoice_files:
                results.append(
                    ExtractionResult(
                        filename=upload_name,
                        lines=[],
                        warnings=[
                            "Type non supporté. Utilisez des PDF, images (JPG/PNG) ou un fichier ZIP."
                        ],
                    )
                )
                continue

            for relative_name, file_content, file_mime in invoice_files:
                display_name = relative_name if relative_name != upload_name else upload_name
                pending.append((display_name, file_content, file_mime))

        semaphore = asyncio.Semaphore(extraction_concurrency())

        async def extract_one(name: str, data: bytes, mime: str) -> ExtractionResult:
            # Une facture illisible ne doit jamais faire échouer tout le lot.
            async with semaphore:
                try:
                    result = await extract_invoice(name, data, mime)
                    result.filename = name
                    return result
                except Exception as exc:  # noqa: BLE001
                    return ExtractionResult(
                        filename=name,
                        lines=[],
                        confidence="low",
                        warnings=[f"Extraction échouée : {type(exc).__name__}: {exc}"],
                    )

        results.extend(await asyncio.gather(*(extract_one(*item) for item in pending)))

        return normalize_extraction_results(results, client_ice=client_ice)
    finally:
        deactivate_client_ice_exclusions(token)


@app.post("/api/import-bank-statement", response_model=BankStatementResult)
async def import_bank_statement(
    file: Annotated[UploadFile, File(...)],
) -> BankStatementResult:
    content = await file.read()
    upload_name = file.filename or "releve_bancaire"
    mime_type = file.content_type or "application/octet-stream"
    return await extract_bank_statement(upload_name, content, mime_type)


@app.post("/api/export")
async def export_excel(request: ExportRequest) -> Response:
    if not request.lines:
        raise HTTPException(status_code=400, detail="Aucune ligne à exporter")

    for line in request.lines:
        try:
            line.resolved_code_tva()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

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


app.mount("/", StaticFiles(directory="static", html=True), name="static")
