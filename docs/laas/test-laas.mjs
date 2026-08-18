import { readFileSync } from "node:fs";
import {
  aggregateExcel,
  aggregatePdf,
  mapExcelRows,
  parsePdfInvoice,
  reconcileFortnight,
} from "./laas-core.js";

async function pdfText(path) {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { PdfReader } = require("pdfreader");
  return new Promise((resolve, reject) => {
    let text = "";
    new PdfReader().parseBuffer(readFileSync(path), (err, item) => {
      if (err) reject(err);
      else if (!item) resolve(text);
      else if (item.text) text += `${item.text} `;
    });
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Scénario juillet 2026 — 1re quinzaine avec refunds (chiffres LAAS.md). */
function testJulyQ1Synthetic() {
  const orders = mapExcelRows([
  {
    "order id": "a-k2bi-delivered1",
    status: "DELIVERED",
    "order amount": 28911,
    "delivery fee": 3664,
    "created at": "10-07-2026",
  },
  ]);

  const pdfText816 = `
    FACTURE N° MA-FVR260000816
    Date de la facture 15/07/2026
    Serv. On Demand a-k2bi-delivered1 2026-07-10 1 3664.00 20 732.80 4396.80 MAD
    Refunds. On Demand -1 -18.33 20 -3.67 -22.00 MAD
    Refunds. On Demand -1 -114.00 20 -22.80 -136.80 MAD
    Total de la facture 3531.67 706.33 4260.80 MAD
    Montant collecté 28911.00 MAD
    Total de la facture (TTC) 4260.80 MAD
    Montant à payer au partenaire -24650.20 MAD
  `;

  const inv = parsePdfInvoice(pdfText816);
  const report = reconcileFortnight(orders, inv, "q1");

  assert(report.ok, `q1 synthetic: expected ok, got ${report.ok}`);
  assert(Math.abs(report.deltas.collected) < 0.02, `collected delta ${report.deltas.collected}`);
  assert(Math.abs(report.deltas.payout - 136) < 0.02, `payout delta ${report.deltas.payout} (refunds)`);
  assert(report.presentation.gapExplained, "gap should be explained by refunds");
  assert(inv.refunds.length === 2, "expected 2 refund lines");
  console.log("✓ juillet Q1 synthétique (refunds)");
}

/** Scénario juillet 2026 — 2e quinzaine, Excel incomplet (6 commandes sur PDF). */
function testJulyQ2Synthetic() {
  const rows = [
    {
      "order id": "a-k2bi-excelonly",
      status: "DELIVERED",
      "order amount": 19215,
      "delivery fee": 2620,
      "created at": "20-07-2026",
    },
  ];
  const orders = mapExcelRows(rows);

  const missingIds = ["56wr6a", "ehzuor", "lu440b", "p0jtcr", "qyghig", "yexj0r"];
  const serviceLines = missingIds
    .map((id, i) => `Serv. On Demand a-k2bi-${id} 2026-07-${20 + i} 1 23.33 20 4.67 28.00 MAD`)
    .join(" ");

  const pdfText818 = `
    FACTURE N° MA-FVR260000818
    Date de la facture 31/07/2026
    ${serviceLines}
    Serv. On Demand a-k2bi-excelonly 2026-07-20 1 2620.00 20 524.00 3144.00 MAD
    Total de la facture 2760.00 552.00 3312.00 MAD
    Montant collecté 19958.00 MAD
    Total de la facture (TTC) 3312.00 MAD
    Montant à payer au partenaire -16646.00 MAD
  `;

  const inv = parsePdfInvoice(pdfText818);
  const report = reconcileFortnight(orders, inv, "q2");

  assert(report.missingInExcel.length === 6, `expected 6 missing, got ${report.missingInExcel.length}`);
  assert(Math.abs(report.deltas.feeHtAfterMissing) < 0.02, `fee after missing ${report.deltas.feeHtAfterMissing}`);
  assert(report.presentation.gapExplained, "gap should be explained by missing excel");
  assert(report.ok, `q2 synthetic: expected ok, got ${report.ok}`);
  console.log("✓ juillet Q2 synthétique (Excel incomplet)");
}

async function testWithFiles(excelPath, pdf816, pdf818) {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const XLSX = require("xlsx");
  const wb = XLSX.read(readFileSync(excelPath));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  const orders = mapExcelRows(rows);

  const inv816 = parsePdfInvoice(await pdfText(pdf816));
  const inv818 = parsePdfInvoice(await pdfText(pdf818));

  console.log("excel", orders.length, "q1", aggregateExcel(orders, "q1"), "q2", aggregateExcel(orders, "q2"));
  console.log("pdf816", aggregatePdf(inv816));
  console.log("pdf818", aggregatePdf(inv818));

  const r1 = reconcileFortnight(orders, inv816, "q1");
  const r2 = reconcileFortnight(orders, inv818, "q2");
  console.log("q1 ok", r1.ok, "collected Δ", r1.deltas.collected, "fee Δ", r1.deltas.feeHt, "payout Δ", r1.deltas.payout);
  console.log("q2 ok", r2.ok, "missing excel", r2.missingInExcel.length, "collected Δ", r2.deltas.collected, "payout Δ", r2.deltas.payout);
}

async function main() {
  testJulyQ1Synthetic();
  testJulyQ2Synthetic();

  const [excelPath, pdf816, pdf818] = process.argv.slice(2);
  if (excelPath && pdf816 && pdf818) {
    await testWithFiles(excelPath, pdf816, pdf818);
  } else {
    console.log("(fichiers réels optionnels : node test-laas.mjs <excel> <pdf-q1> <pdf-q2>)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
