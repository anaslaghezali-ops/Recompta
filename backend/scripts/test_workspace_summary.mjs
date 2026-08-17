import {
  buildFakeBankTransactions,
  buildFakeInvoiceLines,
  computeProgress,
  countAnomaliesFromStoredConfidence,
  workspaceSummaryFromRow,
} from "../../docs/workspace-summary.js";

const lines = buildFakeInvoiceLines(200, { anomalyEvery: 10 });
const bank = buildFakeBankTransactions(80);

if (countAnomaliesFromStoredConfidence(lines) !== 20) {
  throw new Error("attendu 20 anomalies");
}

const stored = workspaceSummaryFromRow({
  line_count: 200,
  bank_count: 80,
  anomaly_count: 20,
});
if (stored.lineCount !== 200 || stored.bankCount !== 80 || stored.anomalyCount !== 20) {
  throw new Error("résumé stocké incorrect");
}

const fromJson = workspaceSummaryFromRow({ lines, bank_transactions: bank });
if (fromJson.anomalyCount !== 20 || fromJson.lineCount !== 200) {
  throw new Error("résumé JSON incorrect");
}

const progress = computeProgress({ status: "in_review" }, stored);
if (progress < 50) {
  throw new Error(`progression trop basse: ${progress}`);
}

const verified = structuredClone(lines);
verified[9].user_verified_fields = ["__line_review__"];
if (countAnomaliesFromStoredConfidence(verified) !== 19) {
  throw new Error("ligne validée toujours comptée");
}

console.log("test_workspace_summary.mjs: ok");
