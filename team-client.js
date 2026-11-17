/**
 * Équipe du cabinet : appels à l'Edge Function cabinet-team.
 */
import { SUPABASE_URL, authHeaders, getSession, updatePassword } from "./auth-client.js?v=auth10";

async function call(action, payload = {}) {
  const session = await getSession();
  if (!session?.access_token) throw new Error("Session expirée. Reconnectez-vous.");
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/cabinet-team`, {
      method: "POST",
      headers: authHeaders(session),
      body: JSON.stringify({ action, ...payload }),
    });
  } catch {
    throw new Error("Le service Équipe ne répond pas. Vérifiez votre connexion puis réessayez.");
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (response.status === 404) {
    throw new Error("Le service Équipe n'est pas encore déployé (Edge Function cabinet-team).");
  }
  if (!response.ok) throw new Error(body.error || `Erreur serveur (${response.status})`);
  return body;
}

export const ROLE_LABELS = {
  owner: "Responsable",
  admin: "Administrateur",
  comptable: "Collaborateur",
};

export const ROLE_HINTS = {
  owner: "Gère le cabinet, l'équipe et tous les dossiers.",
  admin: "Gère les collaborateurs et tous les dossiers.",
  comptable: "Travaille uniquement sur les clients qui lui sont attribués.",
};

export const loadTeam = () => call("list");
export const addTeamMember = (member) => call("add", member);
export const setTeamRole = (userId, role) => call("set_role", { user_id: userId, role });
export const setTeamMemberActive = (userId, active) => call("set_active", { user_id: userId, active });
export const resetTeamPassword = (userId, password) => call("reset_password", { user_id: userId, password });
export const setTeamClients = (userId, clientIds) => call("set_clients", { user_id: userId, client_ids: clientIds });
export const updateTeamProfile = (userId, displayName) => call("update_profile", { user_id: userId, display_name: displayName });

/** Changer son propre mot de passe (session courante). */
export const changeMyPassword = (password) => updatePassword(password);

/** Mot de passe lisible : 3 blocs de 4 caractères sans ambiguïté. */
export function generatePassword() {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(12);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((n) => alphabet[n % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}
