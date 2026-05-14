export type ClassifiedError =
  | { kind: "ok" }
  | { kind: "conflict_409" }
  | { kind: "rate_limited_429"; retryAfterSec: number }
  | { kind: "fatal"; reason: string };

export function classifyHttpResponse(status: number, headers: Headers, body: unknown): ClassifiedError {
  if (status >= 200 && status < 300) return { kind: "ok" };
  if (status === 409) return { kind: "conflict_409" };
  if (status === 429) {
    const retryAfter = headers.get("retry-after");
    const retryAfterSec = retryAfter ? parseRetryAfter(retryAfter) : 5;
    return { kind: "rate_limited_429", retryAfterSec };
  }
  let reason = `http_${status}`;
  if (body && typeof body === "object" && (body as { description?: unknown }).description) {
    reason += `: ${String((body as { description: unknown }).description)}`;
  }
  return { kind: "fatal", reason };
}

export function classifyNetworkError(err: unknown): ClassifiedError {
  const code = (err as { code?: string }).code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { kind: "fatal", reason: `network:${code}` };
  }
  return { kind: "fatal", reason: `network:${String((err as Error)?.message ?? err)}` };
}

export function parseRetryAfter(raw: string): number {
  const n = parseFloat(raw);
  if (Number.isFinite(n) && n >= 0) return Math.max(0, Math.floor(n));
  return 5;
}
