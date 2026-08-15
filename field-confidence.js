/**
 * Confiance par champ — miroir JS des règles backend/field_confidence.py
 */

const ALLOWED_TAUX = [0, 0.1, 0.2];

const FIELD_LABELS = {
  fact_num: "N° facture",
  lib_frss: "Fournisseur",
  ice_frs: "ICE",
  if: "IF",
  designation: "Désignation / CODE TVA",
  m_ht: "HT",
  tva: "TVA",
  m_ttc: "TTC",
  taux: "Taux",
  date_fac: "Date facture",
  date_paie: "Date paiement",
};

export function confidenceClass(level) {
  if (level === "error") return "confidence-error";
  if (level === "warn") return "confidence-warn";
  return "confidence-ok";
}

/** Marqueur persistant : la ligne a été validée manuellement en revue. */
export const LINE_REVIEW_VERIFIED = "__line_review__";

export function isLineReviewVerified(line) {
  return Array.isArray(line?.user_verified_fields)
    && line.user_verified_fields.includes(LINE_REVIEW_VERIFIED);
}

export function verifyReviewLine(line, { isDuplicate = false } = {}) {
  if (!line.user_verified_fields) line.user_verified_fields = [];
  if (!line.user_verified_fields.includes(LINE_REVIEW_VERIFIED)) {
    line.user_verified_fields.push(LINE_REVIEW_VERIFIED);
  }
  if (isDuplicate) line.duplicate_dismissed = true;
}

export function unverifyReviewLine(line) {
  if (!line.user_verified_fields) return;
  line.user_verified_fields = line.user_verified_fields.filter(
    (field) => field !== LINE_REVIEW_VERIFIED,
  );
  line.duplicate_dismissed = false;
}

function entry(level, reason) {
  return { level, reason };
}

function normalizeIce(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 15 ? digits : "";
}

function scanLikeEngine(engine) {
  return engine === "ai" || engine === "scan" || engine === "tesseract";
}

function difficultDocument(warnings) {
  if (!warnings?.length) return false;
  const blob = warnings.join(" ").toLowerCase();
  return [
    "scan difficile",
    "relu avec",
    "contrôle ia",
    "ocr",
    "non détectés",
    "saisie manuelle",
    "illisible",
  ].some((needle) => blob.includes(needle));
}

function signsAreMixed(ht, tva, ttc) {
  const vals = [ht, tva, ttc].filter((v) => Math.abs(v) >= 0.01);
  if (vals.length < 2) return false;
  return new Set(vals.map((v) => (v > 0 ? 1 : -1))).size > 1;
}

function magnitudesCoherent(ht, tva, ttc, taux) {
  const absHt = Math.abs(ht);
  const absTva = Math.abs(tva);
  const absTtc = Math.abs(ttc);
  if (absHt < 0.01 && absTtc < 0.01) return false;
  if (Math.abs(absHt + absTva - absTtc) > 0.05) return false;
  if (absHt > 0.01 && ALLOWED_TAUX.includes(taux)) {
    if (taux === 0) return absTva <= 0.05 && Math.abs(absHt - absTtc) <= 0.05;
    return Math.abs(absTva / absHt - taux) <= 0.025;
  }
  return true;
}

function isBlendedMultiRate(ht, tva) {
  if (Math.abs(ht) < 0.01 || Math.abs(tva) < 0.01) return false;
  const rate = Math.abs(tva) / Math.abs(ht);
  const in10 = rate >= 0.085 && rate <= 0.115;
  const in20 = rate >= 0.185 && rate <= 0.215;
  return rate >= 0.085 && rate <= 0.215 && !in10 && !in20;
}

function impliedTaux(ht, tva) {
  if (Math.abs(ht) < 0.01) return null;
  if (Math.abs(tva) < 0.05) return 0;
  const ratio = Math.abs(tva) / Math.abs(ht);
  for (const allowed of [0.1, 0.2]) {
    if (Math.abs(ratio - allowed) <= 0.025) return allowed;
  }
  return null;
}

function amountIssues(ht, tva, ttc) {
  const issues = [];
  if (Math.abs(ht) < 0.01 && Math.abs(ttc) < 0.01) {
    issues.push(["error", "Montants HT et TTC absents ou nuls"]);
    return issues;
  }
  if (signsAreMixed(ht, tva, ttc)) issues.push(["error", "Signes HT / TVA / TTC incohérents"]);
  if (Math.abs(ht) >= 0.01 && Math.abs(tva) > Math.abs(ht) + 0.05) {
    issues.push(["error", "TVA supérieure au HT (impossible à 10/20 %)"]);
  }
  if (Math.abs(Math.abs(ht) + Math.abs(tva) - Math.abs(ttc)) > 0.05) {
    issues.push(["error", "HT + TVA ≠ TTC"]);
  }
  return issues;
}

function isVerified(field, userVerified) {
  return Array.isArray(userVerified) && userVerified.includes(field);
}

function looksLikeSupplierName(name) {
  const text = String(name || "").trim();
  if (text.length < 4 || text.length > 60) return false;
  const letters = [...text].filter((ch) => /[a-z]/i.test(ch));
  if (letters.length < 4) return false;
  if ([...text].filter((ch) => /\d/.test(ch)).length > text.length / 4) return false;
  if (!letters.some((ch) => /[aeiouyàâéèêîôûü]/i.test(ch))) return false;
  return text.split(/\s+/).length <= 6;
}

function inferCodeTva(designation, taux) {
  const map = {
    "MATIERES CONSOMMABLES|0.2": 146,
    "MATIERES CONSOMMABLES|0.1": 150,
    "PRESTATIONS|0.2": 140,
    "TELEPHONIE|0.2": 140,
    "FRAIS BANCAIRE|0.1": 142,
  };
  return map[`${designation}|${taux}`] ?? null;
}

export function computeFieldConfidence(line, options = {}) {
  const {
    clientIce = "",
    engine = "",
    documentWarnings = [],
    duplicate = false,
    userVerified = [],
  } = options;

  const client = normalizeIce(clientIce);
  const difficult = difficultDocument(documentWarnings);
  const scanLike = scanLikeEngine(engine || line.extraction_engine || "");

  const ht = Number(line.m_ht) || 0;
  const tva = Number(line.tva) || 0;
  const ttc = Number(line.m_ttc) || 0;
  const taux = Number(line.taux);
  const issues = amountIssues(ht, tva, ttc);
  const worst = issues[0] || null;
  const blended = isBlendedMultiRate(ht, tva);
  const implied = impliedTaux(ht, tva);
  const out = {};

  if (isVerified("fact_num", userVerified)) out.fact_num = entry("ok", "Validé manuellement");
  else if (!String(line.fact_num || "").trim()) out.fact_num = entry("error", "Numéro de facture vide");
  else if (duplicate) out.fact_num = entry("warn", "Doublon probable — confirmez le numéro de facture");
  else if (scanLike && difficult) out.fact_num = entry("warn", "Extraction IA sur scan difficile — confirmez le numéro");
  else out.fact_num = entry("ok", "Numéro de facture présent");

  const name = String(line.lib_frss || "").trim();
  if (isVerified("lib_frss", userVerified)) out.lib_frss = entry("ok", "Validé manuellement");
  else if (!name) out.lib_frss = entry("error", "Nom fournisseur manquant");
  else if (line.supplier_from_folder) out.lib_frss = entry("warn", "Nom issu du dossier ZIP — confirmez le fournisseur");
  else if (!looksLikeSupplierName(name)) out.lib_frss = entry("warn", "Nom fournisseur suspect (OCR / IA)");
  else if (scanLike && difficult) out.lib_frss = entry("warn", "Fournisseur extrait d'un scan difficile — confirmez");
  else out.lib_frss = entry("ok", "Nom fournisseur présent");

  const ice = normalizeIce(line.ice_frs);
  if (isVerified("ice_frs", userVerified)) out.ice_frs = entry("ok", "Validé manuellement");
  else if (!ice) out.ice_frs = entry("error", "ICE fournisseur manquant");
  else if (client && ice === client) out.ice_frs = entry("error", "ICE fournisseur identique à l'ICE client");
  else if (line.ice_inferred) out.ice_frs = entry("warn", "ICE repris d'une autre facture du même fournisseur");
  else if (scanLike && difficult) out.ice_frs = entry("warn", "ICE extrait d'un scan difficile — confirmez les 15 chiffres");
  else out.ice_frs = entry("ok", "ICE fournisseur valide (15 chiffres)");

  const fiscal = String(line.if || "").trim();
  if (isVerified("if", userVerified)) out.if = entry("ok", "Validé manuellement");
  else if (!fiscal) out.if = entry("warn", "IF absent — à compléter si disponible sur la facture");
  else if (line.if_inferred) out.if = entry("warn", "IF repris d'une autre facture du même fournisseur");
  else out.if = entry("ok", "IF présent");

  const code = line.code_tva ?? inferCodeTva(line.designation, taux);
  if (isVerified("designation", userVerified)) out.designation = entry("ok", "Validé manuellement");
  else if (code == null && taux === 0) {
    out.designation = entry("warn", "TVA 0 % — CODE TVA à renseigner si votre DED l'exige");
  } else if (code == null) {
    out.designation = entry("warn", `CODE TVA non déduit pour ${line.designation || "?"} à ${taux * 100}%`);
  } else out.designation = entry("ok", `CODE TVA ${code} déduit`);

  for (const [key, label] of [
    ["m_ht", "HT"],
    ["tva", "TVA"],
    ["m_ttc", "TTC"],
  ]) {
    if (isVerified(key, userVerified)) {
      out[key] = entry("ok", "Validé manuellement");
      continue;
    }
    if (worst) {
      out[key] = entry(worst[0], worst[1]);
      continue;
    }
    if (line.amounts_sanitized) {
      out[key] = entry("warn", "Montants corrigés automatiquement — vérifiez");
      continue;
    }
    if (key === "m_ttc" && line.ttc_reconstructed) {
      out[key] = entry("warn", "TTC reconstitué à partir de HT + TVA");
      continue;
    }
    if (key === "tva" && line.tva_calculated) {
      out[key] = entry("warn", "TVA recalculée à partir de HT × taux");
      continue;
    }
    if (scanLike && difficult) {
      out[key] = entry("warn", `${label} extrait d'un scan difficile — confirmez`);
      continue;
    }
    if (duplicate && key === "m_ttc") {
      out[key] = entry("warn", "Doublon probable — confirmez le montant TTC");
      continue;
    }
    out[key] = entry("ok", `${label} cohérent`);
  }

  if (isVerified("taux", userVerified)) out.taux = entry("ok", "Validé manuellement");
  else if (!ALLOWED_TAUX.includes(taux)) {
    out.taux = entry("error", `Taux ${Number.isFinite(taux) ? `${taux * 100}%` : "?"} hors 0 / 10 / 20 %`);
  } else if (taux === 0 && Math.abs(tva) > 0.05) {
    out.taux = entry("error", "Taux 0 % mais TVA non nulle");
  } else if (blended && Math.abs(Math.abs(ht) + Math.abs(tva) - Math.abs(ttc)) <= 0.05) {
    const pct = Math.abs(ht) >= 0.01 ? Math.round((Math.abs(tva) / Math.abs(ht)) * 1000) / 10 : 0;
    out.taux = entry("warn", `Taux moyen ~${pct} % — ventiler en lignes 10 % et 20 % si nécessaire pour la DED`);
  } else if (implied != null && taux !== implied && Math.abs(ht) >= 0.01 && Math.abs(tva) >= 0.05) {
    out.taux = entry("warn", `Taux déclaré ${taux * 100} % incohérent avec HT/TVA (~${implied * 100} %)`);
  } else if (scanLike && difficult) {
    out.taux = entry("warn", "Taux extrait d'un scan difficile — confirmez 0 / 10 / 20 %");
  } else out.taux = entry("ok", `Taux ${taux * 100} % cohérent`);

  if (isVerified("date_fac", userVerified)) out.date_fac = entry("ok", "Validé manuellement");
  else if (!String(line.date_fac || "").trim()) out.date_fac = entry("warn", "Date de facture absente");
  else if (scanLike && difficult) out.date_fac = entry("warn", "Date extraite d'un scan difficile — confirmez");
  else out.date_fac = entry("ok", "Date de facture présente");

  if (isVerified("date_paie", userVerified)) out.date_paie = entry("ok", "Validé manuellement");
  else if (!String(line.date_paie || "").trim()) {
    out.date_paie = entry("warn", "Date de paiement absente — relevé bancaire ou saisie manuelle");
  } else if (line.date_paie_from_bank) {
    out.date_paie = entry("ok", "Date de paiement issue du rapprochement bancaire");
  } else out.date_paie = entry("ok", "Date de paiement renseignée");

  return out;
}

export function attachFieldConfidence(lines, options = {}) {
  const duplicateSet = new Set(options.duplicateIndexes || []);
  lines.forEach((line, index) => {
    line.field_confidence = computeFieldConfidence(line, {
      ...options,
      duplicate: duplicateSet.has(index),
      userVerified: line.user_verified_fields || [],
    });
  });
  return lines;
}

export function refreshLinesFieldConfidence(lines, options = {}) {
  return attachFieldConfidence(lines, options);
}

/** Champs en avertissement informatif — ne bloquent pas le bouton « Corriger les anomalies ». */
export const SOFT_REVIEW_FIELDS = new Set(["date_paie", "if"]);

export function isSoftConfidenceIssue(fieldKey, entry) {
  if (!entry || entry.level === "ok") return false;
  if (entry.level === "error") return false;
  return SOFT_REVIEW_FIELDS.has(fieldKey);
}

/** Ligne à relire : doublon ou au moins un champ en warn/error (après calcul de confiance). */
export function lineNeedsReview(line, { isDuplicate = false } = {}) {
  if (isDuplicate) return true;
  const conf = line.field_confidence || {};
  return Object.values(conf).some(
    (entry) => entry?.level === "error" || entry?.level === "warn",
  );
}

/** Anomalie bloquante pour la revue (hors date paie / IF optionnels). */
export function lineHasActionableAnomaly(line, { isDuplicate = false } = {}) {
  if (isLineReviewVerified(line)) return false;
  if (isDuplicate && !line.duplicate_dismissed) return true;
  const conf = line.field_confidence || {};
  for (const [field, entry] of Object.entries(conf)) {
    if (entry?.level === "error") return true;
    if (entry?.level === "warn" && !isSoftConfidenceIssue(field, entry)) return true;
  }
  return false;
}

export function lineIssueSummary(line, { isDuplicate = false } = {}) {
  if (isLineReviewVerified(line)) {
    return [{ level: "ok", label: "Validée", reason: "Ligne validée manuellement" }];
  }
  const items = [];
  if (isDuplicate && !line.duplicate_dismissed) {
    items.push({ level: "warn", label: "Doublon", reason: "Doublon probable — confirmez ou supprimez" });
  }
  for (const [field, entry] of Object.entries(line.field_confidence || {})) {
    if (!entry || entry.level === "ok") continue;
    if (isSoftConfidenceIssue(field, entry)) continue;
    items.push({
      level: entry.level === "error" ? "error" : "warn",
      label: FIELD_LABELS[field] || field,
      reason: entry.reason || "",
    });
  }
  return items;
}

/** Nombre de lignes à corriger — même règle que le filtre « Anomalies seulement » de la revue. */
export function countLinesNeedingReview(lines, options = {}) {
  const { clientIce = "", duplicateIndexes = [] } = options;
  const duplicates = new Set(duplicateIndexes);
  refreshLinesFieldConfidence(lines, { clientIce, duplicateIndexes });
  return (lines || []).filter((line, index) =>
    lineHasActionableAnomaly(line, { isDuplicate: duplicates.has(index) }),
  ).length;
}

export function countConfidenceIssues(lines) {
  let errors = 0;
  let warns = 0;
  for (const line of lines) {
    for (const conf of Object.values(line.field_confidence || {})) {
      if (conf.level === "error") errors += 1;
      else if (conf.level === "warn") warns += 1;
    }
  }
  return { errors, warns };
}

export function collectFieldConfidenceIssues(lines, options = {}) {
  const duplicateSet = new Set(options.duplicateIndexes || []);
  const issues = [];

  lines.forEach((line, index) => {
    const fact = String(line.fact_num || "").trim();
    const supplier = String(line.lib_frss || "").trim();
    let label = `Ligne ${index + 1}`;
    if (fact && supplier) label = `Facture ${fact} (${supplier})`;
    else if (fact) label = `Facture ${fact}`;
    else if (supplier) label = `${label} (${supplier})`;

    if (isLineReviewVerified(line)) return;

    if (duplicateSet.has(index) && !line.duplicate_dismissed) {
      issues.push({
        level: "warn",
        rank: 1,
        text: `${label} — Doublon probable — même fournisseur, facture, taux et TTC`,
      });
    }

    for (const [field, conf] of Object.entries(line.field_confidence || {})) {
      if (conf.level === "ok") continue;
      const fieldLabel = FIELD_LABELS[field] || field;
      issues.push({
        level: conf.level === "error" ? "error" : conf.level,
        rank: conf.level === "error" ? 0 : 1,
        text: `${label} — ${fieldLabel} — ${conf.reason}`,
      });
    }
  });

  issues.sort((a, b) => a.rank - b.rank || a.text.localeCompare(b.text, "fr"));
  const seen = new Set();
  return issues.filter((issue) => {
    if (seen.has(issue.text)) return false;
    seen.add(issue.text);
    return true;
  });
}

export function applyConfidenceToInput(input, fieldKey, line) {
  input.classList.remove("confidence-ok", "confidence-warn", "confidence-error", "inferred");
  const conf = line.field_confidence?.[fieldKey];
  if (!conf || conf.level === "ok") return;
  input.classList.add(confidenceClass(conf.level));
  input.title = conf.reason;
}
