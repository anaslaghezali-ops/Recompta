/**
 * Identifiant stable fichier ↔ résultat d'extraction.
 * Le tag est inséré avant l'extension pour que le backend voie encore .pdf / .jpg.
 */

export const SOURCE_TAG = "__RC__";

export function normalizePath(filename) {
  return String(filename || "").replace(/\\/g, "/");
}

export function tagSourceFilename(filename, sourceId) {
  if (!sourceId) return filename;
  const path = normalizePath(filename);
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return `${path}${SOURCE_TAG}${sourceId}`;
  return `${dir}${base.slice(0, dot)}${SOURCE_TAG}${sourceId}${base.slice(dot)}`;
}

export function parseSourceFilename(name) {
  const raw = normalizePath(name);
  const slash = raw.lastIndexOf("/");
  const dir = slash >= 0 ? raw.slice(0, slash + 1) : "";
  const base = slash >= 0 ? raw.slice(slash + 1) : raw;
  const tagged = base.match(/^(.+)__RC__(src-\d+)(\.[^.]+)$/);
  if (tagged) {
    return { filename: `${dir}${tagged[1]}${tagged[3]}`, sourceId: tagged[2] };
  }
  // Ancien format (tag après l'extension) : facture.pdf__RC__src-0
  const legacy = base.match(/^(.+)__RC__(src-\d+)$/);
  if (legacy) {
    return { filename: `${dir}${legacy[1]}`, sourceId: legacy[2] };
  }
  return { filename: raw, sourceId: "" };
}

/**
 * Un id par résultat. Jamais l'ordre du tableau (lots parallèles).
 * Priorité : source_id explicite → tag dans le nom → nom exact → basename unique.
 * Pas de repli « premier fichier restant » : mieux vaut pas d'aperçu qu'une mauvaise facture.
 */
export function assignSourceIds(records, results) {
  const unused = [...(records || [])];
  const knownIds = new Set(unused.map((rec) => rec.id));

  return (results || []).map((result) => {
    const explicit = String(result?.source_id || "");
    if (explicit && knownIds.has(explicit)) {
      const idx = unused.findIndex((rec) => rec.id === explicit);
      if (idx >= 0) unused.splice(idx, 1);
      return explicit;
    }

    const parsed = parseSourceFilename(result?.filename);
    if (parsed.sourceId && knownIds.has(parsed.sourceId)) {
      const idx = unused.findIndex((rec) => rec.id === parsed.sourceId);
      if (idx >= 0) unused.splice(idx, 1);
      return parsed.sourceId;
    }

    const key = normalizePath(parsed.filename);
    const base = key.split("/").pop();
    let idx = unused.findIndex((rec) => rec.filename === key);
    if (idx < 0 && base) {
      const matches = unused
        .map((rec, i) => (rec.filename.split("/").pop() === base ? i : -1))
        .filter((i) => i >= 0);
      if (matches.length === 1) idx = matches[0];
    }
    if (idx < 0) return "";
    return unused.splice(idx, 1)[0].id;
  });
}
