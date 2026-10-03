import { afterEach, describe, expect, it } from "vitest";
import { writerBackend } from "../src/config.js";
import { apiCostUsd } from "../src/answers/resolve.js";

describe("how Claude is reached", () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, backend: process.env.WRITER_BACKEND };
  afterEach(() => {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.backend === undefined) delete process.env.WRITER_BACKEND;
    else process.env.WRITER_BACKEND = saved.backend;
  });
  it("is Claude Code unless a Claude API key is given", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.WRITER_BACKEND;
    expect(writerBackend()).toBe("claude-code");
    process.env.ANTHROPIC_API_KEY = ["sk", "ant", "test"].join("-");
    expect(writerBackend()).toBe("api");
  });
  it("can be pinned to Claude Code even with a key", () => {
    process.env.ANTHROPIC_API_KEY = ["sk", "ant", "test"].join("-");
    process.env.WRITER_BACKEND = "claude-code";
    expect(writerBackend()).toBe("claude-code");
  });
  it("prices an API call from its token counts", () => {
    expect(apiCostUsd({ input_tokens: 1_000_000 })).toBeCloseTo(3, 5);
    expect(apiCostUsd({ cache_read_input_tokens: 1_000_000, output_tokens: 100_000 })).toBeCloseTo(0.3 + 1.5, 5);
    expect(apiCostUsd({})).toBe(0);
  });
});

describe("the Claude API call", () => {
  it("sends the system prompt cached, reads the text back, and records the usage", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "{\"verdict\":\"ready\"}" }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = fake as typeof fetch;
    process.env.ANTHROPIC_API_KEY = ["sk", "ant", "test"].join("-");
    process.env.WRITER_BACKEND = "api";
    try {
      const { askWriter, writerUsage } = await import("../src/answers/resolve.js");
      const before = writerUsage.calls;
      const text = await askWriter("hello", "Reply as JSON.");
      expect(text).toBe("{\"verdict\":\"ready\"}");
      expect(seen).toHaveLength(1);
      const headers = seen[0]?.init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe(process.env.ANTHROPIC_API_KEY);
      expect(headers["anthropic-version"]).toBeTruthy();
      const body = JSON.parse(String(seen[0]?.init.body)) as { system: { text: string; cache_control?: { type: string } }[]; messages: { role: string; content: string }[]; max_tokens: number };
      expect(body.system[0]?.text).toBe("Reply as JSON.");
      expect(body.system[0]?.cache_control?.type).toBe("ephemeral");
      expect(body.messages[0]).toEqual({ role: "user", content: "hello" });
      expect(writerUsage.calls).toBe(before + 1);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.WRITER_BACKEND;
    }
  });
  it("explains a refusal without the key", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 })) as typeof fetch;
    process.env.ANTHROPIC_API_KEY = ["sk", "ant", "test"].join("-");
    process.env.WRITER_BACKEND = "api";
    try {
      const { askWriter } = await import("../src/answers/resolve.js");
      await expect(askWriter("hello", "x")).rejects.toThrow(/401: invalid x-api-key/);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.WRITER_BACKEND;
    }
  });
});
