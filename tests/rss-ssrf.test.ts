import { describe, expect, it } from "vitest";
import { GenericRssConnector, validateRssUrl } from "../src/lib/fundamental/engine";

describe("GenericRssConnector SSRF guard", () => {
  const valid = [
    "http://example.com/rss",
    "https://example.com/feed.xml",
    "https://news.example.org/rss?foo=bar",
    "http://192.0.2.1/rss", // TEST-NET-1, not private
    "https://203.0.113.10/feed", // TEST-NET-3
  ];


  it("allows public http/https URLs", () => {
    for (const url of valid) {
      const v = validateRssUrl(url);
      expect(v.ok, `${url} should be allowed`).toBe(true);
    }
  });

  it("blocks non-http/https protocols", () => {
    expect(validateRssUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateRssUrl("ftp://example.com/").ok).toBe(false);
    expect(validateRssUrl("javascript:alert(1)").ok).toBe(false);
  });

  it("blocks localhost and loopback", () => {
    for (const url of ["http://localhost/rss", "http://127.0.0.1/rss", "http://127.1.2.3/rss", "http://0.0.0.0/rss"]) {
      const v = validateRssUrl(url);
      expect(v.ok, `${url} should be blocked`).toBe(false);
      if (!v.ok) expect((v as any).reason).toMatch(/private host|localhost|loopback/);
    }
  });

  it("blocks private RFC1918 ranges", () => {
    const privates = [
      "http://10.0.0.1/rss",
      "http://192.168.1.1/rss",
      "http://172.16.5.4/rss",
      "http://172.31.255.1/rss",
    ];
    for (const url of privates) {
      const v = validateRssUrl(url);
      expect(v.ok, `${url} should be blocked`).toBe(false);
    }
    // public / non-private 172 outside 16-31 must pass
    expect(validateRssUrl("http://172.15.0.1/rss").ok).toBe(true);
    expect(validateRssUrl("http://172.32.0.1/rss").ok).toBe(true);
  });

  it("blocks link-local and metadata service", () => {
    expect(validateRssUrl("http://169.254.169.254/latest/meta-data/").ok).toBe(false);
    expect(validateRssUrl("http://metadata.google.internal/").ok).toBe(false);
  });

  it("blocks .local/.internal/.localhost TLDs", () => {
    expect(validateRssUrl("http://foo.local/rss").ok).toBe(false);
    expect(validateRssUrl("http://bar.internal/feed").ok).toBe(false);
    expect(validateRssUrl("http://example.localhost/rss").ok).toBe(false);
  });

  it("blocks URLs with embedded credentials", () => {
    expect(validateRssUrl("http://user:pass@example.com/rss").ok).toBe(false);
    expect(validateRssUrl("https://user@example.com/rss").ok).toBe(false);
  });

  it("validateRssUrl returns reason text for blocked URLs", () => {
    const v = validateRssUrl("http://10.0.0.1/rss") as { ok: false; reason: string };
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/private host/);
  });

  it("GenericRssConnector.state() reflects blocked URL as ERROR", () => {
    const c = new GenericRssConnector("http://127.0.0.1/rss");
    const st = c.state();
    expect(st.state).toBe("ERROR");
    expect(st.reason).toMatch(/blocked/i);
  });

  it("GenericRssConnector.poll() rejects blocked URL without performing fetch", async () => {
    const c = new GenericRssConnector("http://192.168.1.1/rss");
    await expect(c.poll()).rejects.toThrow(/blocked/i);
    expect(c.health.last_error).toMatch(/blocked/i);
    expect(c.health.consecutive_failures).toBeGreaterThanOrEqual(1);
  });

  it("GenericRssConnector with valid public URL reports CONNECTING before any poll", () => {
    const c = new GenericRssConnector("https://example.com/rss");
    const st = c.state();
    expect(st.state).toBe("CONNECTING");
  });

  it("blocks IPv6 private/link-local (when hostname contains colon)", () => {
    // Node URL parses IPv6 literals with brackets; hostname strips them
    expect(validateRssUrl("http://[::1]/rss").ok).toBe(false);
    expect(validateRssUrl("http://[fe80::1]/rss").ok).toBe(false);
    expect(validateRssUrl("http://[fc00::1]/rss").ok).toBe(false);
    expect(validateRssUrl("http://[fd00::1]/rss").ok).toBe(false);
    // public IPv6 should pass
    expect(validateRssUrl("http://[2600:1f18:abcd::1]/rss").ok).toBe(true);
  });

  it("source file contains SSRF guard and redirect:error", async () => {
    const fs = await import("node:fs");
    const txt = fs.readFileSync("src/lib/fundamental/engine.ts", "utf8");
    expect(txt).toMatch(/validateRssUrl/);
    expect(txt).toMatch(/redirect:\s*\"error\"/);
    expect(txt).toMatch(/private host blocked/);
  });
});
