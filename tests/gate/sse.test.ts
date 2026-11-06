import { describe, expect, it } from "vitest";
import { formatSse, SseHub } from "../../src/gate/sse.js";

describe("formatSse", () => {
  it("formats id, event and JSON data with a blank line terminator", () => {
    expect(formatSse("decision", { ok: true }, 3)).toBe('id: 3\nevent: decision\ndata: {"ok":true}\n\n');
  });
  it("serialises bigint and omits id when absent", () => {
    expect(formatSse("x", { n: 5n })).toBe('event: x\ndata: {"n":"5"}\n\n');
  });
  it("cannot be broken by newlines in the event name or data", () => {
    const f = formatSse("a\nevent: evil", { s: "line1\nline2" });
    expect(f.split("\n").filter((l) => l.startsWith("event:"))).toHaveLength(1);
    expect(f.endsWith("\n\n")).toBe(true);
    expect(f.slice(0, -2)).not.toContain("\n\n");
  });
});

describe("SseHub", () => {
  it("publishes to connected clients with increasing ids and replays history to new ones", () => {
    const hub = new SseHub(2);
    const written: string[] = [];
    let onClose: () => void = () => {};
    const res = { writeHead: () => {}, write: (s: string) => written.push(s) } as never;
    const req = { on: (_e: string, cb: () => void) => (onClose = cb) } as never;
    hub.publish("a", 1);
    hub.publish("b", 2);
    hub.publish("c", 3);
    hub.handler(req, res);
    expect(hub.size).toBe(1);
    expect(written.slice(1)).toEqual([formatSse("b", 2, 2), formatSse("c", 3, 3)]);
    hub.publish("d", 4);
    expect(written.at(-1)).toBe(formatSse("d", 4, 4));
    onClose();
    expect(hub.size).toBe(0);
  });
});
