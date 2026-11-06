import { describe, expect, it } from "vitest";
import { consensusToMs, countdown, formatAmount } from "../format";

describe("format", () => {
  it("amounts", () => {
    expect(formatAmount("10000000000", 6)).toBe("10,000");
    expect(formatAmount("250500000", 6)).toBe("250.5");
  });
  it("consensus time", () => expect(consensusToMs("1793935176.883570919")).toBe(1793935176883));
  it("countdown", () => expect(countdown(179_001)).toBe("3:00"));
});
