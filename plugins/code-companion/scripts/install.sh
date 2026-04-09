#!/bin/bash
# Install Code Companion: build app, install VS Code extension, create LaunchAgent.
# Usage: ./install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_DIR="${HOME}/.code-companion"
LAUNCH_AGENT_DIR="${HOME}/Library/LaunchAgents"
PLIST_NAME="com.advance.code-companion"

echo "=== Code Companion Installer ==="
echo ""

# 1. Build the app
echo "[1/4] Building Swift app..."
mkdir -p "$INSTALL_DIR"
bash "${SCRIPT_DIR}/build.sh" --output "${INSTALL_DIR}/code-companion"
echo ""

# 2. Install VS Code extension
echo "[2/4] Installing VS Code extension..."
VSIX="${PLUGIN_DIR}/vscode-extension/code-companion-bridge-1.0.0.vsix"
if [[ -f "$VSIX" ]]; then
    if command -v code &>/dev/null; then
        code --install-extension "$VSIX" --force 2>/dev/null && echo "  VS Code extension installed." || echo "  Warning: VS Code extension install failed (VS Code may not be running)."
    else
        echo "  Warning: 'code' CLI not found. Install extension manually:"
        echo "    code --install-extension $VSIX"
    fi
else
    echo "  Warning: VSIX not found at $VSIX. Build it first:"
    echo "    cd ${PLUGIN_DIR}/vscode-extension && npm install && npm run compile && npx @vscode/vsce package --no-dependencies --allow-missing-repository"
fi
echo ""

# 3. Create LaunchAgent for auto-launch
echo "[3/4] Creating LaunchAgent..."
mkdir -p "$LAUNCH_AGENT_DIR"
cat > "${LAUNCH_AGENT_DIR}/${PLIST_NAME}.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${INSTALL_DIR}/code-companion</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>${INSTALL_DIR}/companion.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>COMPANION_PORT</key>
        <string>9527</string>
    </dict>
</dict>
</plist>
EOF

# Load the LaunchAgent
launchctl bootout "gui/$(id -u)/${PLIST_NAME}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${LAUNCH_AGENT_DIR}/${PLIST_NAME}.plist"
echo "  LaunchAgent installed and started."
echo ""

# 4. Verify
echo "[4/4] Verifying..."
sleep 2
if curl -s --max-time 2 http://127.0.0.1:9527/health | grep -q '"ok"'; then
    echo "  Code Companion is running!"
else
    echo "  Warning: Health check failed. Check ${INSTALL_DIR}/companion.log"
fi

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Code Companion is now running as a floating pill at the top of your screen."
echo "It will auto-start on login via LaunchAgent."
echo ""
echo "Useful commands:"
echo "  curl http://127.0.0.1:9527/health   # Health check"
echo "  curl http://127.0.0.1:9527/status    # Current status"
echo "  launchctl kickstart -k gui/$(id -u)/${PLIST_NAME}  # Restart"
echo "  bash ${PLUGIN_DIR}/scripts/uninstall.sh  # Uninstall"
