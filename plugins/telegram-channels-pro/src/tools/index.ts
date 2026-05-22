import type { Clock } from "../daemon/clock";
import type { EventBus } from "../daemon/event-bus";
import type { StateDir } from "../daemon/state-dir";
import type { TelegramAPIClient } from "../telegram/client";
import type { PollingStatusImpl } from "../telegram/polling-status";
import type { ChatTypeCache } from "../telegram/chat-type-cache";
import type { MCPDaemonAcceptor } from "../mcp/daemon-acceptor";
import type { ToolCallFrame } from "../mcp/frame-types";
import type { AdminChatRegistry } from "../routing/admin-chat-registry";
import {
  PendingApprovalRegistryImpl,
  type PendingApprovalRegistry,
} from "./pending-registry";
import { SnapshotEmitter } from "./snapshot-emitter";
import { AttachmentJanitor } from "./attachment-janitor";
import { reply, type ReplyParams } from "./reply";
import { react, type ReactParams } from "./react";
import { editMessage, type EditMessageParams } from "./edit-message";
import { downloadAttachment, type DownloadAttachmentParams } from "./download-attachment";
import { requestApproval, type RequestApprovalParams } from "./request-approval";

export interface InstallToolHandlersArgs {
  acceptor: MCPDaemonAcceptor;
  tg: TelegramAPIClient;
  apiBase: string;
  token: string;
  pollingStatus: PollingStatusImpl;
  eventBus: EventBus;
  stateDir: StateDir;
  clock: Clock;
  adminChatRegistry: AdminChatRegistry;
  // v1.1.0 — REQ-035 outbound chat-type DiD.
  chatTypeCache: ChatTypeCache;
  pendingCapacity?: number;
  attachmentTtlHours?: number;
  janitorIntervalMin?: number;
  snapshotIntervalMs?: number;
  fetchFn?: typeof globalThis.fetch;
}

export interface ToolsCtx {
  getPendingRegistry(): PendingApprovalRegistry;
  dispose(): void;
}

/**
 * Wires the 5 MCP tool handlers into M003's MCPDaemonAcceptor and constructs the
 * singleton PendingApprovalRegistry, AttachmentJanitor, and SnapshotEmitter.
 *
 * The PendingApprovalRegistry is exposed via `getPendingRegistry()` so M005's
 * routing layer can call lookup/resolve/cleanup on the SAME instance.
 */
export function installToolHandlers(args: InstallToolHandlersArgs): ToolsCtx {
  const registry = new PendingApprovalRegistryImpl({
    eventBus: args.eventBus,
    clock: args.clock,
    capacity: args.pendingCapacity,
  });
  const snapshotEmitter = new SnapshotEmitter({
    registry,
    eventBus: args.eventBus,
    clock: args.clock,
    intervalMs: args.snapshotIntervalMs,
  });
  snapshotEmitter.start();
  const janitor = new AttachmentJanitor({
    stateDir: args.stateDir,
    eventBus: args.eventBus,
    clock: args.clock,
    ttlHours: args.attachmentTtlHours,
    intervalMin: args.janitorIntervalMin,
  });
  janitor.start();

  // Note: replyCtx is built per-call to inject the sessionId (REQ-037 propagation).
  const reactCtx = {
    apiBase: args.apiBase,
    token: args.token,
    pollingStatus: args.pollingStatus,
    chatTypeCache: args.chatTypeCache,
    eventBus: args.eventBus,
    fetchFn: args.fetchFn,
  };
  const editCtx = {
    tg: args.tg,
    chatTypeCache: args.chatTypeCache,
    eventBus: args.eventBus,
  };
  const downloadCtx = {
    tg: args.tg,
    apiBase: args.apiBase,
    token: args.token,
    stateDir: args.stateDir,
    fetchFn: args.fetchFn,
  };

  // Wrap each tool to match MCPDaemonAcceptor.ToolHandler signature.
  // NOTE: do NOT emit tool_call / tool_result here — MCPDaemonAcceptor
  // already emits both events around the wrapped handler invocation
  // (see daemon-acceptor.ts dispatchToolCall). Per-handler emits would
  // duplicate every event in the JSONL log.
  //
  // v1.1.0 — only `reply` consumes `sessionId` (for REQ-037 requester_session
  // propagation into the quarantine outbound replay queue). react / edit_message /
  // download_attachment keep the `_sessionId` underscore convention to satisfy
  // TypeScript's noUnusedParameters strict-mode check.
  args.acceptor.registerToolHandler("reply", async (sessionId, frame: ToolCallFrame) => {
    const r = await reply(frame.params as ReplyParams, {
      tg: args.tg,
      apiBase: args.apiBase,
      token: args.token,
      pollingStatus: args.pollingStatus,
      chatTypeCache: args.chatTypeCache,
      eventBus: args.eventBus,
      sessionId,
      fetchFn: args.fetchFn,
    });
    return { ok: r.delivered === true, result: r };
  });

  args.acceptor.registerToolHandler("react", async (_sessionId, frame: ToolCallFrame) => {
    const r = await react(frame.params as ReactParams, reactCtx);
    return { ok: r.ok, result: r };
  });

  args.acceptor.registerToolHandler("edit_message", async (_sessionId, frame: ToolCallFrame) => {
    const r = await editMessage(frame.params as EditMessageParams, editCtx);
    return { ok: r.delivered === true, result: r };
  });

  args.acceptor.registerToolHandler("download_attachment", async (_sessionId, frame: ToolCallFrame) => {
    const r = await downloadAttachment(frame.params as DownloadAttachmentParams, downloadCtx);
    return { ok: r.ok, result: r };
  });

  args.acceptor.registerToolHandler("request_approval", async (sessionId, frame: ToolCallFrame) => {
    const r = await requestApproval(frame.params as RequestApprovalParams, {
      tg: args.tg,
      registry,
      adminChatRegistry: args.adminChatRegistry,
      clock: args.clock,
      requesterSessionId: sessionId,
      chatTypeCache: args.chatTypeCache,
      eventBus: args.eventBus,
    });
    return { ok: r.ok, result: r };
  });

  return {
    getPendingRegistry() {
      return registry;
    },
    dispose() {
      janitor.stop();
      snapshotEmitter.stop();
    },
  };
}

export {
  PendingApprovalRegistryImpl,
  type PendingApprovalRegistry,
  type PendingEntry,
  type PendingEntryAdd,
} from "./pending-registry";
export { AttachmentJanitor } from "./attachment-janitor";
export { SnapshotEmitter } from "./snapshot-emitter";
export { reply, type ReplyParams, type ReplyResult } from "./reply";
export { react, type ReactParams, type ReactResult } from "./react";
export { editMessage, type EditMessageParams, type EditMessageResult } from "./edit-message";
export {
  downloadAttachment,
  type DownloadAttachmentParams,
  type DownloadAttachmentResult,
} from "./download-attachment";
export {
  requestApproval,
  type RequestApprovalParams,
  type RequestApprovalResult,
} from "./request-approval";
