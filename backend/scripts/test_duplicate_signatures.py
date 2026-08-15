"""Tests logique doublons (alignée extract-client.js duplicateSignatures)."""

from __future__ import annotations


def normalize_duplicate_taux(taux) -> float:
    try:
        value = float(taux)
    except (TypeError, ValueError):
        return 0.0
    return round(value, 4)


def duplicate_signatures(line: dict) -> list[str]:
    fact_num = "".join(ch for ch in str(line.get("fact_num") or "").upper() if ch.isalnum())
    ice = "".join(ch for ch in str(line.get("ice_frs") or "") if ch.isdigit())[:15]
    supplier = ice or "".join(ch for ch in str(line.get("lib_frss") or "").upper() if ch.isalnum())
    taux = normalize_duplicate_taux(line.get("taux"))
    ttc = round((float(line.get("m_ttc") or 0)) * 100)
    date = str(line.get("date_fac") or "")[:10]
    source = "/".join(
        part
        for part in str(line.get("source_file") or "").replace("\\", "/").split("/")
        if part
    ).lower()
    source_id = str(line.get("source_id") or "").strip()
    is_bank_fee = "FRAIS BANCAIRE" in str(line.get("designation") or "").upper()

    keys: list[str] = []
    if supplier and fact_num:
        keys.append(f"fact:{supplier}|{fact_num}|{taux}|{ttc}")
    if source_id and fact_num:
        keys.append(f"sid:{source_id}|{fact_num}|{taux}|{ttc}")
    if not is_bank_fee and source and fact_num and ttc != 0:
        keys.append(f"file:{source}|{fact_num}|{taux}|{ttc}")
    if not is_bank_fee and not fact_num and source and date and ttc != 0:
        keys.append(f"filedate:{source}|{date}|{ttc}")
    return keys


def find_duplicate_indexes(lines: list[dict]) -> list[int]:
    seen: dict[str, int] = {}
    duplicates: set[int] = set()
    for index, line in enumerate(lines):
        for key in duplicate_signatures(line):
            if not key:
                continue
            if key in seen:
                duplicates.add(index)
            else:
                seen[key] = index
    return sorted(duplicates)


def test_multitva_same_invoice_different_rates_not_duplicate() -> None:
    lines = [
        {
            "fact_num": "V081505",
            "lib_frss": "MOSE Food S.",
            "m_ttc": 1284,
            "taux": 0.2,
            "source_file": "Mose food/Scanned.pdf",
        },
        {
            "fact_num": "V081505",
            "lib_frss": "MOSE Food S.",
            "m_ttc": 450,
            "taux": 0.1,
            "source_file": "Mose food/Scanned.pdf",
        },
    ]
    assert find_duplicate_indexes(lines) == []


def test_multitva_same_total_ttc_on_both_lines_not_duplicate() -> None:
    lines = [
        {
            "fact_num": "V081505",
            "lib_frss": "MOSE Food S.",
            "m_ttc": 1734,
            "taux": 0.2,
            "source_file": "Mose food/Scanned.pdf",
        },
        {
            "fact_num": "V081505",
            "lib_frss": "MOSE Food S.",
            "m_ttc": 1734,
            "taux": 0.1,
            "source_file": "Mose food/Scanned.pdf",
        },
    ]
    assert find_duplicate_indexes(lines) == []


def test_exact_reimport_duplicate_still_detected() -> None:
    line = {
        "fact_num": "V081505",
        "lib_frss": "MOSE Food S.",
        "m_ttc": 1284,
        "taux": 0.2,
        "source_file": "Mose food/Scanned.pdf",
    }
    assert find_duplicate_indexes([line, dict(line)]) == [1]


if __name__ == "__main__":
    test_multitva_same_invoice_different_rates_not_duplicate()
    test_multitva_same_total_ttc_on_both_lines_not_duplicate()
    test_exact_reimport_duplicate_still_detected()
    print("ok")
