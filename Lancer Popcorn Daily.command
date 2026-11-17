#!/usr/bin/env bash
# ==============================================================================
# 🍿 Lancer Popcorn Daily.command
# Double-cliquer sur ce fichier pour ouvrir le Guide d'Animation Daily Popcorn.
# Met automatiquement à jour l'outil depuis GitHub et ouvre http://localhost:4343
# ==============================================================================

export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.popcorn-daily/runtime/node/bin:${PATH:-/usr/bin:/bin}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "${SCRIPT_DIR}/ui/server.mjs" ]; then
  APP_DIR="${SCRIPT_DIR}"
elif [ -f "${HOME}/.popcorn-daily/app/ui/server.mjs" ]; then
  APP_DIR="${HOME}/.popcorn-daily/app"
elif [ -f "${HOME}/.gemini/config/skills/popcorn-daily/ui/server.mjs" ]; then
  APP_DIR="${HOME}/.gemini/config/skills/popcorn-daily"
else
  echo "❌ Application introuvable. Lancement de l'installateur..."
  curl -fsSL https://raw.githubusercontent.com/fawr-ubi/popcorn-daily/main/setup-mac.sh | bash
  exit 0
fi

# Auto-update quietly from GitHub
if [ -d "${APP_DIR}/.git" ]; then
  # For developers/users with git installed
  git -C "${APP_DIR}" pull --ff-only >/dev/null 2>&1 || true
else
  # For POs without git: download latest tarball and overwrite files
  curl -fsSL "https://github.com/fawr-ubi/popcorn-daily/archive/refs/heads/main.tar.gz" | tar -xz -C "${APP_DIR}" --strip-components=1 2>/dev/null || true
fi

PORT=4343
URL="http://localhost:${PORT}"

# Kill any ghost server still holding the port to ensure we run the newly downloaded code
PIDS=$(lsof -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null || true)
if [ -n "${PIDS}" ]; then
  echo "🔄 Redémarrage du serveur existant..."
  kill -9 ${PIDS} 2>/dev/null || true
  sleep 0.5
fi

echo "🍿 Démarrage de Popcorn Daily sur ${URL} ..."
nohup node "${APP_DIR}/ui/server.mjs" >/tmp/popcorn-daily-ui.log 2>&1 &

# Wait up to 5 seconds for server to bind
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if lsof -iTCP:${PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
    break
  fi
  sleep 0.3
done

open "${URL}"
echo "✅ Popcorn Daily est ouvert dans ton navigateur (${URL}). Tu peux fermer cette fenêtre."
