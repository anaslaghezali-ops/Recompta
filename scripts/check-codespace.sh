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

if [ -f .env ] && grep -qE '^OPENAI_API_KEY=sk-' .env 2>/dev/null; then
  echo "✓ OPENAI_API_KEY trouvée dans backend/.env"
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
