# Recompta sur GitHub Codespaces (gratuit + IA)

Oui — **Codespaces** convient très bien : pas de Render, pas de carte bancaire pour l'hébergement.

Le repo contient déjà `.devcontainer/devcontainer.json` (Python, Tesseract, port 8000).

---

## Démarrage (5 minutes)

### 1. Créer un Codespace

1. Allez sur https://github.com/anaslaghezali-ops/Recompta
2. Bouton vert **Code** → onglet **Codespaces**
3. **Create codespace on main**
4. Attendez la fin de l'installation automatique (~2–3 min)

### 2. Ajouter votre clé OpenAI

Dans le terminal du Codespace :

```bash
cd backend
cp .env.example .env
nano .env   # ou éditez dans l'explorateur : OPENAI_API_KEY=sk-...
```

**Ou** (plus propre) : GitHub → **Settings** → **Secrets and variables** → **Codespaces** → New secret → `OPENAI_API_KEY`

### 3. Lancer l'app

```bash
cd backend
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### 4. Ouvrir dans le navigateur

- Onglet **Ports** (en bas) → ligne **8000**
- Clic droit → **Open in Browser**

Vous avez l'interface + **extraction IA** — comme un site web, sans Render.

---

## Utiliser avec GitHub Pages (optionnel)

Si vous préférez l'interface sur `github.io` :

1. Ports → **8000** → **Port visibility** → **Public**
2. Copiez l'URL du type `https://xxxx-8000.app.github.dev`
3. Collez-la dans **Extraction IA** sur https://anaslaghezali-ops.github.io/Recompta/

> Le Codespace doit rester **allumé** et le serveur **lancé**.

---

## Gratuit ?

| | |
|---|---|
| **Codespaces** | ~**60 h/mois** gratuites (compte GitHub personnel) |
| **OpenAI** | Payant à l'usage (votre clé) |
| **Render** | Pas utilisé |

Quand les heures gratuites sont épuisées, le Codespace s'arrête jusqu'au mois suivant — ou lancez en **local** (voir [SANS-RENDER.md](SANS-RENDER.md)).

---

## Vérifier que l'IA est active

Sur http://localhost:8000 (ou l'URL Ports), le badge doit afficher :

**« ✓ Extraction IA activée »**

Ou testez : `curl http://localhost:8000/api/health`
