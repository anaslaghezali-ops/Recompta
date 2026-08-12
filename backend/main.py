from __future__ import annotations

import os
from typing import Annotated

from dotenv import load_dotenv

load_dotenv()

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from auth import AuthUser, get_current_user, supabase_configured
from excel_export import export_filename, export_to_bytes
from invoice_extractor import extract_invoice
from models import ExportRequest, ExtractionResult
from saas import OnboardRequest, create_cabinet_for_user, get_user_cabinet
from zip_utils import iter_invoice_files

app = FastAPI(title="Recompta API", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict:
    from invoice_extractor import ai_available, preferred_engine

    return {
        "status": "ok",
        "extraction_engine": preferred_engine(),
        "ai_configured": ai_available(),
        "saas_enabled": supabase_configured(),
    }


@app.get("/api/config")
async def public_config() -> dict:
    return {
        "supabase_url": os.getenv("SUPABASE_URL", ""),
        "supabase_anon_key": os.getenv("SUPABASE_ANON_KEY", ""),
        "saas_enabled": supabase_configured(),
    }


@app.get("/api/me")
async def me(user: Annotated[AuthUser, Depends(get_current_user)]) -> dict:
    cabinet = await get_user_cabinet(user.id)
    return {"user": {"id": user.id, "email": user.email}, "cabinet": cabinet}


@app.post("/api/onboard")
async def onboard(
    body: OnboardRequest,
    user: Annotated[AuthUser, Depends(get_current_user)],
) -> dict:
    existing = await get_user_cabinet(user.id)
    if existing:
        raise HTTPException(status_code=400, detail="Vous avez déjà un cabinet")
    try:
        cabinet = await create_cabinet_for_user(user.id, body.cabinet_name, body.display_name)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"cabinet": cabinet}


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


@app.post("/api/extract", response_model=list[ExtractionResult])
async def extract_files(files: Annotated[list[UploadFile], File(...)]) -> list[ExtractionResult]:
    if not files:
        raise HTTPException(status_code=400, detail="Aucun fichier fourni")

    results: list[ExtractionResult] = []

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
            result = await extract_invoice(display_name, file_content, file_mime)
            if len(invoice_files) > 1 or relative_name != upload_name:
                result.filename = display_name
            results.append(result)

    return results


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
