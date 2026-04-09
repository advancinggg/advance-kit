import * as vscode from "vscode";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const BASE_PORT = 9528;
const MAX_PORT_ATTEMPTS = 20;
const REGISTRY_DIR = path.join(os.homedir(), ".code-companion");
const REGISTRY_FILE = path.join(REGISTRY_DIR, "extension-registry.json");

let server: http.Server | null = null;
let actualPort = 0;
let terminalFocused = false;

interface RegistryEntry {
  port: number;
  workspace: string;
  path: string;
  pid: number;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
    setTimeout(() => resolve(body), 1000);
  });
}

// Read existing registry, filter out stale entries
function readRegistry(): RegistryEntry[] {
  try {
    if (!fs.existsSync(REGISTRY_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
    if (!Array.isArray(data)) return [];
    // Filter out entries whose process is no longer running
    return data.filter((e: RegistryEntry) => {
      try {
        process.kill(e.pid, 0); // check if process exists
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

// Write this instance to the registry
function registerSelf(port: number) {
  const workspacePath =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
  const workspaceName =
    vscode.workspace.workspaceFolders?.[0]?.name || "unknown";

  const entries = readRegistry().filter(
    (e) => e.pid !== process.pid && e.path !== workspacePath
  );
  entries.push({
    port,
    workspace: workspaceName,
    path: workspacePath,
    pid: process.pid,
  });

  try {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(entries, null, 2));
  } catch (err) {
    console.error("Failed to write registry:", err);
  }
}

// Remove this instance from the registry
function unregisterSelf() {
  try {
    const entries = readRegistry().filter((e) => e.pid !== process.pid);
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(entries, null, 2));
  } catch {}
}

// Try to bind to a port, incrementing until one is available
function findAndListen(
  srv: http.Server,
  port: number,
  attempt: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (attempt >= MAX_PORT_ATTEMPTS) {
      reject(new Error("No available port found"));
      return;
    }
    srv.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(findAndListen(srv, port + 1, attempt + 1));
      } else {
        reject(err);
      }
    });
    srv.listen(port, "127.0.0.1", () => resolve(port));
  });
}

export function activate(context: vscode.ExtensionContext) {
  // Track terminal focus state.
  //
  // Key insight: onDidChangeActiveTerminal only fires when switching BETWEEN terminals,
  // NOT when focus moves from editor back to the same terminal. So we also use
  // onDidChangeActiveTextEditor(undefined) as a signal that focus left all editors
  // (likely moved to terminal panel).
  //
  // Strategy:
  //   Editor gains focus        → terminalFocused = false
  //   Editor loses focus (→ ?)  → if activeTerminal exists, assume terminal got focus
  //   Terminal switch           → terminalFocused = (new terminal exists)
  //   Window blur               → terminalFocused = false

  // Initialize: if no editor is focused but a terminal exists, terminal likely has focus
  if (!vscode.window.activeTextEditor && vscode.window.activeTerminal) {
    terminalFocused = true;
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal((t) => {
      // Fires when switching between terminals, or when terminal panel gains/loses focus
      // t = new terminal (switch), or undefined (terminal panel lost focus)
      terminalFocused = !!t;
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e) {
        // A text editor became active — terminal no longer has keyboard focus
        terminalFocused = false;
      } else {
        // No active editor — focus moved away from all editors.
        // If we have an active terminal, it likely received focus.
        if (vscode.window.activeTerminal) {
          terminalFocused = true;
        }
      }
    }),
    vscode.window.onDidChangeWindowState((state) => {
      // Window lost focus entirely — no terminal has keyboard input
      if (!state.focused) terminalFocused = false;
    })
  );

  server = http.createServer(async (req, res) => {
    const url = req.url || "/";
    const method = req.method || "GET";

    res.setHeader("Content-Type", "application/json");

    if (method === "POST" && url === "/focus-terminal") {
      const body = await readBody(req);
      let projectDir = "";
      let terminalPID = 0;
      try {
        const data = JSON.parse(body);
        projectDir = data.projectDir || "";
        terminalPID = data.terminalPID || 0;
      } catch {}

      const appName = vscode.env.appName;

      // Bring this VS Code/Antigravity window to front
      vscode.commands.executeCommand("workbench.action.focusWindow");

      let matched = false;

      // Strategy 1: Match by terminal PID (most precise)
      if (terminalPID > 0) {
        for (const t of vscode.window.terminals) {
          const pid = await t.processId;
          if (pid && pid === terminalPID) {
            t.show(false);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, matched: t.name, method: "pid", pid, appName }));
            matched = true;
            break;
          }
        }
      }

      // Strategy 2: Match by shell integration cwd
      if (!matched && projectDir) {
        for (const t of vscode.window.terminals) {
          const cwd = (t as any).shellIntegration?.cwd?.fsPath;
          if (cwd && projectDir.startsWith(cwd)) {
            t.show(false);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, matched: t.name, method: "cwd", cwd, appName }));
            matched = true;
            break;
          }
        }
      }

      // Strategy 3: Match by terminal name
      if (!matched && projectDir) {
        const projectName = projectDir.split("/").pop() || "";
        for (const t of vscode.window.terminals) {
          if (projectName && t.name.toLowerCase().includes(projectName.toLowerCase())) {
            t.show(false);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, matched: t.name, method: "name", appName }));
            matched = true;
            break;
          }
        }
      }

      // Strategy 4: Fallback
      if (!matched) {
        if (vscode.window.activeTerminal) {
          vscode.window.activeTerminal.show(false);
        } else {
          vscode.commands.executeCommand("workbench.action.terminal.focus");
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, matched: "fallback", appName }));
      }
      return;
    }

    if (method === "POST" && url === "/focus-editor") {
      vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (method === "GET" && url === "/status") {
      const terminals = await Promise.all(
        vscode.window.terminals.map(async (t) => ({
          name: t.name,
          pid: (await t.processId) ?? null,
          cwd: (t as any).shellIntegration?.cwd?.fsPath ?? null,
        }))
      );
      const at = vscode.window.activeTerminal;
      const activeTerminal = at ? {
        name: at.name,
        pid: (await at.processId) ?? null,
        cwd: (at as any).shellIntegration?.cwd?.fsPath ?? null,
      } : null;
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
      res.writeHead(200);
      res.end(JSON.stringify({
        workspace: vscode.workspace.workspaceFolders?.[0]?.name || "unknown",
        path: workspacePath,
        port: actualPort,
        windowFocused: vscode.window.state.focused,
        terminalFocused,
        activeTerminal,
        terminals,
      }));
      return;
    }

    if (method === "GET" && url === "/health") {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", port: actualPort }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });

  findAndListen(server, BASE_PORT, 0)
    .then((port) => {
      actualPort = port;
      registerSelf(port);
      console.log(`Code Companion Bridge listening on 127.0.0.1:${port}`);
    })
    .catch((err) => {
      console.error("Code Companion Bridge failed to start:", err);
    });

  context.subscriptions.push({ dispose: () => { unregisterSelf(); server?.close(); server = null; } });
}

export function deactivate() {
  unregisterSelf();
  server?.close();
  server = null;
}
