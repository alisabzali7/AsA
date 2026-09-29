/**
 * Command-center attention derivation — only measured problems become items.
 *
 * Regression anchor: the old HOME had no "requires attention" surface at all,
 * so a blocked opportunity, a DEAD delivery row or a NETWORK_FAILURE market
 * sweep were only visible if the operator happened to open that page. The
 * derivation must stay conservative: a healthy subsystem produces no item, and
 * a problem is reported with the server's own state word.
 */
import { describe, expect, it } from "vitest";
import { attentionItems, attentionToneColor, type AttentionHealth, type AttentionOpportunity, type AttentionSignal } from "../src/components/home-attention";

const ok: AttentionHealth = { market: "LIVE" };

describe("attentionItems", () => {
  it("reports nothing when every measured subsystem is healthy", () => {
    const items = attentionItems(ok, true, [
      { id: "o1", symbol: "BTCUSDT", state: "READY", actionable: true },
    ], [
      { id: "s1", symbol: "BTCUSDT", state: "published", delivery: { delivery_state: "SENT" } },
    ]);
    expect(items).toEqual([]);
  });

  it("uses the server's own market state word and never upgrades it", () => {
    const items = attentionItems({ market: "NETWORK_FAILURE", reason: "TTT fetch failed" }, true, [], []);
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("market");
    expect(items[0].detail).toContain("NETWORK_FAILURE");
    expect(items[0].detail).toContain("TTT fetch failed");
    expect(items[0].href).toBe("/system");
    expect(items[0].tone).toBe("block");
  });

  it("reports an unanswered health endpoint without claiming a verdict", () => {
    const items = attentionItems(null, false, [], []);
    expect(items[0].detail).toContain("has not answered");
  });

  it("counts blocked and expired opportunities as blocked, not actionable", () => {
    const items = attentionItems(ok, true, [
      { id: "o1", symbol: "XRPUSDT", state: "REJECTED", actionable: false, risk: { verdict: "pass" } },
      { id: "o2", symbol: "ETHUSDT", state: "REJECTED", actionable: false },
      { id: "o3", symbol: "SOLUSDT", state: "EXPIRED", actionable: false },
    ], []);
    expect(items.find((i) => i.key === "blocked")?.detail).toContain("3 stored decision(s) not actionable");
    expect(items.find((i) => i.key === "blocked")?.detail).toContain("XRPUSDT");
  });

  it("reports psychology blocks recorded on stored decisions", () => {
    const items = attentionItems(ok, true, [
      { id: "o1", symbol: "BTCUSDT", state: "READY", psychology: { state: "BLOCKED" } },
    ], []);
    expect(items.find((i) => i.key === "psychology")?.href).toBe("/psychology");
  });

  it("separates delivery problems from decision problems", () => {
    const opps: AttentionOpportunity[] = [{ id: "o1", symbol: "BTCUSDT", state: "READY", actionable: true }];
    const dead: AttentionSignal = { id: "s1", symbol: "BTCUSDT", state: "published", delivery: { delivery_state: "DEAD" } };
    const partial: AttentionSignal = {
      id: "s2",
      symbol: "ETHUSDT",
      state: "published",
      delivery: { delivery_state: "SENDING", progress: { photo_required: true, photo_sent: true, text_sent: false } },
    };
    const items = attentionItems(ok, true, opps, [dead, partial]);
    expect(items.find((i) => i.key === "delivery")?.detail).toContain("2 signal(s) not fully delivered");
    // a decision-level problem must NOT be inferred from a transport problem
    expect(items.find((i) => i.key === "blocked")).toBeUndefined();
  });

  it("ignores a SENT delivery with no partial progress", () => {
    const items = attentionItems(ok, true, [], [
      { id: "s1", symbol: "BTCUSDT", state: "published", delivery: { delivery_state: "SENT", progress: { photo_required: true, photo_sent: true, text_sent: true } } },
    ]);
    expect(items).toEqual([]);
  });
});

describe("attentionToneColor", () => {
  it("maps every tone to a token (colour is never the only signal)", () => {
    expect(attentionToneColor("block")).toBe("var(--color-down)");
    expect(attentionToneColor("warn")).toBe("var(--color-warn)");
    expect(attentionToneColor("info")).toBe("var(--color-info)");
  });
});
