# Recompta : GitHub Pages + Codespace (IA)

**Vous travaillez sur la page GitHub** — pas dans le navigateur du Codespace.

| Où | Rôle |
|----|------|
| https://anaslaghezali-ops.github.io/Recompta/ | **Votre interface** (import, tableau, Excel) |
| Codespace port 8000 (URL publique) | **Moteur IA** invisible en arrière-plan |

---

## Configuration une seule fois

### 1. Dans le Codespace (VS Code web)

Terminal :

```bash
cd backend
# Créez backend/.env avec OPENAI_API_KEY=sk-...
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

**Ne cliquez pas** sur « Open in Browser » — ce n'est pas nécessaire.

### 2. Rendre le port public

1. Panneau **Ports** (en bas)
2. Ligne **8000**
3. Clic droit → **Port Visibility** → **Public**
4. Copiez l'URL affichée, par exemple :
   ```
   https://votre-codespace-8000.app.github.dev
   ```

### 3. Sur la page GitHub (votre vraie interface)

1. Ouvrez **https://anaslaghezali-ops.github.io/Recompta/**
2. Section **Extraction IA (Codespace)**
3. Collez l'URL du port 8000
4. Cliquez **Tester la connexion**
5. Le badge doit afficher **✓ Extraction IA activée**

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

## Coût

- GitHub Pages : gratuit
- Codespaces : ~60 h/mois gratuites
- OpenAI : votre clé existante
