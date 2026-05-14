export const MAX_FRAME_BYTES = 1_048_576; // 1 MiB

export class FrameTooLarge extends Error {
  readonly code = "FRAME_TOO_LARGE" as const;
  constructor(public byteLength: number) {
    super(`Frame body size ${byteLength} exceeds max ${MAX_FRAME_BYTES}`);
    this.name = "FrameTooLarge";
  }
}

export function encodeFrame(obj: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  if (body.byteLength > MAX_FRAME_BYTES) throw new FrameTooLarge(body.byteLength);
  const out = new Uint8Array(4 + body.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.byteLength, false); // big-endian
  out.set(body, 4);
  return out;
}

export type DecodeReason = "oversize" | "malformed_json" | "incomplete" | "ok";

export interface DecodeStepResult {
  frames: unknown[];
  invalid: null | { kind: "oversize" | "malformed_json"; detail: string };
}

export class FrameDecoder {
  private buffer = new Uint8Array(0);
  private lastByteAt = Date.now();
  constructor(public maxFrameBytes: number = MAX_FRAME_BYTES) {}

  push(chunk: Uint8Array): DecodeStepResult {
    this.lastByteAt = Date.now();
    // Adversarial fix: hard ceiling on buffered bytes BEFORE concatenation. Even with
    // the same-uid trust boundary, refuse to grow the read buffer past 4 + maxFrameBytes;
    // a peer that floods us with bytes ahead of the length header is rejected.
    const projectedSize = this.buffer.byteLength + chunk.byteLength;
    if (projectedSize > 4 + this.maxFrameBytes) {
      // We don't even bother concatenating; signal oversize and drop the connection.
      return { frames: [], invalid: { kind: "oversize", detail: `buffered ${projectedSize} bytes > 4 + max ${this.maxFrameBytes}` } };
    }
    // Concatenate.
    const merged = new Uint8Array(projectedSize);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;
    const frames: unknown[] = [];
    while (this.buffer.byteLength >= 4) {
      const len = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getUint32(0, false);
      if (len > this.maxFrameBytes) {
        return { frames, invalid: { kind: "oversize", detail: `declared length ${len} > max ${this.maxFrameBytes}` } };
      }
      if (this.buffer.byteLength < 4 + len) break; // wait for more bytes
      const body = this.buffer.slice(4, 4 + len);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      } catch (err) {
        return { frames, invalid: { kind: "malformed_json", detail: String((err as Error)?.message ?? err) } };
      }
      frames.push(parsed);
      this.buffer = this.buffer.slice(4 + len);
    }
    return { frames, invalid: null };
  }

  bytesInBuffer(): number {
    return this.buffer.byteLength;
  }

  lastByteReceivedAt(): number {
    return this.lastByteAt;
  }
}
