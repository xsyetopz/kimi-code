#!/bin/bash
# Replace the Homebrew-installed Kimi Code CLI with the fork-built version at
# ~/CodeProjects/xsyetopz/kimi-code/apps/kimi-code/dist.
#
# Run this after exiting the current Kimi Code session:
#   bash /Users/krystian/CodeProjects/xsyetopz/kimi-code/replace-homebrew.sh
#
# This script:
#  - backs up the existing 0.27.0 Cellar directory
#  - creates a new 0.28.0 Cellar directory
#  - replaces libexec with the fork-built dist bundle
#  - re-links `kimi-code` via Homebrew
#
# ~/.kimi-code (configs, sessions, skills, history) is never touched.

set -euo pipefail

OLD_VERSION="0.27.0"
NEW_VERSION="0.28.0"
CELLAR_DIR="/opt/homebrew/Cellar/kimi-code"
OLD_CELLAR="$CELLAR_DIR/$OLD_VERSION"
NEW_CELLAR="$CELLAR_DIR/$NEW_VERSION"
FORK_DIST="/Users/krystian/CodeProjects/xsyetopz/kimi-code/apps/kimi-code/dist"

if [[ "$EUID" -eq 0 ]]; then
  echo "ERROR: do not run this script with sudo." >&2
  exit 1
fi

if [[ ! -d "$OLD_CELLAR" ]]; then
  echo "ERROR: expected existing Homebrew cell not found: $OLD_CELLAR" >&2
  exit 1
fi

if [[ ! -f "$FORK_DIST/main.mjs" ]]; then
  echo "ERROR: fork-built dist not found: $FORK_DIST/main.mjs" >&2
  echo "Build it first with: pnpm --filter @moonshot-ai/kimi-code run build" >&2
  exit 1
fi

TIMESTAMP=$(date +%s)
BACKUP_CELLAR="$CELLAR_DIR/${OLD_VERSION}.backup.${TIMESTAMP}"

if [[ -d "$NEW_CELLAR" ]]; then
  echo "WARN: $NEW_CELLAR already exists; moving it aside first." >&2
  mv "$NEW_CELLAR" "$CELLAR_DIR/${NEW_VERSION}.old.${TIMESTAMP}"
fi

echo "==> Backing up $OLD_CELLAR -> $BACKUP_CELLAR"
cp -a "$OLD_CELLAR" "$BACKUP_CELLAR"

echo "==> Creating new cell $NEW_CELLAR"
cp -a "$BACKUP_CELLAR" "$NEW_CELLAR"

echo "==> Replacing libexec with fork-built dist"
rm -rf "$NEW_CELLAR/libexec"
cp -a "$FORK_DIST" "$NEW_CELLAR/libexec"

echo "==> Fixing launcher wrapper"
# The original Homebrew wrapper pointed at the old nested libexec layout.
# Rewrite it to load the flat dist bundle produced by the fork build.
LAUNCHER="$NEW_CELLAR/bin/kimi"
cat > "$LAUNCHER" <<'EOF'
#!/bin/bash
exec node "$(dirname "$0")/../libexec/main.mjs" "$@"
EOF
chmod +x "$LAUNCHER"

echo "==> Re-linking Homebrew binary"
brew unlink kimi-code || true
brew link --force --overwrite kimi-code

echo "==> Done. Verify:"
echo "    which kimi"
echo "    kimi --version"
