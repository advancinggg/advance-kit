---
description: Build and install Code Companion (macOS Dynamic Island for code agents).
allowed-tools: [Bash, Read]
---

# /code-companion:setup — Install Code Companion

Build the Swift app, install the VS Code extension, and set up the LaunchAgent for auto-start.

## Instructions

### 1. Check prerequisites

```bash
echo "=== Prerequisites ==="
command -v swiftc &>/dev/null && echo "swiftc: OK" || echo "swiftc: MISSING (run: xcode-select --install)"
xcrun --show-sdk-path &>/dev/null && echo "macOS SDK: OK" || echo "macOS SDK: MISSING"
command -v code &>/dev/null && echo "VS Code CLI: OK" || echo "VS Code CLI: MISSING (optional)"
command -v curl &>/dev/null && echo "curl: OK" || echo "curl: MISSING"
```

If `swiftc` is missing, tell the user to install Xcode Command Line Tools and stop.

### 2. Run the install script

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh"
```

### 3. Verify Code Companion is running

```bash
curl -s http://127.0.0.1:9527/health
```

### 4. Test the bridge

```bash
echo '{"session_id":"setup-test","hook_event_name":"SessionStart","cwd":"'$(pwd)'"}' | \
    "${CLAUDE_PLUGIN_ROOT}/bin/companion-bridge" --source claude
sleep 1
curl -s http://127.0.0.1:9527/status
```

### 5. Report

Show a summary:

```
Code Companion Setup Complete

  App:           ~/.code-companion/code-companion
  LaunchAgent:   ~/Library/LaunchAgents/com.advance.code-companion.plist
  VS Code Ext:   code-companion-bridge v1.0.0
  HTTP Server:   http://127.0.0.1:9527
  Status:        {running/not running}

  Plugin hooks are automatically registered.
  The floating pill should be visible at the top center of your screen.
```

### 6. Remove old Vibe Island hooks (optional)

If the user confirms, remove Vibe Island hook entries from `~/.claude/settings.json`
by editing the hooks section to remove any entries with `vibe-island-bridge`.
