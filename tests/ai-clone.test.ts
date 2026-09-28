import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";

// AI Clone route tests isolate every runtime store in memory.
process.env.ASA_DB_PATH = ":memory:";
process.env.ASA_HISTORY_DB_PATH = ":memory:";
process.env.ASA_BRAIN_DB_PATH = ":memory:";
import { fileURLToPath } from "node:url";
import path from "node:path";

/* ------------------------------------------------------------------ helpers */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const readSrc = (p: string) => readFileSync(path.join(repoRoot, p), "utf8");

type ChatCall = { model: string; messages: { role: string; content: string }[] };
interface MockLlm {
  url: string;
  close: () => Promise<void>;
  chatCalls: ChatCall[];
  modelsCalls: number;
  setChatResponse: (r: { status?: number; content?: string | null; raw?: string }) => void;
}

/** Local OpenAI-compatible mock (same surface the probe and the clone use). */
async function startMockLlm(): Promise<MockLlm> {
  let chatResp: { status?: number; content?: string | null; raw?: string } = {
    status: 200,
    content: "Explanation: the deterministic context reports what it reports; I can only restate it.",
  };
  const state = { chatCalls: [] as ChatCall[], modelsCalls: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      state.modelsCalls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "test-model-1" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try { state.chatCalls.push(JSON.parse(raw) as ChatCall); } catch { /* ignore */ }
        if (chatResp.raw !== undefined || (chatResp.status && chatResp.status >= 400)) {
          res.writeHead(chatResp.status ?? 500, { "Content-Type": "text/plain" });
          res.end(chatResp.raw ?? "mock provider error");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: chatResp.content } }] }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
    get chatCalls() { return state.chatCalls; },
    get modelsCalls() { return state.modelsCalls; },
    setChatResponse: (r) => { chatResp = r; },
  };
}

/** Reset the module registry, set env, then import the fresh route + store. */
async function awaitRouteEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const k of ["OLLAMA_URL", "OPENAI_BASE_URL", "OPENAI_API_KEY", "AI_OLLAMA_MODEL", "AI_OPENAI_MODEL", "AI_DEFAULT_PROVIDER"]) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  const store = await import("../src/lib/market/store");
  (globalThis as Record<string, unknown>).__asaTestStore = store;
  const route = await import("../src/app/api/ai-clone/route");
  return { route, store };
}
function storeOf() {
  return (globalThis as unknown as Record<string, { sharedStore: any }>).__asaTestStore.sharedStore;
}

async function postRoute(POST: (req: Request) => Promise<unknown>, body: Record<string, unknown>) {
  const raw = (await POST(new Request("http://localhost/api/ai-clone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }))) as Response;
  return (await raw.json()) as any;
}

/* ------------------------------------------- deterministic context builder */

describe("deterministic context (buildCloneFacts — via the real store)", () => {
  beforeEach(() => { vi.resetModules(); });

  it("symbol branch: measured values appear verbatim with source + freshness; stale marker only past 60 s", async () => {
    const { route, store } = await awaitRouteEnv({ OLLAMA_URL: undefined, OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined });
    storeOf().ingestStats({
      symbol: "XRPUSDT", lastPrice: 2.5, markPrice: null, indexPrice: null, fundingRate: 0.0001,
      nextFundingTimeMs: null, fundingIntervalHours: 8, change24hPct: null, high24h: null, low24h: null,
      volume24hQuote: null, openInterest: null, openValue: null,
      provenance: { source_name: "ttt", endpoint: "/futures/markets/stats", fetched_at_ms: Date.now() - 120_000, auth: "public" },
    } as never);
    const facts = route.buildCloneFacts("state of XRPUSDT", "XRPUSDT");
    expect(facts.some((f) => f === "FACT: XRPUSDT last price = 2.5 (source ttt /futures/markets/stats)")).toBe(true);
    expect(facts.some((f) => f === "FACT: funding rate = 0.0001")).toBe(true);
    const ageLine = facts.find((f) => f.startsWith("FACT: XRPUSDT stats measured"))!;
    expect(ageLine).toMatch(/measured 1[12]?\ds ago \(provenance: ttt \/futures\/markets\/stats\) — STALE/);
  });

  it("fresh snapshot (< 60 s) is NOT marked stale", async () => {
    const { route } = await awaitRouteEnv({});
    storeOf().ingestStats({
      symbol: "SOLUSDT", lastPrice: 150, markPrice: null, indexPrice: null, fundingRate: null,
      nextFundingTimeMs: null, fundingIntervalHours: null, change24hPct: null, high24h: null, low24h: null,
      volume24hQuote: null, openInterest: null, openValue: null,
      provenance: { source_name: "ttt", endpoint: "/futures/markets/stats", fetched_at_ms: Date.now() - 5_000, auth: "public" },
    } as never);
    const facts = route.buildCloneFacts("x", "SOLUSDT");
    const ageLine = facts.find((f) => f.startsWith("FACT: SOLUSDT stats measured"))!;
    expect(ageLine).toMatch(/measured [0-5]s ago/);
    expect(ageLine).not.toContain("STALE");
  });

  it("unknown symbol: values are 'unavailable', never invented", async () => {
    const { route } = await awaitRouteEnv({});
    const facts = route.buildCloneFacts("what about DOGE?", "DOGEUSDT");
    expect(facts.some((f) => f.includes("last price = unavailable"))).toBe(true);
    expect(facts.some((f) => f.includes("funding rate = unavailable"))).toBe(true);
  });

  it("board branch: live counts + sweep age; 'never' before first sweep", async () => {
    const { route } = await awaitRouteEnv({});
    const facts = route.buildCloneFacts("how is the market?", null);
    expect(facts.some((f) => f === "FACT: board live 0/0 universe symbols (source ttt stats sweep)")).toBe(true);
    expect(facts.some((f) => f === "FACT: stats sweep age never")).toBe(true);
  });

  it("RULE lines are deterministic and question-driven (advisory-only, probability, TON exclusion)", async () => {
    const { route } = await awaitRouteEnv({});
    expect(route.buildCloneFacts("can you buy for me now", null).some((f) => f.startsWith("RULE: AsA is advisory-only"))).toBe(true);
    expect(route.buildCloneFacts("what is the probability?", null).some((f) => f.startsWith("RULE: AsA scores are deterministic scores"))).toBe(true);
    expect(route.buildCloneFacts("tell me about TONUSDT", null).some((f) => f.includes("TONUSDT is excluded"))).toBe(true);
    const strategyFacts = route.buildCloneFacts("explain the strategy", null);
    expect(strategyFacts.some((f) => f.includes("compiled setup definition(s)") && f.includes("source contracts="))).toBe(true);
    expect(strategyFacts.some((f) => /executable strategies come from|no strategy currently holds/i.test(f))).toBe(false);
  });

  it("unmapped question: only well-formed deterministic lines, no fabricated evidence about the question", async () => {
    const { route } = await awaitRouteEnv({});
    const facts = route.buildCloneFacts("zk-snkrs-xyz", null);
    // whatever is returned is deterministic and well-formed; the question's topic is never "measured"
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((f) => /^(FACT|RULE|UNAVAILABLE):/.test(f))).toBe(true);
    expect(facts.some((f) => f.toLowerCase().includes("zk-snkrs-xyz"))).toBe(false);
  });
});

/* ------------------------------------------------------ boundary (prompt) */

describe("LLM boundary prompt", () => {
  async function prompt() {
    const { route } = await awaitRouteEnv({});
    return route.buildCloneSystemPrompt();
  }

  it("contains the hard invariants (NO TRADE, risk gates, no invention, honest unavailability, advisory-only)", async () => {
    const p = await prompt();
    expect(p).toContain("NO TRADE");
    expect(p).toMatch(/risk gate/i);
    expect(p).toMatch(/Never invent/i);
    expect(p).toMatch(/UNAVAILABLE|unavailable/);
    expect(p).toMatch(/never executes trades/i);
    expect(p).toMatch(/Do not introduce new trading rules/i);
  });

  it("style is the only free dimension (language/tone/brevity) — no style-derived trading logic", async () => {
    const p = await prompt();
    expect(p).toContain("STYLE (the only dimension you may vary)");
    const style = p.slice(p.indexOf("STYLE (the only dimension"));
    expect(style).toMatch(/language/i);
    expect(style).toMatch(/concise/i);
    // no trading-signal vocabulary smuggled into the style section
    expect(style).not.toMatch(/aggressive|momentum|breakout|oversold|overbought|buy signal|sell signal/i);
  });
});

/* ------------------------------------- conversation layer (real route + mock LLM) */

describe("AI Clone route: deterministic context + LLM conversation (real POST, mock provider)", () => {
  let mock: MockLlm;
  beforeAll(async () => { mock = await startMockLlm(); });
  afterAll(async () => { await mock.close(); });
  beforeEach(() => { vi.resetModules(); mock.setChatResponse({ status: 200, content: "Explanation: I can only restate the deterministic context." }); mock.chatCalls.length = 0; });

  it("context propagation: deterministic facts reach the response unchanged and the LLM is actually in the loop", async () => {
    const { route } = await awaitRouteEnv({ OLLAMA_URL: mock.url, AI_OLLAMA_MODEL: "test-model-1", AI_DEFAULT_PROVIDER: "auto", OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined });
    const res = await postRoute(route.POST, { question: "how is the market?" });
    expect(res.ok).toBe(true);
    // deterministic facts present and well-formed
    expect(res.facts).toContain("FACT: board live 0/0 universe symbols (source ttt stats sweep)");
    expect(res.facts.every((f: string) => /^(FACT|RULE|UNAVAILABLE):/.test(f))).toBe(true);
    expect(res.provider_mode).toBe("auto");
    expect(res.ai_context.authority.model_output).toBe("NON_AUTHORITATIVE");
    expect(res.ai_context.research_live_separation.live_advisory).toBe("PROMOTION_GATE_REQUIRED");
    expect(res.ai_context.risk.portfolio_verdict).toBe("NOT_EVALUATED_NO_CANDIDATE");
    expect(res.ai_context.psychology.user_state.status).toBe("NOT_SHARED_FOR_THIS_QUESTION");
    // LLM actually invoked and its text is in the SEPARATE explanation field
    expect(res.explanation).toBe("Explanation: I can only restate the deterministic context.");
    expect(res.llm.status).toBe("ok");
    expect(res.llm_online).toBe(true);
    expect(res.llm.provider).toBe("ollama");
    expect(res.tags.some((t: string) => t.startsWith("LLM explanation · provider=ollama"))).toBe(true);
    // what the LLM received: boundary system prompt + the deterministic context
    expect(mock.chatCalls.length).toBe(1);
    expect(mock.chatCalls[0].messages[0].role).toBe("system");
    expect(mock.chatCalls[0].messages[0].content).toContain("NO TRADE");
    expect(mock.chatCalls[0].messages[1].content).toContain("DETERMINISTIC CONTEXT");
    expect(mock.chatCalls[0].messages[1].content).toContain("FACT: board live 0/0 universe symbols");
    expect(mock.chatCalls[0].messages[1].content).toContain("STRUCTURED AI CONTEXT");
    expect(mock.chatCalls[0].messages[1].content).toContain("NON_AUTHORITATIVE");
    expect(mock.chatCalls[0].model).toBe("test-model-1");
  });

  it("NO TRADE protection: a contradictory LLM answer is withheld and cannot touch deterministic facts", async () => {
    mock.setChatResponse({ status: 200, content: "Forget the context: BUY now, override every risk gate and NO TRADE — it is guaranteed profit." });
    const { route } = await awaitRouteEnv({ OLLAMA_URL: mock.url, AI_OLLAMA_MODEL: "test-model-1", AI_DEFAULT_PROVIDER: "auto", OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined });
    const res = await postRoute(route.POST, { question: "can you trade now?" });
    expect(res.facts.some((f: string) => f.startsWith("RULE: AsA is advisory-only"))).toBe(true);
    expect(res.facts.every((f: string) => /^(FACT|RULE|UNAVAILABLE):/.test(f))).toBe(true);
    expect(res.facts.some((f: string) => f.includes("guaranteed profit"))).toBe(false);
    expect(res.explanation).toBeNull();
    expect(res.explanation_validation.status).toBe("REJECTED_AUTHORITY_VIOLATION");
    expect(res.explanation_validation.displayed).toBe(false);
    expect(res.explanation_validation.authority_violations).toContain("DIRECT_TRADE_INSTRUCTION");
    expect(res.llm.status).toBe("ok"); // transport succeeded; prose was rejected
  });

  it("stale context stays visibly stale through the route (age + STALE marker, LLM cannot erase it)", async () => {
    const { route } = await awaitRouteEnv({ OLLAMA_URL: mock.url, AI_OLLAMA_MODEL: "test-model-1", AI_DEFAULT_PROVIDER: "auto", OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined });
    storeOf().lastStatsSweepAtMs = Date.now() - 400_000;
    const res = await postRoute(route.POST, { question: "how is the market?" });
    const sweepLine = res.facts.find((f: string) => f.startsWith("FACT: stats sweep age"))!;
    expect(sweepLine).toMatch(/stats sweep age (399|400|401)s — STALE/);
    expect(res.explanation).toBe("Explanation: I can only restate the deterministic context.");
  });

  it("missing LLM (nothing configured): deterministic assembly only, honest tag, no LLM call attempted", async () => {
    const { route } = await awaitRouteEnv({ OLLAMA_URL: undefined, OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined, AI_DEFAULT_PROVIDER: "auto" });
    const res = await postRoute(route.POST, { question: "how is the market?" });
    expect(res.ok).toBe(true);
    expect(res.explanation).toBeNull();
    expect(res.llm.status).toBe("disabled");
    expect(res.llm_online).toBe(false);
    expect(res.tags).toContain("deterministic assembly only · selected LLM provider unavailable (ollama=NOT_CONFIGURED, openai=NOT_CONFIGURED)");
    expect(res.llm.error).toBe("selected provider unavailable (ollama=NOT_CONFIGURED, openai=NOT_CONFIGURED)");
    expect(res.facts.every((f: string) => /^(FACT|RULE|UNAVAILABLE):/.test(f))).toBe(true);
    expect(mock.chatCalls.length).toBe(0);
  });

  it("LLM failure: explicit LLM FAILED label, deterministic facts intact, no fake-online", async () => {
    mock.setChatResponse({ status: 500, raw: "mock provider down" });
    const { route } = await awaitRouteEnv({ OLLAMA_URL: mock.url, AI_OLLAMA_MODEL: "test-model-1", AI_DEFAULT_PROVIDER: "auto", OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined });
    const res = await postRoute(route.POST, { question: "how is the market?" });
    expect(res.explanation).toBeNull();
    expect(res.llm.status).toBe("fallback");
    expect(res.llm_online).toBe(false);
    expect(res.llm.error).toContain("mock provider down");
    expect(res.tags.some((t: string) => t.startsWith("deterministic assembly only · LLM FAILED"))).toBe(true);
    expect(res.facts.some((f: string) => f.startsWith("FACT:"))).toBe(true);
    expect(mock.chatCalls.length).toBe(1); // one attempt, then honest fallback
  });

  it("heuristic provider mode: no LLM call even when a provider is online", async () => {
    const { route } = await awaitRouteEnv({ OLLAMA_URL: mock.url, AI_OLLAMA_MODEL: "test-model-1", AI_DEFAULT_PROVIDER: "heuristic", OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined });
    const res = await postRoute(route.POST, { question: "how is the market?" });
    expect(res.explanation).toBeNull();
    expect(res.llm.status).toBe("disabled");
    expect(res.provider_mode).toBe("heuristic");
    expect(res.tags.some((t: string) => t.includes("LLM disabled (selected provider mode=heuristic)"))).toBe(true);
    expect(mock.chatCalls.length).toBe(0);
  });

  it("persisted provider preference takes precedence over the environment default", async () => {
    const { route } = await awaitRouteEnv({ OLLAMA_URL: mock.url, AI_OLLAMA_MODEL: "test-model-1", AI_DEFAULT_PROVIDER: "auto", OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined });
    const db = await import("../src/db/sqlite");
    db.getRepo().configSet("pref.ai.provider", "heuristic");
    const res = await postRoute(route.POST, { question: "how is the market?" });
    expect(res.provider_mode).toBe("heuristic");
    expect(res.explanation).toBeNull();
    expect(mock.chatCalls.length).toBe(0);
  });

  it("an explicit provider selection does not fail over to a different configured provider", async () => {
    const { route } = await awaitRouteEnv({ OLLAMA_URL: mock.url, AI_OLLAMA_MODEL: "test-model-1", AI_DEFAULT_PROVIDER: "auto", OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined });
    const db = await import("../src/db/sqlite");
    db.getRepo().configSet("pref.ai.provider", "openai");
    const res = await postRoute(route.POST, { question: "how is the market?" });
    expect(res.provider_mode).toBe("openai");
    expect(res.explanation).toBeNull();
    expect(res.llm.status).toBe("disabled");
    expect(res.llm.error).toContain("openai=NOT_CONFIGURED");
    expect(mock.chatCalls.length).toBe(0);
  });

  it("user psychology data is omitted unless the question explicitly asks about the user", async () => {
    const { route } = await awaitRouteEnv({ OLLAMA_URL: undefined, OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined });
    const general = await postRoute(route.POST, { question: "how is the market?" });
    expect(general.ai_context.psychology.user_state.status).toBe("NOT_SHARED_FOR_THIS_QUESTION");
    expect(general.ai_context.psychology.source_archive.status).toBe("NOT_SHARED_FOR_THIS_QUESTION");
    expect(general.ai_context.psychology.source_archive.manifest_sha256).toBeNull();
    expect(general.ai_context.psychology.source_archive.sources).toEqual([]);
    expect(general.ai_context.psychology.source_only_principles).toEqual([]);
    const unrelatedFirstPerson = await postRoute(route.POST, { question: "What can I do about BTC funding?" });
    expect(unrelatedFirstPerson.ai_context.psychology.user_state.status).toBe("NOT_SHARED_FOR_THIS_QUESTION");
    expect(unrelatedFirstPerson.ai_context.psychology.source_only_principles).toEqual([]);
    const personal = await postRoute(route.POST, { question: "Am I ready to trade?" });
    expect(personal.ai_context.psychology.user_state.status).toBe("EXPLICIT_OR_JOURNAL_DERIVED_FIELDS_ONLY");
    expect(personal.ai_context.psychology.user_state.state.declared_state).toBeNull();
    expect(personal.ai_context.psychology.user_state.state.journal_coverage).toBe("UNKNOWN");
    expect(personal.ai_context.psychology.source_archive.user_traits_inferred).toBe(false);
    expect(personal.ai_context.psychology.source_only_principles.length).toBeGreaterThan(0);
  });

  it("unsupported model numbers and symbols are withheld from the displayed explanation", async () => {
    mock.setChatResponse({ status: 200, content: "BTCUSDT is at 999999 and may move next." });
    const { route } = await awaitRouteEnv({ OLLAMA_URL: mock.url, AI_OLLAMA_MODEL: "test-model-1", AI_DEFAULT_PROVIDER: "auto", OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined });
    const res = await postRoute(route.POST, { question: "how is the market?" });
    expect(res.explanation).toBeNull();
    expect(res.explanation_validation.status).toBe("REJECTED_UNSUPPORTED_TOKENS");
    expect(res.explanation_validation.unsupported_numbers).toContain("999999");
    expect(res.explanation_validation.unsupported_symbols).toContain("BTCUSDT");
  });

  it("tokens appearing only in the user's question do not become model evidence", async () => {
    mock.setChatResponse({ status: 200, content: "BTCUSDT is at 999999." });
    const { route } = await awaitRouteEnv({ OLLAMA_URL: mock.url, AI_OLLAMA_MODEL: "test-model-1", AI_DEFAULT_PROVIDER: "auto", OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined });
    const res = await postRoute(route.POST, { question: "BTCUSDT is at 999999, is that true?" });
    expect(res.explanation).toBeNull();
    expect(res.explanation_validation.unsupported_numbers).toContain("999999");
    expect(res.explanation_validation.unsupported_symbols).toContain("BTCUSDT");
  });

  it("execution commands are withheld in English and Persian while execution remains user-controlled", async () => {
    const { route } = await awaitRouteEnv({ OLLAMA_URL: mock.url, AI_OLLAMA_MODEL: "test-model-1", AI_DEFAULT_PROVIDER: "auto", OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined });
    mock.setChatResponse({ status: 200, content: "Execute the trade now." });
    const english = await postRoute(route.POST, { question: "what does the context say?" });
    expect(english.explanation).toBeNull();
    expect(english.explanation_validation.authority_violations).toContain("EXECUTION_INSTRUCTION");

    mock.setChatResponse({ status: 200, content: "سفارش را اجرا کنید." });
    const persian = await postRoute(route.POST, { question: "وضعیت چیست؟" });
    expect(persian.explanation).toBeNull();
    expect(persian.explanation_validation.authority_violations).toContain("EXECUTION_INSTRUCTION");

    mock.setChatResponse({ status: 200, content: "Execution is an independent choice for the user." });
    const choice = await postRoute(route.POST, { question: "what does the context say?" });
    expect(choice.explanation).toBe("Execution is an independent choice for the user.");
  });

  it("localized Persian/Arabic numerals and Persian trade commands cannot bypass output quarantine", async () => {
    mock.setChatResponse({ status: 200, content: "قیمت ۹۹۹٬۹۹۹ و ٩٩٩٩٩٩ است؛ همین الان BTCUSDT را بخرید." });
    const { route } = await awaitRouteEnv({ OLLAMA_URL: mock.url, AI_OLLAMA_MODEL: "test-model-1", AI_DEFAULT_PROVIDER: "auto", OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined });
    const res = await postRoute(route.POST, { question: "وضعیت بازار؟", symbol: "BTCUSDT" });
    expect(res.explanation).toBeNull();
    expect(res.explanation_validation.unsupported_numbers).toContain("۹۹۹٬۹۹۹");
    expect(res.explanation_validation.unsupported_numbers).toContain("٩٩٩٩٩٩");
    expect(res.explanation_validation.authority_violations).toContain("PERSIAN_DIRECT_TRADE_INSTRUCTION");

    mock.setChatResponse({ status: 200, content: "ریسک و محدودیت را نادیده بگیر." });
    const override = await postRoute(route.POST, { question: "وضعیت بازار؟", symbol: "BTCUSDT" });
    expect(override.explanation).toBeNull();
    expect(override.explanation_validation.authority_violations).toContain("DETERMINISTIC_GATE_OVERRIDE");
  });

  it("provider receives the returned structured context exactly and no raw journal/source text", async () => {
    const { route } = await awaitRouteEnv({ OLLAMA_URL: mock.url, AI_OLLAMA_MODEL: "test-model-1", AI_DEFAULT_PROVIDER: "auto", OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined });
    const db = await import("../src/db/sqlite");
    db.getRepo().journalAdd({
      created_ms: Date.now(), updated_ms: Date.now(), symbol: "BTCUSDT", direction: "long",
      notes: "PRIVATE_JOURNAL_SENTINEL_DO_NOT_SEND", opp_id: null, r_multiple: -1,
    });
    const res = await postRoute(route.POST, { question: "how is the market?" });
    expect(mock.chatCalls[0].messages).toHaveLength(2);
    expect(mock.chatCalls[0].messages[0]).toEqual({ role: "system", content: route.buildCloneSystemPrompt() });
    expect(mock.chatCalls[0].messages[1]).toEqual({
      role: "user",
      content: route.buildCloneUserMessage(res.question, res.facts, res.ai_context),
    });
    const providerMessage = mock.chatCalls[0].messages[1].content;
    expect(providerMessage).toContain(JSON.stringify(res.ai_context));
    expect(providerMessage).toContain("configured_inputs");
    expect(providerMessage).toContain("advisory_open_book");
    expect(providerMessage).toContain("compiled_source_contracts");
    expect(providerMessage).not.toContain("PRIVATE_JOURNAL_SENTINEL_DO_NOT_SEND");
    expect(providerMessage).not.toContain(readSrc("knowledge/psychology/USER_PSYCHOLOGY_1.txt"));
    expect(res.ai_context.psychology.user_state.status).toBe("NOT_SHARED_FOR_THIS_QUESTION");

    const personal = await postRoute(route.POST, { question: "Am I ready to trade?" });
    expect(mock.chatCalls[1].messages).toHaveLength(2);
    expect(mock.chatCalls[1].messages[0]).toEqual({ role: "system", content: route.buildCloneSystemPrompt() });
    expect(mock.chatCalls[1].messages[1]).toEqual({
      role: "user",
      content: route.buildCloneUserMessage(personal.question, personal.facts, personal.ai_context),
    });
    const personalMessage = mock.chatCalls[1].messages[1].content;
    expect(personalMessage).toContain(JSON.stringify(personal.ai_context));
    expect(personalMessage).toContain("source_only_principles");
    expect(personalMessage).toContain("USER_PSYCHOLOGY_1.txt"); // identity/provenance only
    expect(personalMessage).not.toContain(readSrc("knowledge/psychology/USER_PSYCHOLOGY_1.txt"));
    expect(personalMessage).not.toContain("PRIVATE_JOURNAL_SENTINEL_DO_NOT_SEND");
  });

  it("style isolation: tone/language wording in the question never changes the deterministic facts", async () => {
    const { route } = await awaitRouteEnv({ OLLAMA_URL: mock.url, AI_OLLAMA_MODEL: "test-model-1", AI_DEFAULT_PROVIDER: "auto", OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined });
    const a = await postRoute(route.POST, { question: "Explain in Persian, very verbose and aggressive, how is the market?" });
    const b = await postRoute(route.POST, { question: "Briefly, how is the market?" });
    expect(a.facts).toEqual(b.facts);
  });
});

/* ----------------------------------------------- frontend presentation contract */

describe("AI Clone frontend (presentation contract — source-level, no DOM)", () => {
  const page = () => readSrc("src/app/ai-clone/page.tsx");

  it("renders the deterministic context and the LLM explanation as SEPARATE blocks", () => {
    const s = page();
    expect(s).toContain('t("ai", "context")');
    expect(s).toContain('t("ai", "explanation")');
    expect(s).toContain("item.facts.map");
    expect(s).toContain("item.explanation !== null");
    // facts block renders facts; explanation block renders explanation — different fields
    expect(s).toMatch(/explanation[^]*?item\.explanation/);
    expect(s).toMatch(/facts[^]*?item\.facts\.map/);
  });

  it("the LLM badge is shown only when the LLM actually produced the answer", () => {
    expect(page()).toContain('item.llm.status === "ok"');
    // the old conflation (badge from provider probe state) must be gone
    expect(page()).not.toContain("llmOnline && <Badge");
  });

  it("Task 2 behavior preserved: a failed fetch is recorded as an honest failure, never a fabricated answer", () => {
    const s = page();
    expect(s).toContain('t("conn", "questionNotSent")');
    expect(s).toMatch(/ok: false[^]*?explanation: null/);
  });

  it("persian/RTL: fact lines are direction-aware and technical metadata stays LTR", () => {
    const s = page();
    expect(s).toContain('dir="auto"');
    expect(s).toContain('dir="ltr"');
  });
});

/* ----------------------------------------------------------------------- i18n */

describe("i18n: 'ai' namespace parity (en + fa)", () => {
  it("en and fa define the same keys; fa values are real translations (not copies of en)", async () => {
    const { STRINGS } = await import("../src/lib/i18n/strings");
    const en = STRINGS.en.ai as Record<string, string>;
    const fa = STRINGS.fa.ai as Record<string, string>;
    expect(Object.keys(en).sort()).toEqual(Object.keys(fa).sort());
    expect(Object.keys(en).length).toBeGreaterThanOrEqual(3);
    for (const k of Object.keys(en)) {
      expect(fa[k].length).toBeGreaterThan(0);
      expect(fa[k]).not.toEqual(en[k]);
    }
    expect(en.context).toBeTruthy();
    expect(en.explanation).toBeTruthy();
    expect(en.footnote).toBeTruthy();
  });
});
