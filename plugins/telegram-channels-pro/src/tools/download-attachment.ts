import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { TelegramAPIClient } from "../telegram/client";
import type { StateDir } from "../daemon/state-dir";
import { atomicWriteFile } from "../common/atomic-write";

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".webm": "video/webm",
};

export interface DownloadAttachmentParams {
  file_id: string;
}

export interface DownloadAttachmentContext {
  tg: TelegramAPIClient;
  apiBase: string;
  token: string;
  stateDir: StateDir;
  fetchFn?: typeof globalThis.fetch;
}

export type DownloadAttachmentResult =
  | {
      ok: true;
      result: {
        path: string;
        size_bytes: number;
        mime_type: string;
      };
    }
  | { ok: false; error: string };

export async function downloadAttachment(
  params: DownloadAttachmentParams,
  ctx: DownloadAttachmentContext,
): Promise<DownloadAttachmentResult> {
  if (!params.file_id || typeof params.file_id !== "string") {
    return { ok: false, error: "missing_file_id" };
  }
  const fileMeta = await ctx.tg.getFile(params.file_id);
  if (!fileMeta.ok) {
    return { ok: false, error: "InvalidFileId" };
  }
  const filePath = fileMeta.result.file_path;
  if (!filePath) {
    return { ok: false, error: "tg_no_file_path" };
  }
  const fileSize = fileMeta.result.file_size ?? 0;
  if (fileSize > 20 * 1024 * 1024) {
    return { ok: false, error: "FileTooLarge" };
  }
  const downloadUrl = `${ctx.apiBase.replace(/\/+$/, "")}/file/bot${ctx.token}/${filePath}`;
  const fetchFn = ctx.fetchFn ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchFn(downloadUrl);
  } catch (err) {
    return { ok: false, error: `fetch_failed: ${(err as Error).message}` };
  }
  if (res.status >= 400) {
    return { ok: false, error: `http_${res.status}` };
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const ext = path.extname(filePath).toLowerCase();
  const random8 = randomBytes(4).toString("hex");
  const targetName = `${random8}${ext}`;
  const targetPath = path.join(ctx.stateDir.attachmentDir, targetName);
  // Ensure attachment dir exists (M001 initializes it; this is a defensive backstop)
  try {
    fs.mkdirSync(ctx.stateDir.attachmentDir, { recursive: true, mode: 0o700 });
  } catch {
    /* ignore */
  }
  try {
    await atomicWriteFile(targetPath, buf, 0o600);
  } catch (err) {
    return { ok: false, error: `write_failed: ${(err as Error).message}` };
  }
  const mimeType =
    res.headers.get("content-type") ?? MIME_BY_EXT[ext] ?? "application/octet-stream";
  return {
    ok: true,
    result: {
      path: targetPath,
      size_bytes: buf.byteLength,
      mime_type: mimeType,
    },
  };
}
