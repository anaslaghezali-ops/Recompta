const state = {
  files: [],
  lines: [],
  processedFiles: new Set(),
};

const DESIGNATIONS = [
  "MATIERES CONSOMMABLES",
  "PRESTATIONS",
  "TELEPHONIE",
  "FRAIS BANCAIRE",
];

const els = {
  clientName: document.getElementById("clientName"),
  period: document.getElementById("period"),
  filenamePreview: document.getElementById("filenamePreview"),
  engineBadge: document.getElementById("engineBadge"),
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  fileList: document.getElementById("fileList"),
  extractBtn: document.getElementById("extractBtn"),
  addLineBtn: document.getElementById("addLineBtn"),
  clearBtn: document.getElementById("clearBtn"),
  exportBtn: document.getElementById("exportBtn"),
  extractionStatus: document.getElementById("extractionStatus"),
  linesTableBody: document.querySelector("#linesTable tbody"),
  lineCount: document.getElementById("lineCount"),
  fileCount: document.getElementById("fileCount"),
  emptyState: document.getElementById("emptyState"),
  tableWrap: document.getElementById("tableWrap"),
  steps: document.querySelectorAll(".step"),
};

function emptyLine(sourceFile = "") {
  return {
    source_file: sourceFile,
    fact_num: "",
    designation: "MATIERES CONSOMMABLES",
    m_ht: 0,
    tva: 0,
    m_ttc: 0,
    if: "",
    lib_frss: "",
    ice_frs: "",
    taux: 0.2,
    id_paie: 4,
    date_paie: "",
    date_fac: "",
  };
}

function updateFilenamePreview() {
  const client = els.clientName.value.trim() || "CLIENT";
  const period = els.period.value.trim() || "000000";
  els.filenamePreview.textContent = `Fichier généré : ${client}_DED_TVA_${period}.xlsx`;
}

function setStep(step) {
  els.steps.forEach((el) => {
    const n = Number(el.dataset.step);
    el.classList.toggle("active", n === step);
    el.classList.toggle("done", n < step);
  });
}

function updateButtons() {
  const extracting = els.extractBtn.classList.contains("loading");
  els.extractBtn.disabled = state.files.length === 0 || extracting;
  els.exportBtn.disabled = state.lines.length === 0;
  els.clearBtn.hidden = state.files.length === 0 && state.lines.length === 0;

  const uniqueFiles = new Set(state.lines.map((l) => l.source_file).filter(Boolean));
  els.lineCount.textContent = `${state.lines.length} ligne(s)`;
  els.fileCount.textContent = `${uniqueFiles.size} fichier(s)`;

  const hasLines = state.lines.length > 0;
  els.emptyState.hidden = hasLines;
  els.tableWrap.hidden = !hasLines;

  if (hasLines) setStep(3);
  else if (state.files.length > 0) setStep(2);
  else setStep(1);
}

function recalcTva(line) {
  const ht = Number(line.m_ht) || 0;
  const taux = Number(line.taux) || 0.2;
  line.tva = Math.round(ht * taux * 100) / 100;
  line.m_ttc = Math.round((ht + line.tva) * 100) / 100;
}

function shortFilename(name) {
  if (!name) return "";
  const parts = name.split("/");
  return parts.length > 1 ? parts.slice(-2).join("/") : name;
}

function renderFileList() {
  if (!state.files.length) {
    els.fileList.hidden = true;
    els.fileList.innerHTML = "";
    return;
  }

  els.fileList.hidden = false;
  els.fileList.innerHTML = state.files
    .map((file) => {
      const isZip = file.name.toLowerCase().endsWith(".zip");
      const icon = isZip ? "🗜️" : file.type === "application/pdf" ? "📄" : "🖼️";
      return `<div class="file-item">${icon} <span>${file.name}</span> <span class="file-size">${formatSize(file.size)}</span></div>`;
    })
    .join("");
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function renderTable() {
  els.linesTableBody.innerHTML = "";
  state.lines.forEach((line, index) => {
    const tr = document.createElement("tr");

    const fields = [
      { key: "source_file", type: "text", readonly: true, title: true },
      { key: "fact_num", type: "text" },
      { key: "lib_frss", type: "text" },
      { key: "ice_frs", type: "text" },
      { key: "if", type: "text" },
      { key: "designation", type: "select", options: DESIGNATIONS },
      { key: "m_ht", type: "number", step: "0.01" },
      { key: "tva", type: "number", step: "0.01", readonly: true },
      { key: "m_ttc", type: "number", step: "0.01", readonly: true },
      { key: "taux", type: "select", options: ["0.1", "0.2"] },
      { key: "date_fac", type: "date" },
      { key: "date_paie", type: "date" },
      { key: "id_paie", type: "select", options: ["1", "4"] },
    ];

    fields.forEach((field) => {
      const td = document.createElement("td");
      let input;

      if (field.type === "select") {
        input = document.createElement("select");
        field.options.forEach((opt) => {
          const option = document.createElement("option");
          option.value = opt;
          option.textContent = field.key === "taux" ? `${Number(opt) * 100}%` : opt;
          input.appendChild(option);
        });
        input.value = String(line[field.key] ?? "");
      } else {
        input = document.createElement("input");
        input.type = field.type;
        if (field.step) input.step = field.step;
        if (field.readonly) input.readOnly = true;
        const display = field.key === "source_file" ? shortFilename(line[field.key]) : (line[field.key] ?? "");
        input.value = display;
        if (field.title && line[field.key]) input.title = line[field.key];
      }

      if (!field.readonly) {
        input.addEventListener("change", () => {
          if (field.type === "number") {
            line[field.key] = Number(input.value) || 0;
          } else if (field.key === "taux" || field.key === "id_paie") {
            line[field.key] = Number(input.value);
          } else {
            line[field.key] = input.value;
          }
          if (["m_ht", "taux"].includes(field.key)) {
            recalcTva(line);
            renderTable();
            return;
          }
        });
      }

      td.appendChild(input);
      tr.appendChild(td);
    });

    const actionTd = document.createElement("td");
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "✕";
    deleteBtn.className = "delete-btn";
    deleteBtn.title = "Supprimer cette ligne";
    deleteBtn.addEventListener("click", () => {
      state.lines.splice(index, 1);
      renderTable();
      updateButtons();
    });
    actionTd.appendChild(deleteBtn);
    tr.appendChild(actionTd);

    els.linesTableBody.appendChild(tr);
  });
}

function addFiles(fileList) {
  const incoming = Array.from(fileList);
  const existing = new Set(state.files.map((f) => `${f.name}-${f.size}`));
  incoming.forEach((file) => {
    const key = `${file.name}-${file.size}`;
    if (!existing.has(key)) {
      state.files.push(file);
      existing.add(key);
    }
  });
  renderFileList();
  updateButtons();
  if (state.files.length > 0) {
    els.extractionStatus.textContent = `${state.files.length} fichier(s) prêt(s) à extraire.`;
    els.extractionStatus.classList.remove("error", "success");
  }
}

function setLoading(loading) {
  els.extractBtn.classList.toggle("loading", loading);
  els.extractBtn.querySelector(".btn-label").textContent = loading
    ? "Extraction en cours…"
    : "Extraire les factures";
  els.extractBtn.querySelector(".spinner").hidden = !loading;
  updateButtons();
}

async function loadEngineInfo() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (data.ai_configured) {
      els.engineBadge.hidden = false;
      els.engineBadge.className = "engine-badge ai";
      els.engineBadge.textContent = "✓ Extraction IA activée (OpenAI Vision)";
    } else {
      els.engineBadge.hidden = false;
      els.engineBadge.className = "engine-badge tesseract";
      els.engineBadge.textContent =
        "OCR local (Tesseract) — ajoutez OPENAI_API_KEY côté serveur pour l'IA";
    }
  } catch {
    /* ignore */
  }
}

function engineLabel(engine) {
  if (engine === "ai") return "IA";
  if (engine === "tesseract") return "OCR";
  if (engine === "text") return "PDF";
  return "";
}

async function extractFiles() {
  if (!state.files.length) return;

  setLoading(true);
  els.extractionStatus.textContent = "Extraction OCR en cours, cela peut prendre 1 à 2 minutes…";
  els.extractionStatus.classList.remove("error", "success");

  const formData = new FormData();
  state.files.forEach((file) => formData.append("files", file));

  try {
    const response = await fetch("/api/extract", { method: "POST", body: formData });
    if (!response.ok) throw new Error(await response.text());

    const results = await response.json();
    let newLines = 0;
    let okFiles = 0;
    let warnFiles = 0;
    const warnings = [];

    results.forEach((result) => {
      if (result.lines?.length) {
        okFiles += 1;
        result.lines.forEach((line) => {
          state.lines.push({
            ...emptyLine(result.filename),
            ...line,
            source_file: result.filename,
            _engine: result.engine,
            date_fac: line.date_fac ? line.date_fac.slice(0, 10) : "",
            date_paie: line.date_paie ? line.date_paie.slice(0, 10) : "",
          });
          newLines += 1;
        });
      } else {
        warnFiles += 1;
      }
      if (result.warnings?.length) {
        const eng = engineLabel(result.engine);
        warnings.push(`[${eng}] ${shortFilename(result.filename)}: ${result.warnings.join(", ")}`);
      }
    });

    state.files = [];
    renderFileList();
    renderTable();
    updateButtons();
    setStep(3);

    let msg = `${newLines} ligne(s) extraite(s) depuis ${okFiles} facture(s).`;
    if (warnFiles) msg += ` ${warnFiles} fichier(s) sans résultat.`;
    if (warnings.length) msg += ` Vérifiez les montants signalés.`;

    els.extractionStatus.textContent = msg;
    els.extractionStatus.classList.add(warnings.length ? "" : "success");
    if (warnings.length) els.extractionStatus.classList.add("warn");
  } catch (error) {
    els.extractionStatus.textContent = `Erreur : ${error.message}`;
    els.extractionStatus.classList.add("error");
  } finally {
    setLoading(false);
  }
}

async function exportExcel() {
  setStep(4);
  const payload = {
    client_name: els.clientName.value.trim() || "CLIENT",
    period: els.period.value.trim(),
    lines: state.lines.map(({ source_file, ...line }) => ({
      ...line,
      taux: Number(line.taux),
      id_paie: Number(line.id_paie),
      date_fac: line.date_fac || null,
      date_paie: line.date_paie || null,
    })),
  };

  els.exportBtn.disabled = true;
  els.exportBtn.textContent = "Génération…";

  try {
    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${payload.client_name}_DED_TVA_${payload.period}.xlsx`;
    anchor.click();
    URL.revokeObjectURL(url);

    els.extractionStatus.textContent = `Fichier ${anchor.download} téléchargé avec succès.`;
    els.extractionStatus.classList.add("success");
  } catch (error) {
    alert(`Export impossible : ${error.message}`);
  } finally {
    els.exportBtn.textContent = "Télécharger Excel";
    updateButtons();
  }
}

function clearAll() {
  state.files = [];
  state.lines = [];
  renderFileList();
  renderTable();
  els.extractionStatus.textContent = "";
  els.extractionStatus.className = "status";
  els.fileInput.value = "";
  updateButtons();
  setStep(1);
}

els.clientName.addEventListener("input", updateFilenamePreview);
els.period.addEventListener("input", updateFilenamePreview);
els.fileInput.addEventListener("change", (e) => addFiles(e.target.files));
els.extractBtn.addEventListener("click", extractFiles);
els.addLineBtn.addEventListener("click", () => {
  state.lines.push(emptyLine());
  renderTable();
  updateButtons();
});
els.exportBtn.addEventListener("click", exportExcel);
els.clearBtn.addEventListener("click", clearAll);

["dragenter", "dragover"].forEach((eventName) => {
  els.dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    els.dropZone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  els.dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    els.dropZone.classList.remove("dragover");
    if (eventName === "drop") addFiles(e.dataTransfer.files);
  });
});

updateFilenamePreview();
updateButtons();
setStep(1);
loadEngineInfo();

// Redirection login si mode SaaS activé
import("/auth.js").then(async ({ getSupabase, requireAuth }) => {
  const sb = await getSupabase();
  if (sb) await requireAuth("/login.html");
}).catch(() => {});
