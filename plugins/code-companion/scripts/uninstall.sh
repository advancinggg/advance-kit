#!/bin/bash
# Uninstall Code Companion: stop app, remove LaunchAgent, remove files.
set -euo pipefail

PLIST_NAME="com.advance.code-companion"
INSTALL_DIR="${HOME}/.code-companion"
LAUNCH_AGENT="${HOME}/Library/LaunchAgents/${PLIST_NAME}.plist"

echo "=== Code Companion Uninstaller ==="

# Stop the LaunchAgent
echo "[1/3] Stopping LaunchAgent..."
launchctl bootout "gui/$(id -u)/${PLIST_NAME}" 2>/dev/null && echo "  Stopped." || echo "  Not running."

# Remove LaunchAgent plist
echo "[2/3] Removing LaunchAgent..."
rm -f "$LAUNCH_AGENT"
echo "  Removed."

# Remove installed binary
echo "[3/3] Removing app..."
rm -rf "$INSTALL_DIR"
echo "  Removed."

echo ""
echo "VS Code extension can be removed via:"
echo "  code --uninstall-extension advance-studio.code-companion-bridge"
echo ""
echo "=== Uninstall Complete ==="
