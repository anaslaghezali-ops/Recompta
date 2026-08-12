#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../backend"

if [ ! -f .env ] && [ -f .env.example ]; then
  echo "Copiez .env.example vers .env et ajoutez OPENAI_API_KEY"
  exit 1
fi

echo "Démarrage Recompta sur http://localhost:8000"
echo "Pour GitHub Pages + IA : lancez dans un autre terminal :"
echo "  cloudflared tunnel --url http://localhost:8000"
echo ""

python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
