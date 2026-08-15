import {
  applyBankStatement,
  applyPaymentToLineIndices,
  normalizeBankTransactions,
  parseBankFile,
} from "./bank-statement-client.js";
import {
  bankAliasLookup,
  normalizeBankAliasToken,
  saveBankAlias,
} from "./bank-match-client.js";
import { getApiUrl, saveApiUrl, fetchServerHealth, ensureImportWorkerRunning, parseBankStatementViaServer } from "./api-client.js?v=api8";
import { loadDossierWorkspace } from "./dossier-persistence.js?v=persist1";
import {
  JOB_STATUS_LABELS,
  jobProgressPercent,
  listImportJobs,
  showImportCompletionToast,
  startBankImportUpload,
  startImportJobPolling,
} from "./import-jobs-client.js?v=jobs12";
import { escapeHtml, initLucide } from "./dashboard-ui.js?v=portfolio1";
import {
  createWorkspaceSaver,
  formatFileSize,
  initDossierImportPage,
  persistWorkspaceNow,
  renderImportContextBar,
  shortFilename,
  workspaceBackHref,
} from "./import-dossier.js?v=imp1";
import { uploadDossierDocument } from "./dossier-documents.js?v=doc1";

const els = {};
let session = null;
let pendingBankMatchQueue = [];
let lastBankApplyStats = null;
let skipBankMatchCloseHandler = false;
let bankFile = null;
let queuing = false;
let stopJobPolling = null;

function setStatus(text, tone = "muted") {
  if (!els.saveStatus) return;
  els.saveStatus.textContent = text || "";
  els.saveStatus.dataset.tone = tone;
}

function setWorkerHint(message = "", tone = "muted") {
  if (!els.workerHint) return;
  els.workerHint.hidden = !message;
  els.workerHint.textContent = message || "";
  els.workerHint.dataset.tone = tone;
}

async function triggerWorkerProcessing() {
  const apiUrl = resolvedApiUrl();
  try {
    const result = await ensureImportWorkerRunning(apiUrl, { limit: 1 });
    if (!result.ok) {
      setWorkerHint(result.message, "error");
      return false;
    }
    setWorkerHint(result.message, "success");
    return true;
  } catch (error) {
    setWorkerHint(error.message, "error");
    return false;
  }
}

function resolvedApiUrl() {
  const typed = els.apiUrl?.value?.trim().replace(/\/$/, "") || "";
  return typed || getApiUrl();
}

function formatMad(amount) {
  return Number(amount).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatBankDate(isoDate) {
  if (!isoDate) return "—";
  const [year, month, day] = isoDate.split("-");
  if (!day) return isoDate;
  return `${day}/${month}/${year}`;
}

function markFieldVerified(line, fieldKey) {
  if (!line.user_verified_fields) line.user_verified_fields = [];
  if (!line.user_verified_fields.includes(fieldKey)) line.user_verified_fields.push(fieldKey);
  if (fieldKey === "date_paie") line.date_paie_from_bank = true;
}

function renderTxnTable() {
  const txns = session.bankTransactions || [];
  const payments = txns.filter((t) => t.type === "payment").length;
  const fees = txns.filter((t) => t.type === "fee").length;

  els.txnCount.textContent = String(txns.length);
  els.paymentCount.textContent = String(payments);
  els.feeCount.textContent = String(fees);
  els.lineCountHint.textContent = String(session.lines.length);

  if (!txns.length) {
    els.txnPanel.hidden = true;
    els.applyBtn.disabled = true;
    return;
  }

  els.txnPanel.hidden = false;
  els.applyBtn.disabled = session.lines.length === 0;
  els.txnBody.innerHTML = txns.slice(0, 200).map((txn) => `
    <tr>
      <td>${escapeHtml(formatBankDate(txn.date))}</td>
      <td class="imp-txn-label">${escapeHtml(String(txn.label || "").slice(0, 80))}</td>
      <td class="imp-num">${formatMad(txn.absAmount)}</td>
      <td><span class="imp-txn-type imp-txn-${txn.type}">${txn.type === "fee" ? "Frais" : "Paiement"}</span></td>
    </tr>
  `).join("");

  if (txns.length > 200) {
    els.txnBody.innerHTML += `<tr><td colspan="4" class="imp-muted-cell">… et ${txns.length - 200} autres mouvements</td></tr>`;
  }

  els.bankFileName.textContent = session.bankMeta.filename || bankFile?.name || "Relevé importé";
  els.bankFileMeta.textContent = `${txns.length} mouvement(s) · ${formatFileSize(bankFile?.size || 0)}`;
}

async function loadBankFile(file) {
  if (!file) return;
  bankFile = file;
  updateFileActions();
  els.statusMessage.textContent = "Lecture du relevé…";
  els.statusMessage.className = "imp-status";

  const lower = (file.name || "").toLowerCase();
  const isSpreadsheet = [".csv", ".txt", ".xlsx", ".xls"].some((ext) => lower.endsWith(ext));

  try {
    let transactions = [];
    if (isSpreadsheet) {
      const parsed = await parseBankFile(file);
      transactions = parsed.transactions;
      session.bankMeta = { filename: parsed.filename, bankName: "BANQUE", bankIce: "", bankIf: "" };
    } else {
      const apiUrl = resolvedApiUrl();
      if (!apiUrl) throw new Error("Pour un relevé PDF/image, configurez l'URL du Codespace (port 8000).");
      const result = await parseBankStatementViaServer(file, apiUrl);
      transactions = normalizeBankTransactions(result.transactions);
      session.bankMeta = {
        filename: result.filename || file.name,
        bankName: result.bank_name || "BANQUE",
        bankIce: result.bank_ice || "",
        bankIf: result.bank_if || "",
      };
    }

    session.bankTransactions = transactions;
    renderTxnTable();
    els.statusMessage.textContent = `${transactions.length} mouvement(s) chargé(s).`;
    els.statusMessage.classList.add("is-success");

    uploadDossierDocument({
      dossierId: session.dossierId,
      file,
      docType: "bank",
    }).catch(() => {});

    await persistWorkspaceNow(
      session,
      setStatus,
      "bank_import",
      `Relevé importé (${transactions.length} mvts)`,
    );
  } catch (error) {
    session.bankTransactions = [];
    bankFile = null;
    updateFileActions();
    renderTxnTable();
    els.statusMessage.textContent = `Erreur : ${error.message}`;
    els.statusMessage.className = "imp-status is-error";
  }
}

function updateFileActions() {
  const hasFile = Boolean(bankFile);
  if (els.queueBtn) els.queueBtn.disabled = !hasFile || queuing;
  if (els.loadNowBtn) els.loadNowBtn.disabled = !hasFile || queuing;
}

function formatJobDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-FR", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderJobRow(job) {
  const progress = jobProgressPercent(job);
  const statusLabel = JOB_STATUS_LABELS[job.status] || job.status;
  const tone = job.status === "failed" ? "danger"
    : job.status === "completed" ? "success"
      : job.status === "processing" ? "accent" : "muted";

  return `
    <div class="imp-job-row">
      <div class="imp-job-main">
        <strong>Import relevé — ${formatJobDate(job.created_at)}</strong>
        <span>${escapeHtml(statusLabel)} · ${job.processed_files}/${job.total_files} traité(s)${job.failed_files ? ` · ${job.failed_files} erreur(s)` : ""}</span>
      </div>
      <div class="imp-job-progress">
        <div class="imp-progress-track"><div class="imp-progress-fill imp-job-fill-${tone}" style="width:${progress}%"></div></div>
        <span>${progress}%</span>
      </div>
    </div>
  `;
}

async function renderJobsPanel() {
  const jobs = await listImportJobs(session.dossierId, { limit: 8 });
  const active = jobs.filter((job) => ["uploading", "queued", "processing"].includes(job.status));
  const display = active.length ? active : jobs.slice(0, 3);

  if (!display.length) {
    els.jobsPanel.hidden = true;
    els.jobsList.innerHTML = "";
    return;
  }

  els.jobsPanel.hidden = false;
  els.jobsList.innerHTML = display.map(renderJobRow).join("");
  initLucide();
}

async function reloadSessionBank() {
  const workspace = await loadDossierWorkspace(session.dossierId);
  session.bankTransactions = workspace?.bank_transactions || [];
  session.bankMeta = {
    filename: "",
    bankName: "BANQUE",
    bankIce: "",
    bankIf: "",
    ...(workspace?.bank_meta || {}),
  };
  session.updatedAt = workspace?.updated_at || session.updatedAt;
  renderTxnTable();
  if (session.bankTransactions.length) {
    els.statusMessage.textContent = `${session.bankTransactions.length} mouvement(s) enregistré(s) — lancez le rapprochement.`;
    els.statusMessage.className = "imp-status is-success";
    setStatus(`Dernière sauvegarde : ${new Date(session.updatedAt || Date.now()).toLocaleString("fr-FR")}`, "success");
  }
}

function startJobsPolling() {
  stopJobPolling?.();
  let kickCounter = 0;
  stopJobPolling = startImportJobPolling(session.dossierId, async (jobs) => {
    if (!jobs.length) {
      setWorkerHint("");
      const recent = await listImportJobs(session.dossierId, { limit: 1 });
      const last = recent[0];
      if (last?.status === "completed" && last.doc_type === "bank") {
        showImportCompletionToast(last, { dossierName: session.context.clientName });
      }
      await reloadSessionBank();
      await renderJobsPanel();
      return;
    }
    if (jobs.some((job) => job.status === "queued")) {
      kickCounter += 1;
      if (kickCounter === 1 || kickCounter % 4 === 0) {
        await triggerWorkerProcessing();
      }
    }
    els.jobsPanel.hidden = false;
    els.jobsList.innerHTML = jobs.map(renderJobRow).join("");
    initLucide();
  });
}

async function runQueue() {
  if (!bankFile || queuing) return;
  queuing = true;
  updateFileActions();
  els.progressPanel.hidden = false;
  els.progressText.textContent = "Préparation de l'import…";
  els.progressBar.style.width = "5%";

  const fileToSend = bankFile;
  bankFile = null;
  if (els.fileInput) els.fileInput.value = "";
  updateFileActions();
  startJobsPolling();

  const apiUrl = resolvedApiUrl();
  if (!apiUrl) {
    setWorkerHint("Configurez l'URL du Codespace pour envoyer via le serveur.", "error");
    queuing = false;
    updateFileActions();
    return;
  }

  try {
    await startBankImportUpload({
      dossierId: session.dossierId,
      file: fileToSend,
      options: { api_url: apiUrl },
      onProgress: (message, percent) => {
        els.progressText.textContent = message;
        els.progressBar.style.width = `${percent}%`;
      },
      onFileQueued: async () => {
        await renderJobsPanel();
        await triggerWorkerProcessing();
      },
      onComplete: async () => {
        els.progressText.textContent =
          "Envoi terminé. Traitement en cours sur le serveur — vous pouvez quitter cette page.";
        els.progressBar.style.width = "100%";
        setStatus("Import lancé — traitement en arrière-plan", "success");
        await triggerWorkerProcessing();
        await renderJobsPanel();
        queuing = false;
        updateFileActions();
        initLucide();
      },
      onError: (error) => {
        els.progressText.textContent = `Erreur : ${error.message}`;
        els.progressBar.style.width = "0%";
        setStatus(error.message, "error");
        queuing = false;
        updateFileActions();
        initLucide();
      },
    });

    els.progressText.textContent =
      "Envoi démarré — ouvrez le workspace dans un autre onglet pour suivre. Gardez cet onglet ouvert pendant l'envoi.";
    els.progressBar.style.width = "12%";
    setStatus("Envoi en cours", "success");
    queuing = false;
    updateFileActions();
  } catch (error) {
    els.progressText.textContent = `Erreur : ${error.message}`;
    els.progressBar.style.width = "0%";
    setStatus(error.message, "error");
    queuing = false;
    updateFileActions();
    initLucide();
  }
}

function onFileSelected(file) {
  if (!file) return;
  bankFile = file;
  updateFileActions();
  els.statusMessage.textContent = `${file.name} prêt — mettez en file d'attente ou chargez maintenant.`;
  els.statusMessage.className = "imp-status";
}

function validBankMatchProposals(item) {
  return (item.proposals || []).filter((proposal) =>
    proposal.indices.every((index) => !session.lines[index]?.date_paie_from_bank),
  );
}

function proposalInvoiceRows(proposal) {
  const byFact = new Map();
  for (const index of proposal.indices) {
    const line = session.lines[index];
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

function renderBankMatchTxn(item) {
  const txn = item.txn;
  els.bankMatchTxnDate.textContent = formatBankDate(txn.date);
  els.bankMatchTxnAmount.textContent = `${formatMad(txn.absAmount)} MAD`;
  els.bankMatchTxnLabel.textContent = String(txn.label || "").trim() || "—";
}

function updateBankMatchInvoiceDetail() {
  const item = pendingBankMatchQueue[0];
  if (!item) return;
  const proposals = validBankMatchProposals(item);
  const selectedId = els.bankMatchProposals.querySelector('input[name="bankProposal"]:checked')?.value;
  const proposal = proposals.find((p) => p.id === selectedId) || proposals[0];
  if (!proposal) {
    els.bankMatchInvoiceDetail.hidden = true;
    return;
  }
  const rows = proposalInvoiceRows(proposal);
  els.bankMatchInvoiceList.innerHTML = rows.map((r) =>
    `<li>${escapeHtml(r.fact_num)} — ${formatMad(r.total)} MAD</li>`,
  ).join("");
  els.bankMatchInvoiceDetail.hidden = rows.length === 0;
}

function showNextBankMatchDialog() {
  while (pendingBankMatchQueue.length > 0) {
    const item = pendingBankMatchQueue[0];
    const proposals = validBankMatchProposals(item);
    if (!proposals.length) {
      pendingBankMatchQueue.shift();
      continue;
    }
    renderBankMatchTxn(item);
    els.bankMatchProposals.innerHTML = proposals.map((proposal, index) => {
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
    updateBankMatchInvoiceDetail();
    const bankToken = item.bankToken || normalizeBankAliasToken(item.txn.label);
    els.bankMatchLearnWrap.hidden = !bankToken;
    els.bankMatchDialog.showModal();
    return;
  }
  updateApplyStatus();
}

function confirmBankMatch() {
  const item = pendingBankMatchQueue[0];
  if (!item) return;
  const proposals = validBankMatchProposals(item);
  const selectedId = els.bankMatchProposals.querySelector('input[name="bankProposal"]:checked')?.value;
  const proposal = proposals.find((p) => p.id === selectedId) || proposals[0];
  if (!proposal) {
    pendingBankMatchQueue.shift();
    showNextBankMatchDialog();
    return;
  }
  applyPaymentToLineIndices(session.lines, proposal.indices, item.txn);
  proposal.indices.forEach((i) => markFieldVerified(session.lines[i], "date_paie"));
  const bankToken = item.bankToken || normalizeBankAliasToken(item.txn.label);
  if (els.bankMatchLearnAlias.checked && bankToken) {
    saveBankAlias(session.context.clientIce, bankToken, proposal.supplierKey, proposal.lib_frss);
  }
  if (lastBankApplyStats?.paymentsPending > 0) lastBankApplyStats.paymentsPending -= 1;
  if (lastBankApplyStats) lastBankApplyStats.paymentsMatched += 1;
  pendingBankMatchQueue.shift();
  skipBankMatchCloseHandler = true;
  els.bankMatchDialog.close();
  skipBankMatchCloseHandler = false;
  showNextBankMatchDialog();
  if (!pendingBankMatchQueue.length) {
    persistWorkspaceNow(session, setStatus, "bank_match", "Rapprochement bancaire confirmé");
  }
}

function updateApplyStatus() {
  if (!lastBankApplyStats) return;
  const { paymentsMatched, paymentsUnmatched, paymentsPending, feesAdded } = lastBankApplyStats;
  let msg = `${paymentsMatched} paiement(s) rapproché(s), ${feesAdded} frais ajouté(s).`;
  if (paymentsPending) msg += ` ${paymentsPending} à confirmer.`;
  if (paymentsUnmatched) msg += ` ${paymentsUnmatched} sans facture.`;
  els.statusMessage.textContent = msg;
  els.statusMessage.className = `imp-status ${paymentsUnmatched || paymentsPending ? "is-warn" : "is-success"}`;
}

async function applyRapprochement() {
  if (!session.bankTransactions.length || !session.lines.length) return;
  els.applyBtn.disabled = true;
  els.statusMessage.textContent = "Rapprochement en cours…";

  const result = applyBankStatement(session.bankTransactions, session.lines, {
    sourceFile: session.bankMeta.filename || "releve_bancaire",
    bankName: session.bankMeta.bankName || "BANQUE",
    bankIce: session.bankMeta.bankIce || "",
    bankIf: session.bankMeta.bankIf || "",
    supplierAliases: bankAliasLookup(session.context.clientIce),
  });

  session.lines = result.lines;
  pendingBankMatchQueue = result.pendingMatches || [];
  lastBankApplyStats = { ...result.stats };
  updateApplyStatus();

  if (pendingBankMatchQueue.length) showNextBankMatchDialog();
  else {
    await persistWorkspaceNow(session, setStatus, "bank_apply", "Rapprochement bancaire appliqué");
  }
  els.applyBtn.disabled = session.lines.length === 0;
}

function bindDropZone(zone, input) {
  zone.addEventListener("click", () => input.click());
  ["dragenter", "dragover"].forEach((ev) => {
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("is-dragover"); });
  });
  ["dragleave", "drop"].forEach((ev) => {
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove("is-dragover");
      if (ev === "drop") onFileSelected(e.dataTransfer.files?.[0]);
    });
  });
  input.addEventListener("change", (e) => {
    onFileSelected(e.target.files?.[0]);
    input.value = "";
  });
}

export async function bootImportBanque() {
  [
    "contextBar", "saveStatus", "backLink", "dropZone", "fileInput",
    "queueBtn", "loadNowBtn", "queueHint", "progressPanel", "progressText", "progressBar",
    "jobsPanel", "jobsList", "workerHint",
    "txnPanel", "txnBody", "txnCount", "paymentCount", "feeCount", "lineCountHint",
    "bankFileName", "bankFileMeta", "statusMessage", "applyBtn", "apiUrl",
    "bankMatchDialog", "bankMatchTxnDate", "bankMatchTxnAmount", "bankMatchTxnLabel",
    "bankMatchProposals", "bankMatchInvoiceDetail", "bankMatchInvoiceList",
    "bankMatchLearnWrap", "bankMatchLearnAlias", "bankMatchConfirm",
  ].forEach((id) => { els[id] = document.getElementById(id); });

  session = await initDossierImportPage();
  if (!session) return;

  document.title = `Recompta — Import banque · ${session.context.clientName}`;
  renderImportContextBar(session, els.contextBar);
  els.backLink.href = workspaceBackHref(session.context);

  if (els.apiUrl) {
    els.apiUrl.value = localStorage.getItem("recompta_api_url") || "";
    els.apiUrl.addEventListener("change", () => saveApiUrl(els.apiUrl.value));
  }

  renderTxnTable();
  if (session.bankTransactions.length) {
    els.statusMessage.textContent = `${session.bankTransactions.length} mouvement(s) déjà enregistré(s).`;
  }

  bindDropZone(els.dropZone, els.fileInput);
  els.queueBtn?.addEventListener("click", runQueue);
  els.loadNowBtn?.addEventListener("click", () => loadBankFile(bankFile));
  els.applyBtn.addEventListener("click", applyRapprochement);
  await renderJobsPanel();
  const activeJobs = await listImportJobs(session.dossierId, { limit: 1, activeOnly: true });
  if (activeJobs.some((job) => job.status === "queued")) {
    await triggerWorkerProcessing();
  }
  startJobsPolling();
  els.bankMatchConfirm?.addEventListener("click", (e) => { e.preventDefault(); confirmBankMatch(); });
  els.bankMatchProposals?.addEventListener("change", updateBankMatchInvoiceDetail);
  els.bankMatchDialog?.addEventListener("close", () => {
    if (skipBankMatchCloseHandler) return;
    if (pendingBankMatchQueue.length) pendingBankMatchQueue.shift();
    showNextBankMatchDialog();
  });

  initLucide();
}

bootImportBanque();
