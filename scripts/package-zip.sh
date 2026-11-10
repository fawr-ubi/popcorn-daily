#!/usr/bin/env bash
# ==============================================================================
# package-zip.sh
# Manages semantic versioning (optional --bump patch|minor|major|X.Y.Z),
# syncs the shareable Git repository in ~/Ubitransport/projects/popcorn-daily,
# and builds portable .zip archives ready to share with colleagues:
#   - ~/.gemini/config/skills/popcorn-daily.zip
#   - ~/Ubitransport/projects/popcorn-daily.zip
#   - ~/Ubitransport/projects/popcorn-daily-v<VERSION>.zip
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VERSION_FILE="${SKILL_DIR}/VERSION"

CURRENT_VERSION="1.0.0"
if [ -f "${VERSION_FILE}" ]; then
  CURRENT_VERSION="$(tr -d '[:space:]' < "${VERSION_FILE}")"
fi

NEW_VERSION="${CURRENT_VERSION}"

# Optional version bump (--bump patch | minor | major | X.Y.Z)
if [ "${1:-}" = "--bump" ] && [ -n "${2:-}" ]; then
  BUMP_ARG="${2}"
  IFS='.' read -r V_MAJ V_MIN V_PAT <<< "${CURRENT_VERSION}"
  case "${BUMP_ARG}" in
    patch)
      NEW_VERSION="${V_MAJ}.${V_MIN}.$((V_PAT + 1))"
      ;;
    minor)
      NEW_VERSION="${V_MAJ}.$((V_MIN + 1)).0"
      ;;
    major)
      NEW_VERSION="$((V_MAJ + 1)).0.0"
      ;;
    *)
      NEW_VERSION="${BUMP_ARG}"
      ;;
  esac
  echo "${NEW_VERSION}" > "${VERSION_FILE}"
  echo "🔖 Bumped version: ${CURRENT_VERSION} -> ${NEW_VERSION}"
fi

STAGE_ROOT="$(mktemp -d)"
PACKAGE_DIR="${STAGE_ROOT}/popcorn-daily"
mkdir -p "${PACKAGE_DIR}/scripts" "${PACKAGE_DIR}/ui"

cleanup() {
  rm -rf "${STAGE_ROOT}"
}
trap cleanup EXIT

echo "📦 Staging portable files for popcorn-daily v${NEW_VERSION} ..."

cp "${SKILL_DIR}/SKILL.md" "${PACKAGE_DIR}/SKILL.md"
cp "${SKILL_DIR}/README.md" "${PACKAGE_DIR}/README.md"
cp "${SKILL_DIR}/CHANGELOG.md" "${PACKAGE_DIR}/CHANGELOG.md"
cp "${SKILL_DIR}/VERSION" "${PACKAGE_DIR}/VERSION"
cp "${SKILL_DIR}/config.example.json" "${PACKAGE_DIR}/config.example.json"
cp "${SKILL_DIR}/.gitignore" "${PACKAGE_DIR}/.gitignore"
cp "${SKILL_DIR}/install.sh" "${PACKAGE_DIR}/install.sh"
cp "${SKILL_DIR}/setup-mac.sh" "${PACKAGE_DIR}/setup-mac.sh"
cp "${SKILL_DIR}/Lancer Popcorn Daily.command" "${PACKAGE_DIR}/Lancer Popcorn Daily.command"
cp "${SKILL_DIR}/scripts/daily-engine.js" "${PACKAGE_DIR}/scripts/daily-engine.js"
cp "${SKILL_DIR}/scripts/package-zip.sh" "${PACKAGE_DIR}/scripts/package-zip.sh"
cp "${SKILL_DIR}/ui/server.mjs" "${PACKAGE_DIR}/ui/server.mjs"
cp "${SKILL_DIR}/ui/index.html" "${PACKAGE_DIR}/ui/index.html"
cp "${SKILL_DIR}/ui/styles.css" "${PACKAGE_DIR}/ui/styles.css"
cp "${SKILL_DIR}/ui/app.js" "${PACKAGE_DIR}/ui/app.js"

chmod +x "${PACKAGE_DIR}/install.sh" "${PACKAGE_DIR}/setup-mac.sh" "${PACKAGE_DIR}/Lancer Popcorn Daily.command" "${PACKAGE_DIR}/scripts/daily-engine.js" "${PACKAGE_DIR}/scripts/package-zip.sh" "${PACKAGE_DIR}/ui/server.mjs"

# Sanitize any personal absolute path in markdown/scripts for portability
find "${PACKAGE_DIR}" -type f \( -name "*.md" -o -name "*.sh" -o -name "*.js" \) -print0 | while IFS= read -r -d '' f; do
  sed -i '' 's|~/Ubitransport/projects|~/Ubitransport/projects|g' "${f}"
  sed -i '' 's|~/.gemini|~/.gemini|g' "${f}"
done

SKILLS_ZIP="${HOME}/.gemini/config/skills/popcorn-daily.zip"
PROJECTS_ROOT="${HOME}/Ubitransport/projects"
PROJECTS_REPO="${PROJECTS_ROOT}/popcorn-daily"
PROJECTS_ZIP_LATEST="${PROJECTS_ROOT}/popcorn-daily.zip"
PROJECTS_ZIP_VERSIONED="${PROJECTS_ROOT}/popcorn-daily-v${NEW_VERSION}.zip"

# 1. Create zip archives
(
  cd "${STAGE_ROOT}"
  rm -f "${SKILLS_ZIP}" "${PROJECTS_ZIP_LATEST}" "${PROJECTS_ZIP_VERSIONED}"
  zip -rq "${SKILLS_ZIP}" "popcorn-daily"
)
cp "${SKILLS_ZIP}" "${PROJECTS_ZIP_LATEST}"
cp "${SKILLS_ZIP}" "${PROJECTS_ZIP_VERSIONED}"

# 2. Sync to ~/Ubitransport/projects/popcorn-daily (shareable Git repo)
mkdir -p "${PROJECTS_REPO}"
rsync -a --delete --exclude '.git' "${PACKAGE_DIR}/" "${PROJECTS_REPO}/"
if [ ! -d "${PROJECTS_REPO}/.git" ]; then
  git -C "${PROJECTS_REPO}" init -b main >/dev/null 2>&1 || git -C "${PROJECTS_REPO}" init >/dev/null 2>&1
fi

echo "✅ Packaged popcorn-daily v${NEW_VERSION}:"
echo "   • Skill archive     : ${SKILLS_ZIP}"
echo "   • Shareable latest  : ${PROJECTS_ZIP_LATEST}"
echo "   • Shareable version : ${PROJECTS_ZIP_VERSIONED}"
echo "   • Git repository    : ${PROJECTS_REPO}"
