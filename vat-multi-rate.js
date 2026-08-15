/** Ventilation multi-taux — miroir JS de backend/vat_multi_rate.py */

function isBlendedMultiRate(ht, tva) {
  if (Math.abs(ht) < 0.01 || Math.abs(tva) < 0.01) return false;
  const rate = Math.abs(tva) / Math.abs(ht);
  const in10 = rate >= 0.085 && rate <= 0.115;
  const in20 = rate >= 0.185 && rate <= 0.215;
  return rate >= 0.085 && rate <= 0.215 && !in10 && !in20;
}

export function lineHasBlendedRate(line) {
  return isBlendedMultiRate(Number(line.m_ht) || 0, Number(line.tva) || 0);
}

export function resultHasBlendedSummary(result) {
  return (result.lines || []).some(lineHasBlendedRate);
}

function distinctInvoiceCount(result) {
  return new Set((result.lines || []).map((l) => l.fact_num).filter(Boolean)).size;
}

export function canApplyDocumentVentilation(result) {
  return (result.lines || []).length > 0 && distinctInvoiceCount(result) <= 1;
}

function footerTtcFromText(text) {
  const match = String(text || "").match(/total\s+ttc[^\d\n]{0,30}([\d .,\u00a0]+)/i);
  if (!match) return null;
  const raw = match[1].replace(/[\s\u00a0]/g, "").replace(",", ".");
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

export function shouldReplaceWithVentilation(result, ventilation, text = "") {
  if (ventilation.length >= 2) return true;
  if (text) {
    const markers = (text.match(/\d+[,.]\d+\s*TTC\s+\d+[,.]\d+\s*%/gi) || []).length;
    if (markers >= 2 && (result.lines || []).length < 2 && ventilation.length >= 1) return true;
    const footerTtc = footerTtcFromText(text);
    if (footerTtc != null && (result.lines || []).length === 1 && ventilation.length >= 1) {
      const lineTtc = Math.abs(Number(result.lines[0].m_ttc) || 0);
      if (Math.abs(footerTtc) > lineTtc + 0.5) return true;
    }
  }
  if (ventilation.length === 1 && resultHasBlendedSummary(result)) return true;
  if (ventilation.length === 1 && (result.lines || []).length === 1) {
    const only = result.lines[0];
    const row = ventilation[0];
    if (lineHasBlendedRate(only) && [0, 0.1, 0.2].includes(row.taux)) return true;
  }
  return false;
}

export function expandLinesFromVentilation(template, ventilation, { isAvoir = false, sanitize, fillTtc } = {}) {
  return ventilation.map((row) =>
    fillTtc(
      sanitize(
        {
          ...template,
          m_ht: row.m_ht,
          tva: row.tva,
          m_ttc: row.m_ttc,
          taux: row.taux,
        },
        isAvoir,
      ),
    ),
  );
}

export function tryApplyVentilationFromText(result, text, helpers) {
  if (!text?.trim() || !result.lines?.length || !canApplyDocumentVentilation(result)) {
    return { result, applied: false };
  }

  const ventilation = helpers.extractVatLinesFromText(text);
  if (!ventilation.length || !shouldReplaceWithVentilation(result, ventilation, text)) {
    return { result, applied: false };
  }

  const template = result.lines[0];
  const isAvoir = helpers.isAvoirDocument(text, result.filename, template.fact_num);
  const lines = expandLinesFromVentilation(template, ventilation, {
    isAvoir,
    sanitize: helpers.sanitizeImpossibleAmounts,
    fillTtc: helpers.fillMissingTtc,
  });

  const distinctRates = [...new Set(ventilation.map((r) => r.taux))].sort();
  const ratesLabel = distinctRates.map((r) => `${r * 100} %`).join(", ");
  const warnings = [...(result.warnings || [])];
  warnings.push(
    `Ventilation multi-taux appliquée depuis le document (${ratesLabel}) — ${lines.length} ligne(s) DED.`,
  );

  return {
    result: { ...result, lines, warnings: [...new Set(warnings)] },
    applied: true,
  };
}

export function appendBlendedWarnings(result) {
  const warnings = [...(result.warnings || [])];
  for (const line of result.lines || []) {
    if (!lineHasBlendedRate(line)) continue;
    const ht = Math.abs(Number(line.m_ht) || 0);
    const tva = Math.abs(Number(line.tva) || 0);
    const rate = ht > 0.01 ? (tva / ht) * 100 : 0;
    const label = line.fact_num || "cette pièce";
    warnings.push(
      `Taux TVA global de ${rate.toFixed(1)} % sur ${label} : facture à plusieurs taux — ventiler en lignes 0 / 10 / 20 % (tableau de ventilation du document).`,
    );
    break;
  }
  return { ...result, warnings: [...new Set(warnings)] };
}

export function applyMultiRatePostprocess(result, helpers) {
  const text = result.raw_text || "";
  let current = result;
  const { result: ventilated, applied } = tryApplyVentilationFromText(current, text, helpers);
  current = ventilated;
  if (!applied && helpers.applyTtcVentilationFixes) {
    current = helpers.applyTtcVentilationFixes(current);
  }
  return appendBlendedWarnings(current);
}
