/** @typedef {'q1' | 'q2'} Fortnight */

/**
 * @typedef {object} ExcelOrder
 * @property {string} id
 * @property {string} status
 * @property {number} orderAmount
 * @property {number} deliveryFee
 * @property {Date|null} createdAt
 * @property {number} day
 * @property {Fortnight} fortnight
 */

/**
 * @typedef {object} PdfServiceLine
 * @property {string} orderId
 * @property {number} ht
 * @property {number} tva
 * @property {number} ttc
 * @property {string|null} serviceDate
 */

/**
 * @typedef {object} PdfRefundLine
 * @property {number} ht
 * @property {number} tva
 * @property {number} ttc
 * @property {string} label
 */

/**
 * @typedef {object} PdfInvoice
 * @property {string} invoiceNumber
 * @property {Date|null} invoiceDate
 * @property {Fortnight|null} inferredFortnight
 * @property {PdfServiceLine[]} services
 * @property {PdfRefundLine[]} refunds
 * @property {{ invoiceHt: number|null, invoiceTva: number|null, invoiceTtc: number|null, collected: number|null, payout: number|null }} summary
 */

export const VAT_RATE = 0.2;

export function parseMoney(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const cleaned = String(value)
    .replace(/\s/g, "")
    .replace(/,/g, "")
    .replace(/MAD/gi, "")
    .trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function normalizePayout(raw) {
  const value = parseMoney(raw);
  // Sur la facture, un montant négatif = virement reçu par le partenaire.
  return value < 0 ? -value : value;
}

export function formatMad(amount, { decimals = 2 } = {}) {
  return `${Number(amount || 0).toLocaleString("fr-FR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} MAD`;
}

export function isDelivered(status) {
  return String(status || "").toUpperCase() === "DELIVERED";
}

export function isReturnedOrCancelled(status) {
  const s = String(status || "").toUpperCase();
  return s.includes("RETURN") || s.includes("CANCEL");
}

export function fortnightFromDay(day) {
  if (!day || day < 1) return null;
  return day <= 15 ? "q1" : "q2";
}

export function fortnightLabel(key) {
  return key === "q1" ? "1re quinzaine (1–15)" : "2e quinzaine (16–fin)";
}

export function parseExcelDate(value) {
  const raw = String(value || "").trim();
  const m = raw.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {ExcelOrder[]}
 */
export function mapExcelRows(rows) {
  return rows
    .map((row) => {
      const id = String(row["order id"] || row.order_id || row.id || "").trim();
      if (!id) return null;
      const createdAt = parseExcelDate(row["created at"] || row.created_at);
      const day = createdAt ? createdAt.getDate() : 0;
      const fortnight = fortnightFromDay(day);
      return {
        id,
        status: String(row.status || "").trim(),
        orderAmount: parseMoney(row["order amount"] ?? row.order_amount),
        deliveryFee: parseMoney(row["delivery fee"] ?? row.delivery_fee),
        createdAt,
        day,
        fortnight: fortnight || "q1",
      };
    })
    .filter(Boolean);
}

export function excelContribution(order) {
  const collected = isDelivered(order.status) ? order.orderAmount : 0;
  const feeHt = order.deliveryFee;
  const onInvoice = isDelivered(order.status) || feeHt > 0;
  return { collected, feeHt, onInvoice };
}

/**
 * @param {ExcelOrder[]} orders
 * @param {Fortnight|null} fortnight
 */
export function aggregateExcel(orders, fortnight = null) {
  const pool = fortnight ? orders.filter((o) => o.fortnight === fortnight) : orders;
  let collected = 0;
  let feeHt = 0;
  let deliveredCount = 0;
  let billedCount = 0;
  let zeroFeeSkipped = 0;

  for (const order of pool) {
    const part = excelContribution(order);
    collected += part.collected;
    feeHt += part.feeHt;
    if (isDelivered(order.status)) deliveredCount += 1;
    if (part.onInvoice) billedCount += 1;
    if (isReturnedOrCancelled(order.status) && order.deliveryFee === 0) zeroFeeSkipped += 1;
  }

  const invoiceTtcFromFees = round2(feeHt * (1 + VAT_RATE));

  return {
    orderCount: pool.length,
    deliveredCount,
    billedCount,
    zeroFeeSkipped,
    collected: round2(collected),
    feeHt: round2(feeHt),
    invoiceTtcFromFees,
    payoutFromFees: round2(collected - invoiceTtcFromFees),
  };
}

export function normalizePdfText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n");
}

export function parsePdfInvoice(text) {
  const flat = normalizePdfText(text).replace(/\n/g, " ");

  const invoiceNumber = (flat.match(/MA-FVR\d+/i) || [])[0] || "";
  const dateMatch = flat.match(/Date de la facture\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  let invoiceDate = null;
  let inferredFortnight = null;
  if (dateMatch) {
    invoiceDate = new Date(Number(dateMatch[3]), Number(dateMatch[2]) - 1, Number(dateMatch[1]));
    inferredFortnight = Number(dateMatch[1]) <= 15 ? "q1" : "q2";
  }

  const services = [];
  const serviceRe = /Serv\.\s*On Demand\s+(a-k2bi-[a-z0-9]+)\s+(\d{4}-\d{2}-\d{2})[\s\S]*?\s1\s+([\d.]+)\s+20\s+([\d.]+)\s+([\d.]+)\s+MAD/gi;
  let match;
  while ((match = serviceRe.exec(flat)) !== null) {
    services.push({
      orderId: match[1],
      serviceDate: match[2],
      ht: parseMoney(match[3]),
      tva: parseMoney(match[4]),
      ttc: parseMoney(match[5]),
    });
  }

  const refunds = [];
  const refundRe = /Refunds\.\s*On Demand[\s\S]*?-1\s+(-?[\d.]+)\s+(\d+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+MAD/gi;
  while ((match = refundRe.exec(flat)) !== null) {
    refunds.push({
      ht: parseMoney(match[1]),
      tva: parseMoney(match[3]),
      ttc: parseMoney(match[4]),
      label: "Refunds. On Demand",
    });
  }

  const totalLine = flat.match(/Total de la facture\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+MAD/i);
  const collectedMatch = flat.match(/Montant collecté\s+([\d.,]+)\s+MAD/i);
  const ttcSummary = flat.match(/Total de la facture \(TTC\)\s+([\d.,]+)\s+MAD/i);
  const payoutMatch = flat.match(/Montant à payer au partenaire\s+(-?[\d.,]+)\s+MAD/i);

  return {
    invoiceNumber,
    invoiceDate,
    inferredFortnight,
    services,
    refunds,
    summary: {
      invoiceHt: totalLine ? parseMoney(totalLine[1]) : null,
      invoiceTva: totalLine ? parseMoney(totalLine[2]) : null,
      invoiceTtc: ttcSummary ? parseMoney(ttcSummary[1]) : (totalLine ? parseMoney(totalLine[3]) : null),
      collected: collectedMatch ? parseMoney(collectedMatch[1]) : null,
      payout: payoutMatch ? parseMoney(payoutMatch[1]) : null,
    },
  };
}

export function aggregatePdf(invoice) {
  const servicesHt = round2(invoice.services.reduce((sum, line) => sum + line.ht, 0));
  const refundsHt = round2(invoice.refunds.reduce((sum, line) => sum + line.ht, 0));
  const feeHt = round2(servicesHt + refundsHt);
  const invoiceTtc = invoice.summary.invoiceTtc ?? round2(feeHt * (1 + VAT_RATE));
  const collected = invoice.summary.collected ?? 0;
  const payout = invoice.summary.payout != null
    ? normalizePayout(invoice.summary.payout)
    : round2(collected - invoiceTtc);

  return {
    serviceCount: invoice.services.length,
    refundCount: invoice.refunds.length,
    servicesHt,
    refundsHt,
    feeHt,
    invoiceTtc,
    collected,
    payout,
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function nearlyEqual(a, b, tolerance = 0.02) {
  return Math.abs((a || 0) - (b || 0)) <= tolerance;
}

/**
 * @param {ExcelOrder[]} orders
 * @param {PdfInvoice} pdf
 * @param {Fortnight} fortnight
 */
export function reconcileFortnight(orders, pdf, fortnight) {
  const excel = aggregateExcel(orders, fortnight);
  const pdfAgg = aggregatePdf(pdf);
  const excelById = new Map(orders.filter((o) => o.fortnight === fortnight).map((o) => [o.id, o]));
  const pdfIds = new Set(pdf.services.map((s) => s.orderId));

  const missingInExcel = pdf.services
    .filter((line) => !excelById.has(line.orderId))
    .map((line) => ({
      orderId: line.orderId,
      pdfFeeHt: line.ht,
      pdfTva: line.tva,
      pdfTtc: line.ttc,
      serviceDate: line.serviceDate,
      pdfLine: `Serv. On Demand ${line.orderId} ${line.serviceDate || ""}`.trim(),
      note: "Présente sur la facture PDF mais absente de l’export Excel.",
    }));

  const missingOnPdf = [...excelById.values()]
    .filter((order) => {
      const part = excelContribution(order);
      if (!part.onInvoice) return false;
      return !pdfIds.has(order.id);
    })
    .map((order) => ({
      orderId: order.id,
      status: order.status,
      orderAmount: order.orderAmount,
      deliveryFee: order.deliveryFee,
      note: isReturnedOrCancelled(order.status)
        ? "Frais K > 0 dans Excel mais pas de ligne sur la facture (vérifier statut / période)."
        : "Commande livrée dans Excel mais absente de la facture PDF.",
    }));

  const feeMismatches = pdf.services
    .filter((line) => excelById.has(line.orderId))
    .map((line) => {
      const order = excelById.get(line.orderId);
      const delta = round2(line.ht - order.deliveryFee);
      return { orderId: line.orderId, pdfHt: line.ht, excelK: order.deliveryFee, delta };
    })
    .filter((row) => !nearlyEqual(row.delta, 0));

  const missingFeesHt = round2(missingInExcel.reduce((s, row) => s + row.pdfFeeHt, 0));
  const missingCollectedGuess = round2(
    missingInExcel.reduce((s, row) => {
      const order = excelById.get(row.orderId);
      return s + (order && isDelivered(order.status) ? order.orderAmount : 0);
    }, 0),
  );

  const collectedDelta = round2((pdfAgg.collected || 0) - excel.collected);
  const feeHtDelta = round2((pdfAgg.feeHt || 0) - excel.feeHt);
  const feeHtDeltaAfterMissing = round2(feeHtDelta - missingFeesHt);
  const collectedDeltaAfterMissing = round2(collectedDelta - missingCollectedGuess);
  const refundsHt = pdfAgg.refundsHt;
  const feesExplainedByRefunds = refundsHt !== 0 && nearlyEqual(feeHtDelta, refundsHt);

  const explanations = [];

  if (pdf.refunds.length) {
    explanations.push({
      kind: "refunds",
      title: "Remboursements (refunds) uniquement sur le PDF",
      detail: `${pdf.refunds.length} ligne(s) Refunds. On Demand pour ${formatMad(refundsHt)} HT — absentes de l’export Excel. Elles réduisent la facture TTC.`,
      amount: refundsHt,
      items: pdf.refunds.map((line) => ({
        pdfLine: line.label,
        pdfFeeHt: line.ht,
        pdfTva: line.tva,
        pdfTtc: line.ttc,
      })),
      bridge: {
        fees: {
          excel: excel.feeHt,
          missing: refundsHt,
          pdf: pdfAgg.feeHt,
        },
      },
    });
  }

  if (feesExplainedByRefunds) {
    explanations.push({
      kind: "refunds-fees",
      title: "Frais HT : Excel K + refunds = facture",
      detail: `Excel K ${formatMad(excel.feeHt)} + refunds ${formatMad(refundsHt)} = PDF ${formatMad(pdfAgg.feeHt)} HT.`,
    });
  }

  if (missingInExcel.length) {
    const missingTtc = round2(missingInExcel.reduce((s, row) => s + row.pdfTtc, 0));
    explanations.push({
      kind: "missing-excel",
      title: "Commandes facturées mais absentes de l’Excel",
      detail: `${missingInExcel.length} commande(s) sur la facture ne figurent pas dans l’export (${formatMad(missingFeesHt)} HT · ${formatMad(missingTtc)} TTC). L’export plateforme peut être incomplet.`,
      amount: missingFeesHt,
      items: missingInExcel,
      bridge: {
        fees: {
          excel: excel.feeHt,
          missing: missingFeesHt,
          pdf: pdfAgg.feeHt,
        },
        collected: {
          excel: excel.collected,
          missing: collectedDelta,
          pdf: pdfAgg.collected,
          note: "Le PDF ne détaille pas le montant collecté (F) par commande. L’écart correspond au F des livrées absentes de l’Excel.",
        },
        invoiceTtc: {
          excel: excel.invoiceTtcFromFees,
          missing: missingTtc,
          pdf: pdfAgg.invoiceTtc,
        },
      },
    });
  }

  if (missingOnPdf.length) {
    const zeroFeeReturns = missingOnPdf.filter((r) => isReturnedOrCancelled(r.status) && r.deliveryFee === 0);
    if (zeroFeeReturns.length) {
      explanations.push({
        kind: "expected-skip",
        title: "Retours / annulations sans frais (normal)",
        detail: `${zeroFeeReturns.length} commande(s) RETURNED/CANCELLED avec frais K = 0 : aucune ligne facture attendue.`,
        items: zeroFeeReturns,
      });
    }
    const realMissing = missingOnPdf.filter((r) => !(isReturnedOrCancelled(r.status) && r.deliveryFee === 0));
    if (realMissing.length) {
      explanations.push({
        kind: "missing-pdf",
        title: "Lignes Excel non retrouvées sur la facture",
        detail: `${realMissing.length} commande(s) à investiguer.`,
        items: realMissing,
      });
    }
  }

  if (feeMismatches.length) {
    explanations.push({
      kind: "fee-mismatch",
      title: "Écart de frais K par commande",
      detail: `${feeMismatches.length} commande(s) avec un montant HT différent entre Excel (K) et PDF.`,
      items: feeMismatches,
    });
  }

  if (missingInExcel.length && !nearlyEqual(collectedDelta, 0)) {
    explanations.push({
      kind: "collected-missing-excel",
      title: "Écart « montant collecté » lié à l’Excel incomplet",
      detail: `PDF ${formatMad(pdfAgg.collected)} vs Excel ${formatMad(excel.collected)} (Δ ${formatMad(collectedDelta)}). Les ${missingInExcel.length} commande(s) facturées mais absentes de l’export expliquent probablement cet écart (F non exporté).`,
    });
  } else if (!nearlyEqual(collectedDelta, 0) && nearlyEqual(collectedDeltaAfterMissing, 0)) {
    explanations.push({
      kind: "collected-explained",
      title: "Écart « montant collecté » expliqué",
      detail: `PDF ${formatMad(pdfAgg.collected)} vs Excel ${formatMad(excel.collected)} (Δ ${formatMad(collectedDelta)}). Probablement les commandes absentes de l’Excel (F non exporté).`,
    });
  } else if (!nearlyEqual(collectedDelta, 0)) {
    explanations.push({
      kind: "collected-unexplained",
      title: "Écart « montant collecté » restant",
      detail: `PDF ${formatMad(pdfAgg.collected)} vs Excel livrées ${formatMad(excel.collected)} (Δ ${formatMad(collectedDelta)}).`,
    });
  }

  if (!nearlyEqual(feeHtDelta, 0) && nearlyEqual(feeHtDeltaAfterMissing, 0)) {
    explanations.push({
      kind: "fees-explained",
      title: "Écart frais HT expliqué",
      detail: `PDF ${formatMad(pdfAgg.feeHt)} vs Excel ${formatMad(excel.feeHt)} (Δ ${formatMad(feeHtDelta)}). Couvert par commandes absentes de l’Excel.`,
    });
  } else if (!nearlyEqual(feeHtDelta, 0) && !feesExplainedByRefunds) {
    explanations.push({
      kind: "fees-unexplained",
      title: "Écart frais HT restant",
      detail: `PDF ${formatMad(pdfAgg.feeHt)} vs Excel ${formatMad(excel.feeHt)} (Δ ${formatMad(feeHtDelta)}).`,
    });
  }

  const payoutExcel = round2(excel.collected - excel.invoiceTtcFromFees);
  const payoutDelta = round2((pdfAgg.payout || 0) - payoutExcel);
  const missingTtc = round2(missingInExcel.reduce((s, row) => s + row.pdfTtc, 0));
  const refundTtcImpact = round2(excel.invoiceTtcFromFees - pdfAgg.invoiceTtc);

  const explainedByRefunds = feesExplainedByRefunds
    && nearlyEqual(round2(excel.collected - pdfAgg.invoiceTtc), pdfAgg.payout, 0.5);
  const explainedByMissingExcel = missingInExcel.length > 0
    && nearlyEqual(feeHtDeltaAfterMissing, 0, 0.5)
    && nearlyEqual(
      round2((excel.collected + collectedDelta) - (excel.invoiceTtcFromFees + missingTtc)),
      pdfAgg.payout,
      0.5,
    );

  const feeOk = nearlyEqual(feeHtDelta, 0, 0.5) || feesExplainedByRefunds || nearlyEqual(feeHtDeltaAfterMissing, 0, 0.5);
  const collectedOk = nearlyEqual(collectedDelta, 0, 0.5) || explainedByMissingExcel;
  const payoutOk = nearlyEqual(payoutDelta, 0, 0.5) || explainedByMissingExcel || explainedByRefunds;
  const ok =
    collectedOk
    && feeOk
    && payoutOk
    && feeMismatches.length === 0
    && missingOnPdf.filter((r) => !(isReturnedOrCancelled(r.status) && r.deliveryFee === 0)).length === 0;

  const presentation = buildPresentation({
    ok,
    excel,
    pdfAgg,
    pdf,
    missingInExcel,
    missingFeesHt,
    missingTtc,
    refundsHt,
    refundTtcImpact,
    feesExplainedByRefunds,
    explainedByMissingExcel,
    explainedByRefunds,
    collectedDelta,
    feeHtDelta,
    payoutExcel,
    payoutDelta,
    feeMismatches,
    missingOnPdf,
    explanations,
  });

  return {
    fortnight,
    ok,
    excel,
    pdf: pdfAgg,
    deltas: {
      collected: collectedDelta,
      feeHt: feeHtDelta,
      payout: payoutDelta,
      feeHtAfterMissing: feeHtDeltaAfterMissing,
      collectedAfterMissing: collectedDeltaAfterMissing,
    },
    payoutExcel,
    missingInExcel,
    missingOnPdf,
    feeMismatches,
    explanations,
    presentation,
  };
}

/**
 * @param {object} ctx
 */
function buildPresentation(ctx) {
  const {
    ok,
    excel,
    pdfAgg,
    pdf,
    missingInExcel,
    missingFeesHt,
    missingTtc,
    refundsHt,
    refundTtcImpact,
    feesExplainedByRefunds,
    explainedByMissingExcel,
    explainedByRefunds,
    collectedDelta,
    payoutExcel,
    payoutDelta,
    explanations,
  } = ctx;

  const excelSide = {
    title: "Montant à recevoir (selon Excel)",
    collected: excel.collected,
    feeHt: excel.feeHt,
    feeTtc: excel.invoiceTtcFromFees,
    payout: payoutExcel,
  };

  const pdfSide = {
    title: "Montant réellement reçu (facture PDF)",
    collected: pdfAgg.collected,
    feeHt: pdfAgg.feeHt,
    feeTtc: pdfAgg.invoiceTtc,
    payout: pdfAgg.payout,
    payoutRaw: pdf.summary.payout,
  };

  let gapReason = null;
  if (nearlyEqual(payoutDelta, 0, 0.5)) {
    gapReason = "Le virement calculé depuis l’Excel correspond au virement indiqué sur la facture PDF.";
  } else if (explainedByRefunds) {
    gapReason = `L’Excel ne contient pas les remboursements PDF (${formatMad(refundsHt)} HT). La facture TTC est donc plus basse de ${formatMad(refundTtcImpact)} — vous recevez ${formatMad(payoutDelta)} de plus que le calcul Excel seul.`;
  } else if (explainedByMissingExcel) {
    gapReason = `L’export Excel est incomplet (${missingInExcel.length} commande(s) facturées en plus). Il manque environ ${formatMad(collectedDelta)} de collecté (F) et ${formatMad(missingTtc)} de facture TTC.`;
  } else {
    gapReason = "Écart non expliqué — à vérifier manuellement.";
  }

  /** @type {Array<{type:string,title:string,lines:object[]}>} */
  const details = [];
  if (pdf.refunds.length) {
    details.push({
      type: "refunds",
      title: "Remboursements sur la facture (absents de l’Excel)",
      lines: pdf.refunds.map((line) => ({
        label: line.label,
        pdfFeeHt: line.ht,
        pdfTva: line.tva,
        pdfTtc: line.ttc,
      })),
    });
  }
  if (missingInExcel.length) {
    details.push({
      type: "missing-excel",
      title: `${missingInExcel.length} commande(s) sur la facture, absentes de l’Excel`,
      lines: missingInExcel,
    });
  }

  const warnings = explanations.filter((e) => e.kind.includes("unexplained") || e.kind === "missing-pdf" || e.kind === "fee-mismatch");

  return {
    excelSide,
    pdfSide,
    payoutDelta,
    gapExplained: explainedByMissingExcel || explainedByRefunds || nearlyEqual(payoutDelta, 0, 0.5),
    gapReason,
    details,
    warnings,
    ok,
  };
}

/**
 * @param {ExcelOrder[]} orders
 * @param {{ q1?: PdfInvoice|null, q2?: PdfInvoice|null }} pdfs
 */
export function reconcileMonth(orders, pdfs) {
  const monthExcel = aggregateExcel(orders, null);
  const reports = [];

  for (const key of /** @type {const} */ (["q1", "q2"])) {
    const pdf = pdfs[key];
    if (!pdf) continue;
    reports.push(reconcileFortnight(orders, pdf, key));
  }

  return { monthExcel, reports };
}
