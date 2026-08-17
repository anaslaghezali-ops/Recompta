/**
 * Compteurs dossier (portefeuille) — sans télécharger lines/bank JSON.
 * Miroir SQL : private.workspace_anomaly_count
 */

export const LINE_REVIEW_VERIFIED = "__line_review__";
export const SOFT_REVIEW_FIELDS = new Set(["date_paie", "if"]);

export function isLineReviewVerified(line) {
  return Array.isArray(line?.user_verified_fields)
    && line.user_verified_fields.includes(LINE_REVIEW_VERIFIED);
}

/** Anomalies à partir du field_confidence déjà stocké (pas de recalcul extract-client). */
export function countAnomaliesFromStoredConfidence(lines) {
  let count = 0;
  for (const line of lines || []) {
    if (isLineReviewVerified(line)) continue;
    const conf = line?.field_confidence || {};
    for (const [field, entry] of Object.entries(conf)) {
      if (!entry) continue;
      if (entry.level === "error") {
        count += 1;
        break;
      }
      if (entry.level === "warn" && !SOFT_REVIEW_FIELDS.has(field)) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

export function workspaceSummaryFromRow(row) {
  if (!row) {
    return { lineCount: 0, bankCount: 0, anomalyCount: 0, updated_at: null };
  }

  const hasStoredCounts = row.line_count != null || row.lineCount != null;
  if (hasStoredCounts) {
    return {
      lineCount: Number(row.lineCount ?? row.line_count) || 0,
      bankCount: Number(row.bankCount ?? row.bank_count) || 0,
      anomalyCount: Number(row.anomalyCount ?? row.anomaly_count) || 0,
      updated_at: row.updated_at || null,
    };
  }

  const lines = Array.isArray(row.lines) ? row.lines : [];
  const bank = Array.isArray(row.bank_transactions) ? row.bank_transactions : [];
  return {
    lineCount: lines.length,
    bankCount: bank.length,
    anomalyCount: countAnomaliesFromStoredConfidence(lines),
    updated_at: row.updated_at || null,
  };
}

export function computeProgress(dossier, summary) {
  if (!dossier) return 0;
  if (dossier.status === "exported") return 100;

  const lineCount = summary?.lineCount ?? summary?.lines?.length ?? 0;
  const bankCount = summary?.bankCount ?? summary?.bank_transactions?.length ?? 0;
  const anomalies = summary?.anomalyCount
    ?? countAnomaliesFromStoredConfidence(summary?.lines || []);

  let score = 0;
  if (bankCount > 0) score += 20;
  if (lineCount > 0) score += 35;
  if (lineCount > 0 && anomalies === 0) score += 25;
  else if (lineCount > 0 && anomalies < lineCount * 0.1) score += 15;
  if (dossier.status === "in_review" && anomalies === 0) score += 15;
  if (dossier.status === "in_review") score += 5;

  return Math.min(99, score);
}

/** Génère N lignes fictives (tests / seed) — aucun appel IA. */
export function buildFakeInvoiceLines(count, { anomalyEvery = 10 } = {}) {
  const lines = [];
  for (let i = 1; i <= count; i += 1) {
    const isAnomaly = anomalyEvery > 0 && i % anomalyEvery === 0;
    lines.push({
      fact_num: `FAKE-${String(i).padStart(5, "0")}`,
      lib_frss: `FOURNISSEUR TEST ${i}`,
      ice_frs: isAnomaly ? "" : "000000000000001",
      if: "",
      designation: "MATIERES CONSOMMABLES",
      m_ht: 100,
      tva: 20,
      m_ttc: 120,
      taux: 0.2,
      date_fac: "2026-08-01",
      date_paie: "",
      field_confidence: {
        fact_num: { level: "ok", reason: "Présent" },
        lib_frss: { level: "ok", reason: "Présent" },
        ice_frs: isAnomaly
          ? { level: "error", reason: "ICE manquant (jeu de test)" }
          : { level: "ok", reason: "Présent" },
        designation: { level: "ok", reason: "Présent" },
        m_ht: { level: "ok", reason: "Cohérent" },
        tva: { level: "ok", reason: "Cohérent" },
        m_ttc: { level: "ok", reason: "Cohérent" },
        taux: { level: "ok", reason: "20 %" },
        date_paie: { level: "warn", reason: "Date de paiement absente" },
      },
    });
  }
  return lines;
}

export function buildFakeBankTransactions(count) {
  const rows = [];
  for (let i = 1; i <= count; i += 1) {
    rows.push({
      date: "2026-08-01",
      label: `Virement test ${i}`,
      amount: -120,
    });
  }
  return rows;
}
