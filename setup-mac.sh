#!/usr/bin/env bash
# ==============================================================================
# Popcorn Daily — Zero-Tech 1-Click Installer for macOS (PO & Scrum Master)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/fawr-ubi/popcorn-daily/main/setup-mac.sh | bash
# ==============================================================================
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.popcorn-daily/runtime/node/bin:${PATH:-/usr/bin:/bin}"

APP_HOME="${HOME}/.popcorn-daily"
REPO_DIR="${APP_HOME}/app"
RUNTIME_DIR="${APP_HOME}/runtime"
REPO_URL="https://github.com/fawr-ubi/popcorn-daily.git"
DESKTOP_SHORTCUT="${HOME}/Desktop/🍿 Popcorn Daily.command"

echo ""
echo "🍿 ========================================================="
echo "   Installation de Popcorn Daily (Guide d'Animation Daily)"
echo "============================================================"
echo ""

mkdir -p "${APP_HOME}" "${RUNTIME_DIR}"

# 1. Ensure Node.js (>= 18) is available — if not, download official portable Node.js for macOS (Zero sudo / Zero Homebrew required!)
if ! command -v node >/dev/null 2>&1; then
  echo "⏳ Téléchargement automatique du moteur Node.js pour Mac (aucun mot de passe requis)..."
  ARCH="$(uname -m)"
  if [ "${ARCH}" = "arm64" ]; then
    NODE_ARCH="arm64"
  else
    NODE_ARCH="x64"
  fi
  NODE_VER="v22.14.0"
  NODE_TAR="node-${NODE_VER}-darwin-${NODE_ARCH}.tar.gz"
  NODE_URL="https://nodejs.org/dist/${NODE_VER}/${NODE_TAR}"

  rm -rf "${RUNTIME_DIR}/node"
  mkdir -p "${RUNTIME_DIR}/node"
  curl -fsSL "${NODE_URL}" | tar -xz -C "${RUNTIME_DIR}/node" --strip-components=1
  export PATH="${RUNTIME_DIR}/node/bin:${PATH}"
  echo "✅ Moteur Node.js installé automatiquement (${NODE_VER})."
fi

# 2. Download or update Popcorn Daily application
if [ -d "${REPO_DIR}/.git" ]; then
  echo "⏳ Mise à jour de Popcorn Daily..."
  git -C "${REPO_DIR}" pull --ff-only >/dev/null 2>&1 || true
elif command -v git >/dev/null 2>&1; then
  echo "⏳ Téléchargement de Popcorn Daily depuis GitHub..."
  rm -rf "${REPO_DIR}"
  git clone --depth 1 "${REPO_URL}" "${REPO_DIR}" >/dev/null 2>&1 || {
    mkdir -p "${REPO_DIR}"
    curl -fsSL "https://github.com/fawr-ubi/popcorn-daily/archive/refs/heads/main.tar.gz" | tar -xz -C "${REPO_DIR}" --strip-components=1
  }
else
  echo "⏳ Téléchargement de Popcorn Daily..."
  rm -rf "${REPO_DIR}"
  mkdir -p "${REPO_DIR}"
  curl -fsSL "https://github.com/fawr-ubi/popcorn-daily/archive/refs/heads/main.tar.gz" | tar -xz -C "${REPO_DIR}" --strip-components=1
fi

chmod +x "${REPO_DIR}/scripts/daily-engine.js" "${REPO_DIR}/ui/server.mjs" "${REPO_DIR}/Lancer Popcorn Daily.command" 2>/dev/null || true

# 3. Create Desktop double-clickable launcher
if [ -d "${HOME}/Desktop" ]; then
  cp "${REPO_DIR}/Lancer Popcorn Daily.command" "${DESKTOP_SHORTCUT}"
  chmod +x "${DESKTOP_SHORTCUT}"
  xattr -d com.apple.quarantine "${DESKTOP_SHORTCUT}" 2>/dev/null || true
  echo "✅ Raccourci créé sur ton Bureau : '🍿 Popcorn Daily.command'"
fi

echo ""
echo "🚀 Lancement de Popcorn Daily sur http://localhost:4343 ..."
bash "${REPO_DIR}/Lancer Popcorn Daily.command"
