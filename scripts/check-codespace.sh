#!/usr/bin/env bash
# Vérification rapide dans le Codespace
set -euo pipefail
cd "$(dirname "$0")/../backend"

echo "=== Recompta — vérification Codespace ==="

if command -v tesseract >/dev/null 2>&1; then
  echo "✓ Tesseract installé: $(tesseract --version 2>&1 | head -1)"
else
  echo "✗ Tesseract absent — installation…"
  sudo apt-get update -qq && sudo apt-get install -y -qq tesseract-ocr tesseract-ocr-fra tesseract-ocr-eng
  echo "✓ Tesseract installé"
fi

if [ -f .env ] && grep -qE '^[[:space:]]*OPENAI_API_KEY[[:space:]]*=' .env 2>/dev/null; then
  echo "✓ Fichier backend/.env trouvé"
  python3 - <<'PY'
import asyncio
import os
import re
from pathlib import Path

from dotenv import load_dotenv

from invoice_extractor import verify_openai_key

env_path = Path(".env")
load_dotenv(env_path, override=True)

api_key = os.getenv("OPENAI_API_KEY", "").strip().strip('"').strip("'")
if api_key:
    os.environ["OPENAI_API_KEY"] = api_key

if not api_key.startswith("sk-"):
    print("✗ OPENAI_API_KEY introuvable ou mal formatée dans backend/.env")
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            if re.search(r"OPENAI_API_KEY", line, re.I):
                preview = line.strip()
                if len(preview) > 48:
                    preview = preview[:45] + "..."
                print(f"  Ligne détectée : {preview}")
    print("  Format attendu (une seule ligne, sans guillemets) :")
    print("    OPENAI_API_KEY=sk-votre-clé-ici")
    raise SystemExit(1)

ok, message = asyncio.run(verify_openai_key())
if ok:
    print("✓ Clé OpenAI valide (test API réussi)")
else:
    print(f"✗ {message}")
    raise SystemExit(1)
PY
else
  echo ""
  echo "✗ OPENAI_API_KEY manquante !"
  echo "  Créez backend/.env :"
  echo "    cp .env.example .env"
  echo "    nano .env   # ajoutez OPENAI_API_KEY=sk-..."
  echo "  Puis redémarrez uvicorn (Ctrl+C puis relancez)."
  exit 1
fi

echo ""
echo "Lancez le serveur :"
echo "  python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload"
