# Recompta sans Render (gratuit, avec OpenAI)

Render demande une carte bancaire → **on ne l'utilise pas**.

Vous avez déjà `OPENAI_API_KEY` : voici comment avoir l'IA **sans payer d'hébergement**.

---

## Option 1 — Tout sur votre PC (le plus simple)

```bash
cd backend
pip install -r requirements.txt
# Vérifiez que backend/.env contient OPENAI_API_KEY=sk-...
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

Ouvrez **http://localhost:8000** → interface + extraction IA.

Rien à déployer, rien à payer.

---

## Option 2 — GitHub Pages + backend local (tunnel gratuit)

Gardez l'interface sur https://anaslaghezali-ops.github.io/Recompta/ et l'IA sur votre PC.

### 1. Lancer le backend

```bash
cd backend
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

### 2. Exposer avec Cloudflare Tunnel (gratuit, sans carte)

Installez [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) puis :

```bash
cloudflared tunnel --url http://localhost:8000
```

Vous obtenez une URL du type :

```
https://random-words.trycloudflare.com
```

### 3. Configurer GitHub Pages

1. Ouvrez https://anaslaghezali-ops.github.io/Recompta/
2. Section **Extraction IA** → collez l'URL du tunnel
3. Cochez **Utiliser l'IA Vision**
4. Le badge doit afficher **Extraction IA activée**

> Le tunnel doit rester ouvert tant que vous utilisez l'app. Fermez le terminal = lien mort (relancez cloudflared).

---

## Option 3 — Hugging Face Spaces (gratuit, lien permanent)

1. Compte gratuit sur https://huggingface.co
2. **New Space** → SDK **Docker** → repo Recompta
3. Secrets du Space : `OPENAI_API_KEY`
4. URL du Space → collez dans GitHub Pages (section Extraction IA)

(Hébergement gratuit, pas de carte — configuration un peu plus longue.)

---

## Ce que vous payez vraiment

| Service | Coût |
|---------|------|
| GitHub Pages | Gratuit |
| Cloudflare Tunnel | Gratuit |
| Backend sur votre PC | Gratuit |
| **OpenAI** (scans) | ~0,01–0,03 € / facture (votre clé existante) |
| Render | **On n'utilise pas** |

---

## Script rapide (Option 2)

```bash
./scripts/start-local.sh
```

Puis dans un autre terminal :

```bash
cloudflared tunnel --url http://localhost:8000
```
