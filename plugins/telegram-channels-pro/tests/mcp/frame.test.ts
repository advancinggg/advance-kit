import { describe, expect, test } from "bun:test";
import { encodeFrame, FrameDecoder, FrameTooLarge, MAX_FRAME_BYTES } from "../../src/mcp/frame";

describe("MODULE-003-AC-04: frame encoder rejects oversize payloads", () => {
  test("MODULE-003-T04 — encode payload > 1 MiB throws FrameTooLarge", () => {
    const big = "x".repeat(MAX_FRAME_BYTES + 10);
    expect(() => encodeFrame({ kind: "tool_call", padding: big })).toThrow(FrameTooLarge);
  });

  test("encode small payload succeeds and adds 4-byte BE length prefix", () => {
    const buf = encodeFrame({ kind: "session_init", shortid: "abc" });
    expect(buf.byteLength).toBeGreaterThan(4);
    const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false);
    expect(len).toBe(buf.byteLength - 4);
  });
});

describe("MODULE-003-AC-05/AC-06: frame decoder rejects oversize + malformed JSON", () => {
  test("MODULE-003-T05 — declared length > 1 MiB returns invalid:oversize", () => {
    const dec = new FrameDecoder(MAX_FRAME_BYTES);
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false);
    const r = dec.push(buf);
    expect(r.invalid).not.toBeNull();
    expect(r.invalid!.kind).toBe("oversize");
  });

  test("MODULE-003-T06 — malformed JSON body returns invalid:malformed_json", () => {
    const dec = new FrameDecoder();
    const body = new TextEncoder().encode("not json{[");
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, body.byteLength, false);
    const out = new Uint8Array(header.byteLength + body.byteLength);
    out.set(header);
    out.set(body, 4);
    const r = dec.push(out);
    expect(r.invalid).not.toBeNull();
    expect(r.invalid!.kind).toBe("malformed_json");
  });

  test("decoder handles incomplete frames (waits for more bytes)", () => {
    const dec = new FrameDecoder();
    const r1 = dec.push(new Uint8Array([0, 0, 0, 10])); // declared length 10
    expect(r1.frames.length).toBe(0);
    expect(r1.invalid).toBeNull();
    // Now push half the body
    const partial = new Uint8Array([1, 2, 3, 4]);
    const r2 = dec.push(partial);
    expect(r2.frames.length).toBe(0);
    expect(r2.invalid).toBeNull();
  });

  test("decoder splits a stream into multiple frames", () => {
    const dec = new FrameDecoder();
    const f1 = encodeFrame({ kind: "session_init", shortid: "a1" });
    const f2 = encodeFrame({ kind: "tool_call", request_id: "r1", tool: "reply", params: {} });
    const combined = new Uint8Array(f1.byteLength + f2.byteLength);
    combined.set(f1, 0);
    combined.set(f2, f1.byteLength);
    const r = dec.push(combined);
    expect(r.frames.length).toBe(2);
    expect((r.frames[0] as { kind: string }).kind).toBe("session_init");
    expect((r.frames[1] as { kind: string }).kind).toBe("tool_call");
  });
});
