/**
 * Fiche client modifiable (nom, ICE, coordonnées de facturation).
 * Partagée par le portefeuille et l'espace de travail du client.
 */
import { getSupabase } from "./auth-client.js?v=auth10";

const BILLING_FIELDS = ["billing_address", "billing_city", "billing_if", "billing_email", "billing_phone"];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function db() {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase non configuré");
  return supabase;
}

export async function loadClient(clientId) {
  const { data, error } = await db().from("cabinet_clients").select("*").eq("id", clientId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Client introuvable ou accès non autorisé.");
  return data;
}

/** Met à jour la fiche. Les coordonnées de facturation sont ignorées si la base ne les connaît pas encore. */
export async function updateClient(clientId, values, { hasBilling = true } = {}) {
  const name = String(values.name || "").trim();
  const ice = String(values.ice || "").replace(/\D/g, "");
  if (name.length < 2) throw new Error("Nom du client requis (2 caractères minimum).");
  if (ice.length !== 15) throw new Error("ICE invalide (15 chiffres exactement).");
  const email = String(values.billing_email || "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Adresse email invalide.");
  const payload = { name, ice };
  if (hasBilling) for (const k of BILLING_FIELDS) payload[k] = String(values[k] || "").trim() || null;
  const { data, error } = await db().from("cabinet_clients").update(payload).eq("id", clientId).select("*");
  if (error) {
    if (error.code === "23505") throw new Error("Un autre client du cabinet a déjà cet ICE.");
    throw new Error(error.message || "Enregistrement impossible.");
  }
  if (!data?.length) throw new Error("Vous n'avez pas le droit de modifier ce client.");
  return data[0];
}

let dialog = null;

function ensureDialog() {
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.className = "dash-modal rc-team-dialog";
  dialog.id = "clientEditDialog";
  dialog.setAttribute("aria-labelledby", "clientEditTitle");
  dialog.innerHTML = `
    <form class="dash-modal-inner rc-form" novalidate>
      <h3 id="clientEditTitle">Modifier le client</h3>
      <label class="rc-field"><span>Raison sociale</span><input type="text" name="name" required minlength="2" autocomplete="off" /></label>
      <label class="rc-field"><span>ICE</span><input type="text" name="ice" required inputmode="numeric" maxlength="15" autocomplete="off" />
        <small>15 chiffres. Il sert à reconnaître les factures d'achat et de vente de ce client.</small></label>
      <div class="rc-client-billing" data-billing>
        <p class="rc-client-billing-title">Coordonnées de facturation</p>
        <label class="rc-field"><span>Adresse</span><input type="text" name="billing_address" autocomplete="off" /></label>
        <span class="rc-field-row">
          <label class="rc-field"><span>Ville</span><input type="text" name="billing_city" autocomplete="off" /></label>
          <label class="rc-field"><span>Identifiant fiscal (IF)</span><input type="text" name="billing_if" inputmode="numeric" autocomplete="off" /></label>
        </span>
        <span class="rc-field-row">
          <label class="rc-field"><span>Email</span><input type="email" name="billing_email" autocomplete="off" /></label>
          <label class="rc-field"><span>Téléphone</span><input type="tel" name="billing_phone" autocomplete="off" /></label>
        </span>
      </div>
      <p class="rc-form-error" data-error hidden></p>
      <div class="dash-form-actions">
        <button type="button" class="dash-btn" data-cancel>Annuler</button>
        <button type="submit" class="dash-btn dash-btn-primary" data-submit>Enregistrer</button>
      </div>
    </form>`;
  document.body.appendChild(dialog);
  const ice = dialog.querySelector('[name="ice"]');
  ice.addEventListener("input", () => { ice.value = ice.value.replace(/\D/g, "").slice(0, 15); });
  dialog.querySelector("[data-cancel]").addEventListener("click", () => dialog.close());
  return dialog;
}

/**
 * Ouvre la fiche du client. Résout avec le client mis à jour, ou null si annulé.
 */
export async function openClientEditor(clientId) {
  const dlg = ensureDialog();
  const form = dlg.querySelector("form");
  const errorEl = dlg.querySelector("[data-error]");
  const showError = (msg) => { errorEl.hidden = !msg; errorEl.textContent = msg || ""; };
  const client = await loadClient(clientId);
  const hasBilling = "billing_address" in client;
  dlg.querySelector("[data-billing]").hidden = !hasBilling;
  dlg.querySelector("#clientEditTitle").innerHTML = `Modifier ${esc(client.name)}`;
  for (const el of form.elements) if (el.name) el.value = client[el.name] ?? "";
  showError("");
  dlg.showModal();
  form.elements.name.focus();

  return new Promise((resolve) => {
    let saved = null;
    const submit = dlg.querySelector("[data-submit]");
    form.onsubmit = async (event) => {
      event.preventDefault();
      showError("");
      const values = Object.fromEntries([...form.elements].filter((e) => e.name).map((e) => [e.name, e.value]));
      submit.disabled = true;
      try {
        saved = await updateClient(clientId, values, { hasBilling });
        dlg.close();
      } catch (err) {
        showError(err.message);
      } finally {
        submit.disabled = false;
      }
    };
    dlg.addEventListener("close", () => resolve(saved), { once: true });
  });
}
