# Recompta : GitHub Pages + Codespace (IA)

**Vous travaillez sur la page GitHub** — pas dans le navigateur du Codespace.

| Où | Rôle |
|----|------|
| https://anaslaghezali-ops.github.io/Recompta/ | **Votre interface** (import, tableau, Excel) |
| Codespace port 8000 (URL publique) | **Moteur IA** invisible en arrière-plan |

---

## Configuration une seule fois

### 1. Créer backend/.env

```bash
cd backend
cp .env.example .env
nano .env
```

Contenu minimal :

```env
OPENAI_API_KEY=sk-votre-clé-ici
SUPABASE_SERVICE_ROLE_KEY=eyJ...votre-clé-service-role...
```

| Variable | Où la trouver |
|---|---|
| `OPENAI_API_KEY` | https://platform.openai.com/api-keys |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → projet **Recompta** → **Project Settings** → **API Keys** → **`service_role` secret** |

> **Important** : la clé `service_role` est **secrète** — elle ne va que dans `backend/.env` sur le Codespace, **jamais** dans GitHub Pages ni dans le code committé.
>
> Elle sert au **worker d'import asynchrone** (lire les fichiers en Storage, écrire les lignes extraites en base). Sans elle, la mise en file d'attente fonctionne mais le traitement en arrière-plan ne démarre pas.

Vérification :
```bash
bash ../scripts/check-codespace.sh
```

### 2. Lancer le serveur

**Restez dans `backend/` pour toute la session.** Git fonctionne aussi depuis ce dossier.

```bash
cd /workspaces/Recompta/backend
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Ou, depuis la racine du repo :

```bash
bash scripts/start-local.sh
```

**Ne cliquez pas** sur « Open in Browser » — ce n'est pas nécessaire.

**Ne coupez pas uvicorn pour faire un `git push`.** Ouvrez un **2ᵉ terminal** (Codespace : `+` à côté du terminal) :

```bash
cd /workspaces/Recompta/backend   # ou la racine, les deux marchent
git add -A
git commit -m "votre message"
git push origin main
```

Uvicorn continue de tourner dans le premier terminal.

### 3. Rendre le port public

1. Panneau **Ports** (en bas)
2. Ligne **8000**
3. Clic droit → **Port Visibility** → **Public**
4. Copiez l'URL affichée, par exemple :
   ```
   https://votre-codespace-8000.app.github.dev
   ```

> **À refaire après chaque redémarrage du Codespace.** La visibilité revient à
> **Privée** par défaut. Un port privé renvoie la page d'authentification GitHub
> au lieu de l'API, ce que le navigateur signale comme une **erreur CORS**
> (`No 'Access-Control-Allow-Origin' header`). Le serveur n'est pas en cause.

### 4. Sur la page GitHub (votre vraie interface)

1. Ouvrez **https://anaslaghezali-ops.github.io/Recompta/**
2. Section **Extraction IA (Codespace)**
3. Collez l'URL du port 8000
4. Cliquez **Tester la connexion**
5. Le badge doit afficher **✓ Extraction IA activée (clé OpenAI valide)**

> Si vous voyez **Clé OpenAI refusée (401)** : la clé dans `backend/.env` est invalide ou expirée.
> Créez une nouvelle clé sur https://platform.openai.com/api-keys puis redémarrez uvicorn.

C'est enregistré dans votre navigateur — vous n'avez pas à refaire à chaque visite (tant que l'URL Codespace ne change pas).

---

## Utilisation quotidienne

1. **Démarrer** le Codespace (GitHub → Code → Codespaces → reprendre)
2. **Lancer** `uvicorn` dans le terminal (commande ci-dessus)
3. **Vérifier** que le port 8000 est Public
4. **Travailler** sur https://anaslaghezali-ops.github.io/Recompta/

---

## Si l'URL Codespace change

À chaque **nouveau** Codespace, l'URL `*.app.github.dev` change → recopiez-la dans GitHub Pages et retestez.

---

## Erreur CORS lors de l'extraction

```
Access to fetch ... has been blocked by CORS policy:
No 'Access-Control-Allow-Origin' header is present
```

Dans l'ordre :

1. **Port 8000 en Public** (cause n°1 — voir étape 3 ci-dessus)
2. **uvicorn tourne toujours** — vérifiez le terminal du Codespace
3. **URL à jour** dans GitHub Pages si le Codespace a été recréé

Le serveur autorise déjà toutes les origines et renvoie ses erreurs en JSON
avec les en-têtes CORS : un vrai plantage s'affiche donc comme un message
d'erreur lisible, pas comme une erreur CORS.

---

## Coût

- GitHub Pages : gratuit
- Codespaces : ~60 h/mois gratuites
- OpenAI : votre clé existante
