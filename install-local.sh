#!/bin/bash
# Remove the Homebrew-managed Kimi Code CLI and install the fork-built version
# into ~/.local/bin, while preserving all user data in ~/.kimi-code.
#
# Run this after exiting the current Kimi Code session:
#   bash /Users/krystian/CodeProjects/xsyetopz/kimi-code/install-local.sh
#
# This script:
#  - backs up ~/.kimi-code (configs, sessions, skills, history)
#  - runs `brew uninstall kimi-code` to remove the Homebrew package
#  - writes launchers `kimi` and `kimi-code` into ~/.local/bin
#
# After running, open a new terminal and verify:
#   which kimi
#   kimi --version

set -euo pipefail

FORK_DIST="/Users/krystian/CodeProjects/xsyetopz/kimi-code/apps/kimi-code/dist"
LOCAL_BIN="/Users/krystian/.local/bin"
KIMI_DATA="/Users/krystian/.kimi-code"

if [[ "$EUID" -eq 0 ]]; then
  echo "ERROR: do not run this script with sudo." >&2
  exit 1
fi

if [[ ! -f "$FORK_DIST/main.mjs" ]]; then
  echo "ERROR: fork-built dist not found: $FORK_DIST/main.mjs" >&2
  echo "Build it first with: pnpm --filter @moonshot-ai/kimi-code run build" >&2
  exit 1
fi

TIMESTAMP=$(date +%s)

if [[ -d "$KIMI_DATA" ]]; then
  BACKUP_DATA="${KIMI_DATA}.backup.${TIMESTAMP}"
  echo "==> Backing up $KIMI_DATA -> $BACKUP_DATA"
  cp -a "$KIMI_DATA" "$BACKUP_DATA"
else
  echo "WARN: no $KIMI_DATA directory found; nothing to back up." >&2
fi

if command -v brew >/dev/null 2>&1 && brew list kimi-code >/dev/null 2>&1; then
  echo "==> Uninstalling Homebrew-managed kimi-code"
  brew uninstall --force kimi-code
else
  echo "==> No Homebrew kimi-code install found; skipping uninstall."
fi

echo "==> Installing fork launchers into $LOCAL_BIN"
mkdir -p "$LOCAL_BIN"

for cmd in kimi kimi-code; do
  cat > "$LOCAL_BIN/$cmd" <<'EOF'
#!/bin/bash
exec node /Users/krystian/CodeProjects/xsyetopz/kimi-code/apps/kimi-code/dist/main.mjs "$@"
EOF
  chmod +x "$LOCAL_BIN/$cmd"
  echo "    $LOCAL_BIN/$cmd"
done

if [[ ":$PATH:" != *":$LOCAL_BIN:"* ]]; then
  echo "==> Adding $LOCAL_BIN to PATH in ~/.zshrc"
  echo "export PATH=\"$LOCAL_BIN:\$PATH\"" >> /Users/krystian/.zshrc
fi

echo "==> Done."
echo "    User data preserved at: $BACKUP_DATA (if it existed)"
echo "    Launchers installed at: $LOCAL_BIN/{kimi,kimi-code}"
echo ""
echo "Open a new terminal and run:"
echo "    which kimi"
echo "    kimi --version"
