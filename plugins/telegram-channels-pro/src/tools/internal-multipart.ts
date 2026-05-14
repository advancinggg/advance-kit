import * as fs from "node:fs";
import * as path from "node:path";
import type { PollingStatusImpl } from "../telegram/polling-status";
import { buildMethodUrl } from "../telegram/methods";
import type { SendMessageEnvelope } from "../telegram/client";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

/**
 * M004-internal helper for sending a single TG attachment via multipart/form-data.
 * Routes to `sendPhoto` for image extensions, `sendDocument` otherwise.
 *
 * Kept M004-internal (NOT exposed via CONTRACT-004) per CCD-1 — keeps the M002
 * TelegramAPIClient surface minimal (only methods used by ≥2 modules).
 */
export interface MultipartUploadArgs {
  apiBase: string;
  token: string;
  chat_id: number | string;
  file_path: string;
  caption?: string;
  reply_to_message_id?: number;
  pollingStatus: PollingStatusImpl;
  fetchFn?: typeof globalThis.fetch;
}

export async function uploadAttachment(args: MultipartUploadArgs): Promise<SendMessageEnvelope> {
  // Quarantine-aware: mirror sendMessage's pre-flight check
  const snap = args.pollingStatus.getSnapshot();
  if (snap.state === "quarantine") {
    return { delivered: false, queued: true, eta_hint: 0 };
  }
  const ext = path.extname(args.file_path).toLowerCase();
  const method = IMAGE_EXTS.has(ext) ? "sendPhoto" : "sendDocument";
  const fileFieldName = method === "sendPhoto" ? "photo" : "document";
  const url = buildMethodUrl(args.apiBase, args.token, method);
  let buf: Uint8Array;
  try {
    buf = fs.readFileSync(args.file_path);
  } catch (err) {
    return { delivered: false, error: "disconnected", reason: `read_failed: ${(err as Error).message}` };
  }
  const form = new FormData();
  form.set("chat_id", String(args.chat_id));
  if (args.caption) form.set("caption", args.caption);
  if (args.reply_to_message_id !== undefined) {
    form.set("reply_to_message_id", String(args.reply_to_message_id));
  }
  // Use Blob constructor — Bun's FormData accepts File-like Blobs
  const filename = path.basename(args.file_path);
  const blob = new Blob([buf]);
  form.set(fileFieldName, blob, filename);
  const fetchFn = args.fetchFn ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchFn(url, { method: "POST", body: form });
  } catch (err) {
    return { delivered: false, error: "disconnected", reason: `fetch_failed: ${(err as Error).message}` };
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") ?? 0);
    return { delivered: false, error: "rate_limited", retry_after_sec: retryAfter };
  }
  if (res.status >= 400) {
    return { delivered: false, error: "disconnected", reason: `http_${res.status}` };
  }
  let body: { ok?: boolean; result?: { message_id?: number } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { delivered: false, error: "disconnected", reason: "non_json_response" };
  }
  if (!body.ok || !body.result?.message_id) {
    return { delivered: false, error: "disconnected", reason: "ok_but_no_result" };
  }
  return { delivered: true, message_id: body.result.message_id, result: body.result as { message_id: number; date: number; chat: { id: number; type: string } } };
}
