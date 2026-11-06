import { afterEach, describe, expect, it, vi } from "vitest";
import { controllerArgs, resolveEvm } from "../../src/watcher/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("resolveEvm", () => {
  it("returns the alias EVM address from the Mirror Node (Studio rejects long-zero for aliased accounts)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ evm_address: "0x11181c7d3b796e03deea91c090cea106364a93de" }))));
    expect(await resolveEvm("0.0.777001", "https://mirror.test")).toBe("0x11181c7d3b796e03deea91c090cea106364a93de");
  });

  it("falls back to the long-zero address when the Mirror Node is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect(await resolveEvm("0.0.777002", "https://mirror.test")).toBe("0x00000000000000000000000000000000000bdb2a");
  });
});

describe("controllerArgs", () => {
  it("uses the resolved EVM address when given", () => {
    const step = { step: "wipeAndFreeze" as const, account: "0.0.5", amount: "10", why: "t" };
    const a = controllerArgs(step, "0x" + "11".repeat(32), "0x11181c7d3b796e03deea91c090cea106364a93de");
    expect(a.fn).toBe("wipeAndFreeze");
  });
});
