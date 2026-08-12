from __future__ import annotations

from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from excel_export import export_filename, export_to_bytes
from invoice_extractor import extract_invoice, merge_extractions
from models import ExportRequest, ExtractionResult, InvoiceLine

app = FastAPI(title="Recompta API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ALLOWED_MIME = {
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/tiff",
}


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


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
    }


@app.post("/api/extract", response_model=list[ExtractionResult])
async def extract_files(files: Annotated[list[UploadFile], File(...)]) -> list[ExtractionResult]:
    if not files:
        raise HTTPException(status_code=400, detail="Aucun fichier fourni")

    results: list[ExtractionResult] = []
    for upload in files:
        content = await upload.read()
        mime_type = upload.content_type or "application/octet-stream"
        if mime_type not in ALLOWED_MIME:
            results.append(
                ExtractionResult(
                    filename=upload.filename or "inconnu",
                    lines=[],
                    warnings=[f"Type de fichier non supporté: {mime_type}"],
                )
            )
            continue
        result = await extract_invoice(upload.filename or "facture", content, mime_type)
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
