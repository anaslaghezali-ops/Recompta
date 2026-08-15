import {
  applyBankStatement,
  applyPaymentToLineIndices,
} from "./bank-statement-client.js?v=bank2";
import {
  bankAliasLookup,
  normalizeBankAliasToken,
  saveBankAlias,
} from "./bank-match-client.js?v=bankmatch1";
import {
  loadDossierWorkspace,
  logDossierActivity,
  saveDossierWorkspace,
} from "./dossier-persistence.js?v=persist1";
import { escapeHtml } from "./dashboard-ui.js?v=portfolio1";

function formatMad(amount) {
  return Number(amount).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatBankDate(isoDate) {
  if (!isoDate) return "";
  const [year, month, day] = isoDate.split("-");
  if (!day) return isoDate;
  return `${day}/${month}/${year}`;
}

export function createWorkspaceBankMatch({
  getContext,
  onComplete,
  showToast,
}) {
  const dialog = document.getElementById("bankMatchDialog");
  const els = {
    dialog,
    txnDate: document.getElementById("bankMatchTxnDate"),
    txnAmount: document.getElementById("bankMatchTxnAmount"),
    txnLabel: document.getElementById("bankMatchTxnLabel"),
    proposals: document.getElementById("bankMatchProposals"),
    invoiceDetail: document.getElementById("bankMatchInvoiceDetail"),
    invoiceList: document.getElementById("bankMatchInvoiceList"),
    learnWrap: document.getElementById("bankMatchLearnWrap"),
    learnAlias: document.getElementById("bankMatchLearnAlias"),
    confirmBtn: document.getElementById("bankMatchConfirm"),
  };

  let lines = [];
  let pendingQueue = [];
  let lastStats = null;
  let skipCloseHandler = false;
  let running = false;

  function validProposals(item) {
    return (item.proposals || []).filter((proposal) =>
      proposal.indices.every((index) => !lines[index]?.date_paie_from_bank),
    );
  }

  function proposalInvoiceRows(proposal) {
    const byFact = new Map();
    for (const index of proposal.indices) {
      const line = lines[index];
      if (!line) continue;
      const factNum = String(line.fact_num || "").trim() || "Sans n°";
      if (!byFact.has(factNum)) byFact.set(factNum, { fact_num: factNum, total: 0 });
      byFact.get(factNum).total += Number(line.m_ttc) || 0;
    }
    return [...byFact.values()].map((row) => ({
      ...row,
      total: Math.round(row.total * 100) / 100,
    }));
  }

  function renderTxn(item) {
    const txn = item.txn;
    if (els.txnDate) els.txnDate.textContent = formatBankDate(txn.date);
    if (els.txnAmount) els.txnAmount.textContent = `${formatMad(txn.absAmount)} MAD`;
    if (els.txnLabel) els.txnLabel.textContent = String(txn.label || "").trim() || "—";
  }

  function updateInvoiceDetail() {
    const item = pendingQueue[0];
    if (!item || !els.proposals) return;
    const proposals = validProposals(item);
    const selectedId = els.proposals.querySelector('input[name="bankProposal"]:checked')?.value;
    const proposal = proposals.find((p) => p.id === selectedId) || proposals[0];
    if (!proposal || !els.invoiceDetail || !els.invoiceList) {
      if (els.invoiceDetail) els.invoiceDetail.hidden = true;
      return;
    }
    const rows = proposalInvoiceRows(proposal);
    els.invoiceList.innerHTML = rows.map((row) =>
      `<li>${escapeHtml(row.fact_num)} — ${formatMad(row.total)} MAD</li>`,
    ).join("");
    els.invoiceDetail.hidden = rows.length === 0;
  }

  function showNextDialog() {
    while (pendingQueue.length > 0) {
      const item = pendingQueue[0];
      const proposals = validProposals(item);
      if (!proposals.length) {
        pendingQueue.shift();
        continue;
      }
      renderTxn(item);
      if (els.proposals) {
        els.proposals.innerHTML = proposals.map((proposal, index) => {
          const invoiceLabel = proposal.invoiceCount === 1
            ? "1 facture"
            : `${proposal.invoiceCount} factures (${proposal.lineCount} lignes)`;
          return `
            <label class="bank-match-option">
              <input type="radio" name="bankProposal" value="${escapeHtml(proposal.id)}" ${index === 0 ? "checked" : ""} />
              <div>
                <strong>${escapeHtml(proposal.lib_frss)}</strong>
                ${invoiceLabel} — total ${formatMad(proposal.totalTtc)} MAD
              </div>
            </label>
          `;
        }).join("");
      }
      updateInvoiceDetail();
      const bankToken = item.bankToken || normalizeBankAliasToken(item.txn.label);
      if (els.learnWrap) els.learnWrap.hidden = !bankToken;
      els.dialog?.showModal();
      return;
    }
    finishAfterDialog();
  }

  async function persistLines(summary, eventType = "bank_match") {
    const { dossierId } = getContext() || {};
    if (!dossierId) return;
    const workspace = await loadDossierWorkspace(dossierId);
    await saveDossierWorkspace(dossierId, {
      lines,
      bankTransactions: workspace?.bank_transactions || [],
      bankMeta: workspace?.bank_meta || {},
    });
    await logDossierActivity(dossierId, eventType, summary, lastStats || {});
    onComplete?.();
  }

  function finishAfterDialog() {
    if (!lastStats) return;
    const { paymentsMatched, paymentsUnmatched, paymentsPending, feesAdded } = lastStats;
    let message = `${paymentsMatched} paiement(s) rapproché(s), ${feesAdded} frais bancaire(s) ajouté(s).`;
    if (paymentsPending) message += ` ${paymentsPending} virement(s) ignoré(s).`;
    if (paymentsUnmatched) message += ` ${paymentsUnmatched} débit(s) sans facture.`;
    showToast?.({
      title: "Rapprochement terminé",
      message,
      variant: paymentsUnmatched || paymentsPending ? "warn" : "info",
    });
    persistLines(message);
  }

  function confirmMatch() {
    const item = pendingQueue[0];
    if (!item) return;
    const proposals = validProposals(item);
    const selectedId = els.proposals?.querySelector('input[name="bankProposal"]:checked')?.value;
    const proposal = proposals.find((p) => p.id === selectedId) || proposals[0];
    if (!proposal) {
      pendingQueue.shift();
      showNextDialog();
      return;
    }
    const { clientIce } = getContext() || {};
    applyPaymentToLineIndices(lines, proposal.indices, item.txn);
    const bankToken = item.bankToken || normalizeBankAliasToken(item.txn.label);
    if (els.learnAlias?.checked && bankToken) {
      saveBankAlias(clientIce, bankToken, proposal.supplierKey, proposal.lib_frss);
    }
    if (lastStats?.paymentsPending > 0) lastStats.paymentsPending -= 1;
    if (lastStats) lastStats.paymentsMatched += 1;
    pendingQueue.shift();
    skipCloseHandler = true;
    els.dialog?.close();
    skipCloseHandler = false;
    showNextDialog();
  }

  els.confirmBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    confirmMatch();
  });
  els.proposals?.addEventListener("change", updateInvoiceDetail);
  els.dialog?.addEventListener("close", () => {
    if (skipCloseHandler) return;
    if (pendingQueue.length) pendingQueue.shift();
    showNextDialog();
  });

  async function run() {
    if (running) return { ok: false, reason: "busy" };
    const { dossierId, clientIce } = getContext() || {};
    if (!dossierId) return { ok: false, reason: "missing_dossier" };

    running = true;
    try {
      const workspace = await loadDossierWorkspace(dossierId);
      const bankTransactions = workspace?.bank_transactions || [];
      const bankMeta = workspace?.bank_meta || {};
      lines = (workspace?.lines || []).map((line) => ({ ...line }));

      if (!lines.length) {
        showToast?.({
          title: "Aucune ligne facture",
          message: "Lancez d'abord l'extraction des factures importées.",
          variant: "warn",
        });
        return { ok: false, reason: "no_lines" };
      }
      if (!bankTransactions.length) {
        showToast?.({
          title: "Relevé non extrait",
          message: "Importez le relevé bancaire, puis cliquez sur « Extraire le relevé » avant le rapprochement.",
          variant: "warn",
        });
        return { ok: false, reason: "no_bank" };
      }

      const result = applyBankStatement(bankTransactions, lines, {
        sourceFile: bankMeta.filename || "releve_bancaire",
        bankName: bankMeta.bankName || "BANQUE",
        bankIce: bankMeta.bankIce || "",
        bankIf: bankMeta.bankIf || "",
        supplierAliases: bankAliasLookup(clientIce),
      });

      lines = result.lines;
      pendingQueue = result.pendingMatches || [];
      lastStats = { ...result.stats };

      if (pendingQueue.length) {
        showNextDialog();
        return { ok: true, pending: pendingQueue.length, stats: lastStats };
      }

      await persistLines("Rapprochement bancaire appliqué", "bank_apply");
      finishAfterDialog();
      return { ok: true, stats: lastStats };
    } finally {
      running = false;
    }
  }

  return {
    run,
    isRunning: () => running,
  };
}

export function countLinesWithoutPaymentDate(lines = []) {
  return (lines || []).filter((line) => {
    if (line?.designation === "FRAIS BANCAIRE") return false;
    return !String(line?.date_paie || "").trim();
  }).length;
}
