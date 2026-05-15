/**
 * claude-side MCP proxy — stdio MCP server that bridges to the daemon's UDS socket.
 *
 * Lifecycle:
 *   1. claude spawns this proxy via the plugin's .mcp.json `mcpServers` entry.
 *   2. Proxy connects to <state_dir>/daemon.sock; if ECONNREFUSED, forks daemon-spawn.sh
 *      and retries (lazy-spawn fallback).
 *   3. Proxy sends session_init frame with shortid+branch.
 *   4. Proxy registers 5 tool handlers (reply / react / edit_message /
 *      download_attachment / request_approval) via @modelcontextprotocol/sdk's
 *      StdioServerTransport.
 *   5. Tool calls flow claude → MCP SDK → proxy → UDS → daemon → M004 tool handlers.
 *      Results flow back the same path.
 *   6. inbound_push frames from daemon become MCP `notifications/...` messages
 *      pushed to claude.
 *   7. On claude /reload-plugins, the proxy process exits; daemon emits
 *      session_disconnected; new proxy spawn → fresh session_id.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { encodeFrame, FrameDecoder } from "./frame";
import type {
  ToolCallFrame,
  ToolResultFrame,
  SessionInitFrame,
  InboundPushFrame,
} from "./frame-types";

const TOOL_DEFS: Array<{ name: string; description: string; inputSchema: object }> = [
  {
    name: "reply",
    description: "Send a text reply (or attachment) to a Telegram chat.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: ["number", "string"], description: "Telegram chat ID" },
        text: { type: "string", description: "Message text (optional if files provided)" },
        reply_to: { type: "number", description: "Optional reply-to message_id" },
        reply_markup: { description: "Optional inline keyboard / reply markup" },
        files: { type: "array", items: { type: "string" }, description: "Optional local file paths to upload" },
      },
      required: ["chat_id"],
    },
  },
  {
    name: "react",
    description: "Add an emoji reaction to a Telegram message.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: ["number", "string"] },
        message_id: { type: "number" },
        emoji: { type: "string" },
      },
      required: ["chat_id", "message_id", "emoji"],
    },
  },
  {
    name: "edit_message",
    description: "Edit the text of an existing Telegram message.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: ["number", "string"] },
        message_id: { type: "number" },
        text: { type: "string" },
      },
      required: ["chat_id", "message_id", "text"],
    },
  },
  {
    name: "download_attachment",
    description: "Fetch a Telegram-hosted file to local temp dir.",
    inputSchema: {
      type: "object",
      properties: { file_id: { type: "string" } },
      required: ["file_id"],
    },
  },
  {
    name: "request_approval",
    description: "Send an inline-button approval prompt to admin; await admin click.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        options: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
      },
      required: ["text", "options"],
    },
  },
];

function resolveSocketPath(): string {
  const override = process.env.TGCP_DAEMON_SOCKET;
  if (override) return override;
  const home = process.env.TGCP_HOME ?? os.homedir();
  return path.join(home, "Library", "Application Support", "advance-kit", "telegram-channels-pro", "daemon.sock");
}

function resolveSpawnHelper(): string {
  const override = process.env.TGCP_SPAWN_HELPER;
  if (override) return override;
  // Plugin root is provided by claude-code via $CLAUDE_PLUGIN_ROOT
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (root) return path.join(root, "bin", "daemon-spawn.sh");
  // Fallback: assume proxy-client.ts is in plugins/.../src/mcp/ and bin/ is two levels up
  return path.join(path.resolve(import.meta.dir, "..", ".."), "bin", "daemon-spawn.sh");
}

function generateShortId(): string {
  return randomBytes(4).toString("hex");
}

function detectBranch(): string {
  const env = process.env.CLAUDE_GIT_BRANCH ?? process.env.GIT_BRANCH;
  return env ?? "main";
}

/**
 * Connect to daemon UDS with lazy-spawn fallback.
 */
async function connectWithFallback(socketPath: string, spawnHelper: string): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const attempt = (allowFallback: boolean): void => {
      const sock = net.connect({ path: socketPath });
      sock.once("connect", () => {
        sock.off("error", onError);
        resolve(sock);
      });
      const onError = (err: NodeJS.ErrnoException): void => {
        if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
          if (allowFallback) {
            // Lazy-spawn
            try {
              const child = spawn("/bin/bash", [spawnHelper], {
                stdio: ["ignore", "pipe", "pipe"],
                detached: true,
              });
              child.unref();
            } catch (e) {
              reject(new Error(`proxy-client: spawn helper failed: ${(e as Error).message}`));
              return;
            }
            // Retry after a brief wait
            setTimeout(() => attempt(false), 1500);
            return;
          }
        }
        reject(err);
      };
      sock.once("error", onError);
    };
    attempt(true);
  });
}

export interface ProxyClientConfig {
  socketPath?: string;
  spawnHelper?: string;
  shortid?: string;
  branch?: string;
  stdioTransport?: boolean; // false for tests
}

export interface ProxyClientCtx {
  server: Server;
  socket: net.Socket;
  sessionId: string | null;
  pendingRequests: Map<string, { resolve: (r: ToolResultFrame) => void; reject: (e: Error) => void }>;
  setOnDaemonDisconnect: (cb: () => void) => void;
  dispose: () => Promise<void>;
}

/**
 * Construct the proxy-client (without auto-starting the stdio transport).
 * Tests call this directly + drive the socket manually. Production entry point
 * (bin/proxy-client.ts) connects stdio + starts the transport.
 */
export async function buildProxyClient(cfg: ProxyClientConfig = {}): Promise<ProxyClientCtx> {
  const socketPath = cfg.socketPath ?? resolveSocketPath();
  const spawnHelper = cfg.spawnHelper ?? resolveSpawnHelper();
  const shortid = cfg.shortid ?? generateShortId();
  const branch = cfg.branch ?? detectBranch();

  const server = new Server(
    {
      name: "telegram-channels-pro",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS,
  }));

  const sock = await connectWithFallback(socketPath, spawnHelper);
  const decoder = new FrameDecoder(1_048_576);
  const pendingRequests = new Map<string, { resolve: (r: ToolResultFrame) => void; reject: (e: Error) => void }>();
  let sessionId: string | null = null;

  sock.on("data", (chunk: Buffer) => {
    const result = decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    for (const frame of result.frames) {
      handleFrame(frame as { kind?: string });
    }
    if (result.invalid) {
      process.stderr.write("proxy-client: invalid frame from daemon, closing\n");
      sock.destroy();
    }
  });

  let onDaemonDisconnect: (() => void) | null = null;
  sock.on("close", () => {
    for (const { reject } of pendingRequests.values()) {
      reject(new Error("daemon_disconnected"));
    }
    pendingRequests.clear();
    // Library does NOT call process.exit — that's the bin entry's job in
    // production. Tests subscribe via setOnDaemonDisconnect to observe the
    // disconnect without killing the test runner.
    if (onDaemonDisconnect) onDaemonDisconnect();
  });

  function handleFrame(frame: { kind?: string }): void {
    if (frame.kind === "tool_result") {
      const tr = frame as ToolResultFrame;
      const pending = pendingRequests.get(tr.request_id);
      if (pending) {
        pendingRequests.delete(tr.request_id);
        pending.resolve(tr);
      }
    } else if (frame.kind === "inbound_push") {
      // Forward inbound TG message/callback as MCP notification (claude sees it as
      // a server-pushed event; the SDK's notification mechanism may vary by version,
      // so we use sendLoggingMessage as a stable fallback for v0.1).
      const ip = frame as InboundPushFrame;
      try {
        void server.sendLoggingMessage({
          level: "info",
          logger: "telegram-channels-pro/inbound",
          data: { type: ip.type, payload: ip.payload },
        });
      } catch {
        /* best-effort */
      }
    } else if (frame.kind === "disconnect_farewell") {
      process.stderr.write(`proxy-client: daemon farewell (${JSON.stringify(frame)})\n`);
    }
    // session_init has no daemon→proxy response in current protocol; session_id
    // is captured from the daemon side via session_connected event.
  }

  // Send session_init frame
  const initFrame: SessionInitFrame = {
    kind: "session_init",
    shortid,
    branch,
  };
  sock.write(Buffer.from(encodeFrame(initFrame)));
  sessionId = shortid; // proxy-side label; the daemon assigns its own session_id internally

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolName = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const reqId = randomBytes(8).toString("hex");
    const callFrame: ToolCallFrame = {
      kind: "tool_call",
      request_id: reqId,
      tool: toolName,
      params: args,
    };
    const resultPromise = new Promise<ToolResultFrame>((resolve, reject) => {
      pendingRequests.set(reqId, { resolve, reject });
      // Per-call timeout: 60s (large enough for request_approval round-trip)
      setTimeout(() => {
        if (pendingRequests.has(reqId)) {
          pendingRequests.delete(reqId);
          reject(new Error(`tool_call timeout: ${toolName} (request_id=${reqId})`));
        }
      }, 60_000);
    });
    sock.write(Buffer.from(encodeFrame(callFrame)));
    const result = await resultPromise;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: result.ok, result: result.result, error: result.error }),
        },
      ],
      isError: result.ok === false,
    };
  });

  const dispose = async (): Promise<void> => {
    try {
      sock.end();
    } catch {
      /* ignore */
    }
    try {
      await server.close();
    } catch {
      /* ignore */
    }
  };

  const setOnDaemonDisconnect = (cb: () => void): void => {
    onDaemonDisconnect = cb;
  };

  return { server, socket: sock, sessionId, pendingRequests, setOnDaemonDisconnect, dispose };
}

/**
 * Main entry: build + wire stdio transport. Production-only — registers a
 * disconnect handler that exits the process so claude can re-spawn cleanly.
 */
export async function main(): Promise<void> {
  const ctx = await buildProxyClient();
  ctx.setOnDaemonDisconnect(() => {
    // Production: daemon went away → exit so claude can lazy-spawn on next call
    setTimeout(() => process.exit(1), 100);
  });
  const transport = new StdioServerTransport();
  await ctx.server.connect(transport);
  process.on("SIGTERM", () => {
    void ctx.dispose().then(() => process.exit(0));
  });
}
