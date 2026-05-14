import type { PollingStatusImpl } from "../telegram/polling-status";
import { buildMethodUrl } from "../telegram/methods";

/**
 * M004-internal helper for `setMessageReaction` — kept off CONTRACT-004 surface
 * per CCD-1 (only methods used by ≥2 modules belong in TelegramAPIClient).
 */
export interface SetReactionArgs {
  apiBase: string;
  token: string;
  chat_id: number | string;
  message_id: number;
  emoji: string;
  pollingStatus: PollingStatusImpl;
  fetchFn?: typeof globalThis.fetch;
}

export type SetReactionResult =
  | { ok: true }
  | { ok: false; error: "rate_limited"; retry_after_sec: number }
  | { ok: false; error: string };

export async function setReaction(args: SetReactionArgs): Promise<SetReactionResult> {
  const snap = args.pollingStatus.getSnapshot();
  if (snap.state === "quarantine") {
    return { ok: false, error: "quarantine" };
  }
  const url = buildMethodUrl(args.apiBase, args.token, "setMessageReaction");
  const fetchFn = args.fetchFn ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: args.chat_id,
        message_id: args.message_id,
        reaction: [{ type: "emoji", emoji: args.emoji }],
      }),
    });
  } catch (err) {
    return { ok: false, error: `fetch_failed: ${(err as Error).message}` };
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") ?? 0);
    return { ok: false, error: "rate_limited", retry_after_sec: retryAfter };
  }
  if (res.status >= 400) {
    return { ok: false, error: `http_${res.status}` };
  }
  let body: { ok?: boolean };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, error: "non_json_response" };
  }
  if (!body.ok) return { ok: false, error: "tg_not_ok" };
  return { ok: true };
}
