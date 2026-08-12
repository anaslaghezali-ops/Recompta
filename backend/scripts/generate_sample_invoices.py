#!/usr/bin/env python3
"""Génère des factures PDF de test basées sur les données réelles du fichier DED TVA."""

from __future__ import annotations

from datetime import date
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.pdfgen import canvas

OUTPUT_DIR = Path(__file__).parent / "invoices"


def _draw_invoice(
    path: Path,
    *,
    supplier: str,
    ice: str,
    if_fiscal: str,
    invoice_num: str,
    invoice_date: date,
    lines: list[dict],
    footer: str = "",
) -> None:
    c = canvas.Canvas(str(path), pagesize=A4)
    width, height = A4
    y = height - 2 * cm

    c.setFont("Helvetica-Bold", 16)
    c.drawString(2 * cm, y, supplier)
    y -= 0.8 * cm
    c.setFont("Helvetica", 10)
    c.drawString(2 * cm, y, f"ICE: {ice}")
    y -= 0.5 * cm
    c.drawString(2 * cm, y, f"IF: {if_fiscal}")
    y -= 1.2 * cm

    c.setFont("Helvetica-Bold", 12)
    c.drawString(2 * cm, y, f"FACTURE N° {invoice_num}")
    y -= 0.6 * cm
    c.setFont("Helvetica", 10)
    c.drawString(2 * cm, y, f"Date: {invoice_date.strftime('%d/%m/%Y')}")
    y -= 1.2 * cm

    c.setFont("Helvetica-Bold", 10)
    c.drawString(2 * cm, y, "Désignation")
    c.drawString(12 * cm, y, "HT")
    c.drawString(14.5 * cm, y, "TVA")
    c.drawString(16.5 * cm, y, "TTC")
    y -= 0.5 * cm
    c.line(2 * cm, y, width - 2 * cm, y)
    y -= 0.6 * cm

    total_ht = total_tva = total_ttc = 0.0
    c.setFont("Helvetica", 10)
    for line in lines:
        c.drawString(2 * cm, y, line["label"][:45])
        c.drawRightString(13.5 * cm, y, f"{line['ht']:.2f}")
        c.drawRightString(15.5 * cm, y, f"{line['tva']:.2f}")
        c.drawRightString(18 * cm, y, f"{line['ttc']:.2f}")
        total_ht += line["ht"]
        total_tva += line["tva"]
        total_ttc += line["ttc"]
        y -= 0.55 * cm

    y -= 0.4 * cm
    c.line(2 * cm, y, width - 2 * cm, y)
    y -= 0.7 * cm
    c.setFont("Helvetica-Bold", 10)
    c.drawString(10 * cm, y, "TOTAL HT:")
    c.drawRightString(13.5 * cm, y, f"{total_ht:.2f}")
    y -= 0.55 * cm
    c.drawString(10 * cm, y, "TOTAL TVA:")
    c.drawRightString(15.5 * cm, y, f"{total_tva:.2f}")
    y -= 0.55 * cm
    c.drawString(10 * cm, y, "TOTAL TTC:")
    c.drawRightString(18 * cm, y, f"{total_ttc:.2f}")

    if footer:
        c.setFont("Helvetica", 8)
        c.drawString(2 * cm, 2 * cm, footer)

    c.save()


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    samples = [
        {
            "filename": "achibest_FV26-023806.pdf",
            "supplier": "ACHIBEST",
            "ice": "000229475000050",
            "if_fiscal": "1102277",
            "invoice_num": "FV26-023806",
            "invoice_date": date(2026, 6, 4),
            "lines": [
                {"label": "Matieres consommables (TVA 10%)", "ht": 932.98, "tva": 93.30, "ttc": 1026.28},
                {"label": "Matieres consommables (TVA 20%)", "ht": 4380.68, "tva": 876.14, "ttc": 5256.82},
            ],
        },
        {
            "filename": "orange_F-0626-0465400.pdf",
            "supplier": "ORANGE MAROC",
            "ice": "001524628000001",
            "if_fiscal": "1086826",
            "invoice_num": "F-0626-0465400",
            "invoice_date": date(2026, 6, 16),
            "lines": [
                {"label": "Abonnement telephonie mobile", "ht": 249.17, "tva": 49.83, "ttc": 299.00},
            ],
        },
        {
            "filename": "glovo_MA-FVR260000608.pdf",
            "supplier": "GLOVO MOROCCO",
            "ice": "002086928000050",
            "if_fiscal": "26046117",
            "invoice_num": "MA-FVR260000608",
            "invoice_date": date(2026, 6, 15),
            "lines": [
                {"label": "Prestations de livraison", "ht": 2895.50, "tva": 579.10, "ttc": 3474.60},
            ],
        },
        {
            "filename": "carrefour_303-22-06-2026.pdf",
            "supplier": "Carrefour Market",
            "ice": "000078523000008",
            "if_fiscal": "3315185",
            "invoice_num": "303/22-06-2026/001/78561",
            "invoice_date": date(2026, 6, 22),
            "lines": [
                {"label": "Achats divers", "ht": 150.00, "tva": 30.00, "ttc": 180.00},
            ],
        },
        {
            "filename": "saham_releve_bancaire.pdf",
            "supplier": "Saham Bank",
            "ice": "001540367000005",
            "if_fiscal": "1084160",
            "invoice_num": "RELEVE BANCAIRE",
            "invoice_date": date(2026, 6, 30),
            "lines": [
                {"label": "Frais bancaires commission", "ht": 114.58, "tva": 11.46, "ttc": 126.04},
            ],
        },
    ]

    for sample in samples:
        path = OUTPUT_DIR / sample["filename"]
        _draw_invoice(
            path,
            supplier=sample["supplier"],
            ice=sample["ice"],
            if_fiscal=sample["if_fiscal"],
            invoice_num=sample["invoice_num"],
            invoice_date=sample["invoice_date"],
            lines=sample["lines"],
            footer="Facture de test generee depuis les donnees DED TVA Aichoum",
        )
        print(f"Created {path}")


if __name__ == "__main__":
    main()
