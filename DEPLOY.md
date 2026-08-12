# Mettre Recompta en ligne (lien web)

GitHub Pages **ne fonctionne pas** pour Recompta : c'est une application Python (OCR, IA, Excel), pas une simple page HTML.

Voici comment obtenir un **lien du type** `https://recompta.onrender.com` **gratuitement** avec Render.

## Deux façons d'utiliser Recompta sur le web

### Option A — Tout-en-un avec IA (recommandé)

Déployez le backend sur **Render** (gratuit) : vous obtenez **une seule URL** qui sert l'interface + l'IA.

1. Suivez les étapes ci-dessous (Blueprint Render + `OPENAI_API_KEY`)
2. Ouvrez votre lien `https://recompta-xxxx.onrender.com`
3. Le badge vert **« Extraction IA activée »** confirme que tout fonctionne

### Option B — GitHub Pages + serveur IA

- Interface : https://anaslaghezali-ops.github.io/Recompta/
- Dans **Extraction IA**, cochez l'option et collez l'URL Render (ex. `https://recompta-xxxx.onrender.com`)
- L'interface reste sur GitHub ; l'extraction passe par votre serveur (clé OpenAI sécurisée)

> OpenAI bloque les appels directs depuis le navigateur (CORS). La clé API doit rester sur le serveur Render.

---

## Étapes Render (15 minutes, une seule fois)

### 1. Créer un compte Render

Allez sur https://render.com et connectez-vous avec **GitHub**.

### 2. Créer le service web

1. Cliquez **New +** → **Blueprint**
2. Connectez le repo **anaslaghezali-ops/Recompta**
3. Render détecte le fichier `render.yaml` automatiquement
4. Cliquez **Apply**

### 3. Ajouter votre clé OpenAI

1. Dans le dashboard Render → votre service **recompta**
2. Onglet **Environment**
3. Ajoutez la variable :
   - **Key** : `OPENAI_API_KEY`
   - **Value** : `sk-votre-clé-openai`
4. Sauvegardez → Render redémarre l'app

### 4. Ouvrir le lien

Render vous donne une URL, par exemple :

```
https://recompta-xxxx.onrender.com
```

Partagez ce lien : vos collaborateurs peuvent importer des ZIP et exporter l'Excel **sans installer quoi que ce soit**.

---

## Alternative : Railway

1. https://railway.app → connexion GitHub
2. **New Project** → **Deploy from GitHub** → Recompta
3. Railway détecte le `Dockerfile`
4. Variables → ajoutez `OPENAI_API_KEY`
5. **Settings** → **Generate Domain** pour obtenir le lien

---

## Pourquoi pas GitHub Pages ?

| GitHub Pages | Recompta |
|--------------|----------|
| Pages HTML statiques | Serveur Python |
| Pas d'OCR / IA | OCR + OpenAI |
| Pas d'upload fichiers côté serveur | Upload ZIP + export Excel |

---

## Clé API : où la mettre ?

| ❌ Ne pas faire | ✅ À faire |
|----------------|-----------|
| Fichier `.env` sur GitHub | Variable d'environnement sur **Render / Railway** |
| Committer la clé dans le code | Dashboard hébergeur → Environment |

La clé reste **secrète** sur le serveur, jamais visible sur GitHub.
