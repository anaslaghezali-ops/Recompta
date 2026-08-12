const state = {
  files: [],
  lines: [],
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
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  extractBtn: document.getElementById("extractBtn"),
  addLineBtn: document.getElementById("addLineBtn"),
  exportBtn: document.getElementById("exportBtn"),
  extractionStatus: document.getElementById("extractionStatus"),
  linesTableBody: document.querySelector("#linesTable tbody"),
  lineCount: document.getElementById("lineCount"),
};

function emptyLine() {
  return {
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
  els.filenamePreview.textContent = `Fichier: ${client}_DED_TVA_${period}.xlsx`;
}

function updateButtons() {
  els.extractBtn.disabled = state.files.length === 0;
  els.exportBtn.disabled = state.lines.length === 0;
  els.lineCount.textContent = `${state.lines.length} ligne(s)`;
}

function recalcTva(line) {
  const ht = Number(line.m_ht) || 0;
  const taux = Number(line.taux) || 0.2;
  line.tva = Math.round(ht * taux * 100) / 100;
  line.m_ttc = Math.round((ht + line.tva) * 100) / 100;
}

function renderTable() {
  els.linesTableBody.innerHTML = "";
  state.lines.forEach((line, index) => {
    const tr = document.createElement("tr");

    const fields = [
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
          option.textContent = opt;
          input.appendChild(option);
        });
        input.value = String(line[field.key] ?? "");
      } else {
        input = document.createElement("input");
        input.type = field.type;
        if (field.step) input.step = field.step;
        if (field.readonly) input.readOnly = true;
        input.value = line[field.key] ?? "";
      }

      input.addEventListener("change", () => {
        if (field.type === "number") {
          line[field.key] = Number(input.value) || 0;
        } else if (field.key === "taux" || field.key === "id_paie") {
          line[field.key] = field.key === "taux" ? Number(input.value) : Number(input.value);
        } else {
          line[field.key] = input.value;
        }
        if (["m_ht", "taux"].includes(field.key)) {
          recalcTva(line);
          renderTable();
          return;
        }
        updateButtons();
      });

      td.appendChild(input);
      tr.appendChild(td);
    });

    const actionTd = document.createElement("td");
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Suppr.";
    deleteBtn.className = "delete-btn";
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

function setFiles(fileList) {
  state.files = Array.from(fileList);
  const names = state.files.map((f) => f.name).join(", ");
  els.extractionStatus.textContent = state.files.length
    ? `${state.files.length} fichier(s) sélectionné(s): ${names}`
    : "";
  updateButtons();
}

async function extractFiles() {
  if (!state.files.length) return;
  els.extractBtn.disabled = true;
  els.extractionStatus.textContent = "Extraction en cours...";
  els.extractionStatus.classList.remove("error");

  const formData = new FormData();
  state.files.forEach((file) => formData.append("files", file));

  try {
    const response = await fetch("/api/extract", { method: "POST", body: formData });
    if (!response.ok) throw new Error(await response.text());

    const results = await response.json();
    const warnings = [];
    results.forEach((result) => {
      result.lines.forEach((line) => {
        state.lines.push({
          ...emptyLine(),
          ...line,
          date_fac: line.date_fac ? line.date_fac.slice(0, 10) : "",
          date_paie: line.date_paie ? line.date_paie.slice(0, 10) : "",
        });
      });
      if (result.warnings?.length) {
        warnings.push(`${result.filename}: ${result.warnings.join(" | ")}`);
      }
    });

    renderTable();
    updateButtons();
    els.extractionStatus.textContent = warnings.length
      ? `Extraction terminée avec alertes: ${warnings.join(" — ")}`
      : "Extraction terminée. Vérifiez les lignes avant export.";
  } catch (error) {
    els.extractionStatus.textContent = `Erreur: ${error.message}`;
    els.extractionStatus.classList.add("error");
  } finally {
    els.extractBtn.disabled = state.files.length === 0;
  }
}

async function exportExcel() {
  const payload = {
    client_name: els.clientName.value.trim() || "CLIENT",
    period: els.period.value.trim(),
    lines: state.lines.map((line) => ({
      ...line,
      taux: Number(line.taux),
      id_paie: Number(line.id_paie),
      date_fac: line.date_fac || null,
      date_paie: line.date_paie || null,
    })),
  };

  const response = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const message = await response.text();
    alert(`Export impossible: ${message}`);
    return;
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${payload.client_name}_DED_TVA_${payload.period}.xlsx`;
  anchor.click();
  URL.revokeObjectURL(url);
}

els.clientName.addEventListener("input", updateFilenamePreview);
els.period.addEventListener("input", updateFilenamePreview);
els.fileInput.addEventListener("change", (e) => setFiles(e.target.files));
els.extractBtn.addEventListener("click", extractFiles);
els.addLineBtn.addEventListener("click", () => {
  state.lines.push(emptyLine());
  renderTable();
  updateButtons();
});
els.exportBtn.addEventListener("click", exportExcel);

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
    if (eventName === "drop") setFiles(e.dataTransfer.files);
  });
});

updateFilenamePreview();
updateButtons();
