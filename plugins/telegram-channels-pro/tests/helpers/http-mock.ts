export interface MockResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Optional delay before resolving (ms). */
  delayMs?: number;
  /** Optional fault to throw (network error simulation). */
  throwError?: { code?: string; message?: string };
}

export interface MockFetchHandle {
  fetch: typeof globalThis.fetch;
  enqueue(res: MockResponse): void;
  enqueueMany(res: MockResponse[]): void;
  pending(): number;
  callsMade(): Array<{ url: string; init?: RequestInit }>;
  reset(): void;
}

export function makeMockFetch(): MockFetchHandle {
  const queue: MockResponse[] = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) {
      // Default: 200 ok with `{ ok: true, result: [] }`
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (next.delayMs) await new Promise<void>((res) => setTimeout(res, next.delayMs));
    if (next.throwError) {
      const err = new Error(next.throwError.message ?? "mock error") as NodeJS.ErrnoException;
      if (next.throwError.code) err.code = next.throwError.code;
      throw err;
    }
    const headers = new Headers({ "content-type": "application/json", ...(next.headers ?? {}) });
    return new Response(JSON.stringify(next.body ?? null), { status: next.status, headers });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    enqueue(res) {
      queue.push(res);
    },
    enqueueMany(res) {
      queue.push(...res);
    },
    pending() {
      return queue.length;
    },
    callsMade() {
      return calls.slice();
    },
    reset() {
      queue.length = 0;
      calls.length = 0;
    },
  };
}
