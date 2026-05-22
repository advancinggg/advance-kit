import type { Clock } from "../daemon/clock";
import type { EventBus } from "../daemon/event-bus";
import type {
  AnswerCallbackQueryReq,
  ChatAction,
  EditMessageTextReq,
  GetChatEnvelope,
  GetChatResult,
  GetFileResult,
  GetUpdatesOpts,
  SendMessageReq,
  SendMessageResult,
  TelegramUpdate,
} from "./methods";
import { buildMethodUrl } from "./methods";
import { classifyHttpResponse, classifyNetworkError, type ClassifiedError } from "./error-classify";
import type { PollingStatusImpl } from "./polling-status";
import type { OutboundReplayQueue } from "./outbound-replay-queue";

// v1.1.0 — REQ-037: opts.requester_session is metadata only; never spread into the HTTP
// POST body. When provided + polling state is quarantine, sendMessage routes the entry
// into outboundReplayQueue for drain on quarantine_exit.
export interface SendMessageOpts {
  requester_session?: string;
}

export interface TelegramAPIClient {
  sendMessage(req: SendMessageReq, opts?: SendMessageOpts): Promise<SendMessageEnvelope>;
  editMessageText(req: EditMessageTextReq): Promise<SendMessageEnvelope>;
  answerCallbackQuery(req: AnswerCallbackQueryReq): Promise<{ ok: true } | { ok: false; error: string }>;
  getFile(file_id: string): Promise<{ ok: true; result: GetFileResult } | { ok: false; error: string }>;
  sendChatAction(chat_id: number | string, action: ChatAction): Promise<{ ok: true } | { ok: false; error: string }>;
  getUpdates(opts: GetUpdatesOpts): Promise<{ ok: true; result: TelegramUpdate[]; classified: ClassifiedError } | { ok: false; classified: ClassifiedError }>;
  // v1.1.0 — REQ-035 cold-start lazy-fetch for ChatTypeCache. Returns the
  // {ok,...} envelope convention (same as getFile / answerCallbackQuery impl).
  getChat(chat_id: number): Promise<GetChatEnvelope>;
}

// REQ-022 AC-34 — third independent capacity edge (alongside the
// SessionRegistry 8-cap and PendingApprovalRegistry 50-cap). Default
// capacity for OutboundReplayQueue (src/telegram/outbound-replay-queue.ts).
export const QUARANTINE_QUEUE_CAP = 50;

export type SendMessageEnvelope =
  | { delivered: true; message_id: number; result: SendMessageResult }
  | { delivered: false; queued: true; eta_hint: number }
  | { delivered: false; error: "capacity_exceeded" }
  | { delivered: false; error: "rate_limited"; retry_after_sec: number }
  | { delivered: false; error: "disconnected"; reason: string };

export interface TelegramClientConfig {
  token: string;
  eventBus: EventBus;
  clock: Clock;
  pollingStatus: PollingStatusImpl;
  apiBase?: string;
  fetchFn?: typeof globalThis.fetch;
  /**
   * v1.1.0 — REQ-037 quarantine outbound replay queue. OPTIONAL: when present + caller
   * passes opts.requester_session + polling state is quarantine, sendMessage enqueues for
   * drain on quarantine_exit. Existing test files unchanged because field is optional.
   */
  outboundReplayQueue?: OutboundReplayQueue;
}

const DEFAULT_API_BASE = "https://api.telegram.org";

export class TelegramAPIClientImpl implements TelegramAPIClient {
  // outboundReplayQueue stays optional; everything else is fully populated by the
  // constructor defaults below. Hand-write the type to avoid Required<> over an
  // intentionally-optional field.
  private cfg: Omit<Required<TelegramClientConfig>, "outboundReplayQueue"> & {
    outboundReplayQueue?: OutboundReplayQueue;
  };

  constructor(cfg: TelegramClientConfig) {
    this.cfg = {
      apiBase: DEFAULT_API_BASE,
      fetchFn: globalThis.fetch.bind(globalThis),
      outboundReplayQueue: cfg.outboundReplayQueue,
      ...cfg,
    };
  }

  private async post(method: string, body: unknown): Promise<{ status: number; headers: Headers; body: unknown }> {
    const url = buildMethodUrl(this.cfg.apiBase, this.cfg.token, method);
    const res = await this.cfg.fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, headers: res.headers, body: parsed };
  }

  private async get(method: string, params: Record<string, string | number>): Promise<{ status: number; headers: Headers; body: unknown }> {
    const url = new URL(buildMethodUrl(this.cfg.apiBase, this.cfg.token, method));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await this.cfg.fetchFn(url.toString(), { method: "POST" });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, headers: res.headers, body: parsed };
  }

  private quarantineEnvelope(): SendMessageEnvelope {
    const snapshot = this.cfg.pollingStatus.getSnapshot();
    const cooldown = Math.max(0, 60 - Math.floor(snapshot.since_state_change_ms / 1000));
    return { delivered: false, queued: true, eta_hint: cooldown };
  }

  async sendMessage(req: SendMessageReq, opts?: SendMessageOpts): Promise<SendMessageEnvelope> {
    const snapshot = this.cfg.pollingStatus.getSnapshot();
    if (snapshot.state === "quarantine") {
      // v1.1.0 — REQ-037 quarantine outbound replay queue. Route through queue when both
      // requester_session and the queue are present; otherwise fall back to the existing
      // stub envelope (preserves back-compat for M005 admin acks + tests without queue).
      const queue = this.cfg.outboundReplayQueue;
      if (queue !== undefined && opts?.requester_session !== undefined) {
        try {
          queue.enqueue({
            requester_session: opts.requester_session,
            // Deep-copy params so a caller mutating req (or nested reply_markup) AFTER
            // sendMessage returns cannot alter the queued entry — guarantees the drain
            // replays a byte-equivalent request (REQ-037 §1.4.6). structuredClone is
            // available in Bun's global scope.
            params: structuredClone(req),
            queued_at: this.cfg.clock.now(),
          });
          return this.quarantineEnvelope();
        } catch (e) {
          // Avoid `instanceof CapacityExceededError` — circular import (outbound-replay-queue
          // imports QUARANTINE_QUEUE_CAP from this file) could yield an undefined class
          // binding during module init. Name-based check is robust.
          if ((e as Error)?.name === "CapacityExceededError") {
            return { delivered: false, error: "capacity_exceeded" };
          }
          throw e;
        }
      }
      return this.quarantineEnvelope();
    }
    let res;
    try {
      res = await this.post("sendMessage", req);
    } catch (err) {
      const classified = classifyNetworkError(err);
      return { delivered: false, error: "disconnected", reason: classified.kind === "fatal" ? classified.reason : "network" };
    }
    const classified = classifyHttpResponse(res.status, res.headers, res.body);
    if (classified.kind === "ok") {
      const result = (res.body as { result?: SendMessageResult }).result;
      if (!result) return { delivered: false, error: "disconnected", reason: "ok_but_no_result" };
      return { delivered: true, message_id: result.message_id, result };
    }
    if (classified.kind === "rate_limited_429") {
      return { delivered: false, error: "rate_limited", retry_after_sec: classified.retryAfterSec };
    }
    if (classified.kind === "conflict_409") {
      return { delivered: false, error: "disconnected", reason: "conflict_409" };
    }
    return { delivered: false, error: "disconnected", reason: classified.reason };
  }

  async editMessageText(req: EditMessageTextReq): Promise<SendMessageEnvelope> {
    const snapshot = this.cfg.pollingStatus.getSnapshot();
    if (snapshot.state === "quarantine") return this.quarantineEnvelope();
    let res;
    try {
      res = await this.post("editMessageText", req);
    } catch (err) {
      const classified = classifyNetworkError(err);
      return { delivered: false, error: "disconnected", reason: classified.kind === "fatal" ? classified.reason : "network" };
    }
    const classified = classifyHttpResponse(res.status, res.headers, res.body);
    if (classified.kind === "ok") {
      const result = (res.body as { result?: SendMessageResult }).result;
      if (!result) return { delivered: false, error: "disconnected", reason: "ok_but_no_result" };
      return { delivered: true, message_id: result.message_id, result };
    }
    if (classified.kind === "rate_limited_429") {
      return { delivered: false, error: "rate_limited", retry_after_sec: classified.retryAfterSec };
    }
    return { delivered: false, error: "disconnected", reason: classified.kind === "fatal" ? classified.reason : "conflict_409" };
  }

  async answerCallbackQuery(req: AnswerCallbackQueryReq): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await this.post("answerCallbackQuery", req);
      const c = classifyHttpResponse(res.status, res.headers, res.body);
      if (c.kind === "ok") return { ok: true };
      return { ok: false, error: c.kind === "fatal" ? c.reason : c.kind };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err) };
    }
  }

  async getFile(file_id: string): Promise<{ ok: true; result: GetFileResult } | { ok: false; error: string }> {
    try {
      const res = await this.post("getFile", { file_id });
      const c = classifyHttpResponse(res.status, res.headers, res.body);
      if (c.kind === "ok") {
        const result = (res.body as { result?: GetFileResult }).result;
        if (!result) return { ok: false, error: "ok_but_no_result" };
        return { ok: true, result };
      }
      return { ok: false, error: c.kind === "fatal" ? c.reason : c.kind };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err) };
    }
  }

  async sendChatAction(chat_id: number | string, action: ChatAction): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await this.post("sendChatAction", { chat_id, action });
      const c = classifyHttpResponse(res.status, res.headers, res.body);
      if (c.kind === "ok") return { ok: true };
      return { ok: false, error: c.kind === "fatal" ? c.reason : c.kind };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err) };
    }
  }

  async getChat(chat_id: number): Promise<GetChatEnvelope> {
    let res;
    try {
      res = await this.post("getChat", { chat_id });
    } catch {
      return { ok: false, error: "fetch_failed" };
    }
    const c = classifyHttpResponse(res.status, res.headers, res.body);
    if (c.kind === "ok") {
      const body = res.body as { ok?: boolean; result?: GetChatResult; description?: string } | null;
      // HTTP 2xx but Telegram-reported logical error (e.g. chat not found).
      if (body && body.ok === false) {
        return { ok: false, error: body.description ?? "unknown" };
      }
      const result = body?.result;
      if (!result) return { ok: false, error: "ok_but_no_result" };
      return { ok: true, result: { id: result.id, type: result.type } };
    }
    return { ok: false, error: c.kind === "fatal" ? c.reason : c.kind };
  }

  async getUpdates(opts: GetUpdatesOpts): Promise<{ ok: true; result: TelegramUpdate[]; classified: ClassifiedError } | { ok: false; classified: ClassifiedError }> {
    const params: Record<string, string | number> = {};
    if (typeof opts.offset === "number") params.offset = opts.offset;
    if (typeof opts.timeout === "number") params.timeout = opts.timeout;
    if (opts.allowed_updates) params.allowed_updates = JSON.stringify(opts.allowed_updates);
    let res;
    try {
      res = await this.get("getUpdates", params);
    } catch (err) {
      return { ok: false, classified: classifyNetworkError(err) };
    }
    const classified = classifyHttpResponse(res.status, res.headers, res.body);
    if (classified.kind === "ok") {
      const result = ((res.body as { result?: TelegramUpdate[] }).result ?? []) as TelegramUpdate[];
      return { ok: true, result, classified };
    }
    return { ok: false, classified };
  }
}
