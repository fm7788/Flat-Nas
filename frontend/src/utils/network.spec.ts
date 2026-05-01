import { describe, it, expect } from "vitest";
import { classifyNetworkTarget, isInternalNetwork } from "./network";

describe("network rules: ip:", () => {
  it("matches ip prefix with trailing dot", () => {
    expect(classifyNetworkTarget("11.22.33.44", "ip:11.22.", "")).toBe("lan");
    expect(isInternalNetwork("11.22.33.44", "", "ip:11.22.")).toBe(true);
  });

  it("matches ip prefix without trailing dot", () => {
    expect(classifyNetworkTarget("11.22.33.44", "ip:11.22", "")).toBe("lan");
    expect(classifyNetworkTarget("11.22.33.44", "ip:11.22.33", "")).toBe("lan");
  });

  it("matches full ipv4 exactly (does not behave like prefix)", () => {
    expect(classifyNetworkTarget("11.22.33.44", "ip:11.22.33.44", "")).toBe("lan");
    expect(classifyNetworkTarget("11.22.33.45", "ip:11.22.33.44", "")).toBe("wan");
  });

  it("does not match domains", () => {
    expect(classifyNetworkTarget("example.com", "ip:11.22.", "")).toBe("wan");
  });
});

