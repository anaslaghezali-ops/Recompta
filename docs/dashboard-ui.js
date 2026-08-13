export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

export function initLucide() {
  if (window.lucide?.createIcons) window.lucide.createIcons();
}

export function renderBadge(statusKey, label) {
  const tone = statusKey === "exported" ? "success"
    : statusKey === "in_review" ? "warn"
      : "neutral";
  return `<span class="dash-badge dash-badge-${tone}">${escapeHtml(label)}</span>`;
}

export function sidebarHtml({ cabinetName, active }) {
  return `
    <aside class="dash-sidebar" id="dashSidebar">
      <div class="dash-brand">
        <div class="dash-brand-mark">R</div>
        <div class="dash-brand-text">
          <strong>Recompta</strong>
          <span title="${escapeHtml(cabinetName)}">${escapeHtml(cabinetName)}</span>
        </div>
      </div>
      <nav class="dash-nav" aria-label="Navigation principale">
        <a href="dossiers.html" class="${active === "portfolio" ? "active" : ""}">
          <i data-lucide="layout-grid"></i> Portefeuille clients
        </a>
        <button type="button" disabled title="Bientôt disponible">
          <i data-lucide="landmark"></i> Banque
        </button>
        <button type="button" disabled title="Bientôt disponible">
          <i data-lucide="settings"></i> Paramètres
        </button>
      </nav>
      <div class="dash-nav-footer">
        <button type="button" class="dash-btn dash-btn-ghost" id="signOutBtn" style="width:100%;justify-content:flex-start;">
          <i data-lucide="log-out"></i> Déconnexion
        </button>
      </div>
    </aside>
  `;
}

export function bindSidebarMobile() {
  const sidebar = document.getElementById("dashSidebar");
  const toggle = document.getElementById("mobileNavToggle");
  toggle?.addEventListener("click", () => sidebar?.classList.toggle("open"));
}
