import { describe, it, expect } from "vitest";
import { parseSse } from "../scripts/demo/lib.js";
import { formatSse } from "../src/gate/sse.js";

describe("demo SSE parser", () => {
  it("round-trips frames written by SseHub and keeps partial frames", () => {
    const a = formatSse("matched", { txId: "0.0.1-1-000000001", amount: "5" }, 1);
    const b = formatSse("breach", { reason: "no-receipt" }, 2);
    const { frames, rest } = parseSse(": connected\n\n" + a + b.slice(0, 10), 7);
    expect(frames).toEqual([{ id: "1", event: "matched", data: { txId: "0.0.1-1-000000001", amount: "5" }, receivedAt: 7 }]);
    const more = parseSse(rest + b.slice(10), 8);
    expect(more.frames[0]).toMatchObject({ id: "2", event: "breach", data: { reason: "no-receipt" } });
    expect(more.rest).toBe("");
  });
  it("parses the checker's unnamed data-only frames as message events", () => {
    const { frames } = parseSse('data: {"type":"heartbeat"}\n\n');
    expect(frames[0]).toMatchObject({ event: "message", data: { type: "heartbeat" } });
  });
});
