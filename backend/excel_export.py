from __future__ import annotations

from datetime import date, datetime
from io import BytesIO
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font

from models import ExportRequest, InvoiceLine

HEADERS = [
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
]

TEMPLATE_PATH = Path(__file__).parent / "templates" / "ded_tva_template.xlsx"


def _to_excel_date(value: date | datetime | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.replace(hour=0, minute=0, second=0, microsecond=0)
    return datetime(value.year, value.month, value.day)


def _write_line(ws, row_idx: int, line: InvoiceLine) -> None:
    values = [
        line.or_value,
        line.fact_num,
        line.designation.value,
        line.m_ht,
        line.tva,
        line.m_ttc,
        line.if_fournisseur,
        line.lib_frss,
        line.ice_frs,
        line.taux,
        line.id_paie,
        _to_excel_date(line.date_paie),
        _to_excel_date(line.date_fac),
        line.resolved_code_tva(),
    ]
    for col_idx, value in enumerate(values, start=1):
        ws.cell(row=row_idx, column=col_idx, value=value)


def _ensure_headers(ws) -> None:
    for col_idx, header in enumerate(HEADERS, start=1):
        cell = ws.cell(row=1, column=col_idx, value=header)
        cell.font = Font(bold=True)


def build_workbook(request: ExportRequest) -> Workbook:
    # Période MMAAAA → feuille EDIMMAA (ex: 062026 → EDI0626)
    sheet_name = request.sheet_name or f"EDI{request.period[:2]}{request.period[4:6]}"

    if TEMPLATE_PATH.exists():
        wb = load_workbook(TEMPLATE_PATH)
        if sheet_name in wb.sheetnames:
            ws = wb[sheet_name]
            if ws.max_row > 1:
                ws.delete_rows(2, ws.max_row)
        else:
            ws = wb.create_sheet(sheet_name)
            _ensure_headers(ws)
    else:
        wb = Workbook()
        ws = wb.active
        ws.title = sheet_name
        _ensure_headers(ws)

    for idx, line in enumerate(request.lines, start=2):
        _write_line(ws, idx, line)

    return wb


def export_to_bytes(request: ExportRequest) -> bytes:
    wb = build_workbook(request)
    buffer = BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    return buffer.getvalue()


def export_filename(client_name: str, period: str) -> str:
    safe_client = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in client_name.strip())
    return f"{safe_client}_DED_TVA_{period}.xlsx"
