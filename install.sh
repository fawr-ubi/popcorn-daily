#!/usr/bin/env bash

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DEST="$HOME/.gemini/config/skills/popcorn-daily"
CONFIG_DIR="$HOME/.config/popcorn-daily"
CONFIG_FILE="$CONFIG_DIR/config.json"
ACLI_JIRA_CONFIG="$HOME/.config/acli/jira_config.yaml"
VERSION_STR="1.0.0"
if [ -f "$REPO_DIR/VERSION" ]; then
  VERSION_STR="$(tr -d '[:space:]' < "$REPO_DIR/VERSION")"
fi

echo "========================================================"
echo "  🍿 Popcorn Daily v${VERSION_STR} — Setup & Installer (Matawan)"
echo "========================================================"
echo ""

# 1. Check prerequisites
for cmd in node curl git gh acli jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "❌ Missing required command: $cmd"
    if [ "$cmd" = "acli" ]; then
      echo "   Install via: brew install atlassian/tap/atlassian-cli && acli jira auth login"
    elif [ "$cmd" = "gh" ]; then
      echo "   Install via: brew install gh && gh auth login"
    fi
    exit 1
  fi
done

echo "✅ Prerequisites checked (node, curl, git, gh, acli, jq)."

# 2. Auto-detect Jira identity from acli
CLOUD_ID="f7cc0067-63f0-4d66-bf18-d6b06658cd2e"
ACCOUNT_ID=""
EMAIL=""
DISPLAY_NAME=""

if [ -f "$ACLI_JIRA_CONFIG" ]; then
  CLOUD_ID=$(awk -F': ' '/cloud_id:/ {print $2; exit}' "$ACLI_JIRA_CONFIG" | tr -d '[:space:]')
  ACCOUNT_ID=$(awk -F': ' '/account_id:/ {print $2; exit}' "$ACLI_JIRA_CONFIG" | tr -d '[:space:]')
  EMAIL=$(awk -F': ' '/email:/ {print $2; exit}' "$ACLI_JIRA_CONFIG" | tr -d '[:space:]')
  DISPLAY_NAME=$(awk -F': ' '/display_name:/ {print $2; exit}' "$ACLI_JIRA_CONFIG" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
fi

if [ -z "$ACCOUNT_ID" ] || [ -z "$EMAIL" ]; then
  echo "⚠️  acli is not authenticated to Jira yet. Running 'acli jira auth login'..."
  acli jira auth login
  CLOUD_ID=$(awk -F': ' '/cloud_id:/ {print $2; exit}' "$ACLI_JIRA_CONFIG" | tr -d '[:space:]')
  ACCOUNT_ID=$(awk -F': ' '/account_id:/ {print $2; exit}' "$ACLI_JIRA_CONFIG" | tr -d '[:space:]')
  EMAIL=$(awk -F': ' '/email:/ {print $2; exit}' "$ACLI_JIRA_CONFIG" | tr -d '[:space:]')
  DISPLAY_NAME=$(awk -F': ' '/display_name:/ {print $2; exit}' "$ACLI_JIRA_CONFIG" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
fi

echo "✅ Detected Jira Account: $DISPLAY_NAME <$EMAIL> ($ACCOUNT_ID)"

# 3. Auto-detect GitHub login
GH_USER=$(gh api user --jq .login 2>/dev/null || echo "")
if [ -n "$GH_USER" ]; then
  echo "✅ Detected GitHub User:  $GH_USER"
else
  read -r -p "👉 Enter your GitHub username (e.g., fawr-ubi): " GH_USER
fi

# 4. Team configuration (defaults to Popcorn)
DEFAULT_TEAM_NAME="Popcorn"
DEFAULT_TEAM_ID="b6f87d61-69e0-459b-ba68-a322281b9805"
DEFAULT_BOARD_ID="1314"

read -r -p "👉 Jira Team Name [$DEFAULT_TEAM_NAME]: " INPUT_TEAM_NAME
TEAM_NAME="${INPUT_TEAM_NAME:-$DEFAULT_TEAM_NAME}"

read -r -p "👉 Jira Team UUID [$DEFAULT_TEAM_ID]: " INPUT_TEAM_ID
TEAM_ID="${INPUT_TEAM_ID:-$DEFAULT_TEAM_ID}"

read -r -p "👉 Jira Board ID [$DEFAULT_BOARD_ID]: " INPUT_BOARD_ID
BOARD_ID="${INPUT_BOARD_ID:-$DEFAULT_BOARD_ID}"

# 5. Write ~/.config/popcorn-daily/config.json
mkdir -p "$CONFIG_DIR/reports" "$CONFIG_DIR/snapshots"
chmod 700 "$CONFIG_DIR"

jq -n \
  --arg accountId "$ACCOUNT_ID" \
  --arg cloudId "$CLOUD_ID" \
  --arg email "$EMAIL" \
  --arg displayName "$DISPLAY_NAME" \
  --arg githubUser "$GH_USER" \
  --arg teamId "$TEAM_ID" \
  --arg teamName "$TEAM_NAME" \
  --argjson boardId "$BOARD_ID" \
  '{
    accountId: $accountId,
    cloudId: $cloudId,
    email: $email,
    displayName: $displayName,
    githubUser: $githubUser,
    teamId: $teamId,
    teamName: $teamName,
    boardId: $boardId,
    githubOrg: "ubitransports",
    jiraBaseUrl: "https://ubitransport.atlassian.net/browse/",
    staleThresholdsWorkdays: {
      IN_PROGRESS: 3,
      IN_REVIEW: 2,
      IN_QA: 2
    },
    prStaleReviewHours: 24
  }' > "$CONFIG_FILE"

chmod 600 "$CONFIG_FILE"
echo "✅ Saved configuration to $CONFIG_FILE (chmod 600)."

# 6. Install Skill into ~/.gemini/config/skills/popcorn-daily
if [ "$REPO_DIR" != "$SKILL_DEST" ]; then
  mkdir -p "$SKILL_DEST/scripts" "$SKILL_DEST/ui"
  cp "$REPO_DIR/SKILL.md" "$SKILL_DEST/SKILL.md"
  cp "$REPO_DIR/README.md" "$SKILL_DEST/README.md"
  cp "$REPO_DIR/CHANGELOG.md" "$SKILL_DEST/CHANGELOG.md"
  cp "$REPO_DIR/VERSION" "$SKILL_DEST/VERSION"
  cp "$REPO_DIR/config.example.json" "$SKILL_DEST/config.example.json"
  cp "$REPO_DIR/install.sh" "$SKILL_DEST/install.sh"
  cp "$REPO_DIR/scripts/"* "$SKILL_DEST/scripts/"
  cp "$REPO_DIR/ui/"* "$SKILL_DEST/ui/"
fi
chmod +x "$SKILL_DEST/scripts/"*.js "$SKILL_DEST/scripts/"*.sh "$SKILL_DEST/ui/server.mjs" "$SKILL_DEST/install.sh" 2>/dev/null || true
echo "✅ Installed skill v${VERSION_STR} to $SKILL_DEST"

# Create macOS double-clickable Finder launcher
LAUNCHER="$CONFIG_DIR/Open Popcorn Daily Hub.command"
cat << 'LAUNCH_EOF' > "$LAUNCHER"
#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-4343}"
SERVER_SCRIPT="${HOME}/.gemini/config/skills/popcorn-daily/ui/server.mjs"
LOG_FILE="${HOME}/.config/popcorn-daily/.ui-server.log"

if ! lsof -iTCP:${PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "🍿 Starting Popcorn Daily Hub on http://localhost:${PORT} ..."
  nohup node "${SERVER_SCRIPT}" > "${LOG_FILE}" 2>&1 &
  sleep 0.8
else
  echo "✅ Popcorn Daily Hub is already running on http://localhost:${PORT}"
fi

open "http://localhost:${PORT}"
LAUNCH_EOF
chmod +x "$LAUNCHER"
echo "✅ Created macOS launcher: $LAUNCHER"

# 7. Run initial report
echo ""
echo "🚀 Generating your first Daily Standup report..."
node "$SKILL_DEST/scripts/daily-engine.js" report | head -n 45
echo "..."
echo ""
echo "🎉 Setup complete! Full report saved in $CONFIG_DIR/reports/$(date +%Y-%m-%d).md"
echo "   Ask your agent: 'Prépare le support du daily Popcorn'"
