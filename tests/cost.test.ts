import { describe, expect, it } from "vitest";
import { formatCost, summarizeCost, type JevLine, type WriterLine } from "../src/log/cost.js";

const jev: JevLine[] = [
  { at: "2026-10-02T10:00:00Z", label: "rate:Acme:SWE Intern", input_tokens: 3000, output_tokens: 300, cost: 0.0002 },
  { at: "2026-10-02T11:00:00Z", label: "map-form:aaaa000000000001:Acme", input_tokens: 20000, output_tokens: 5000, cost: 0.001 },
  { at: "2026-10-02T11:00:05Z", label: "map-form:aaaa000000000001:Acme", input_tokens: 4000, output_tokens: 90, cost: 0.0002 },
  { at: "2026-10-02T11:01:00Z", label: "page-state:aaaa000000000001", input_tokens: 900, output_tokens: 80, cost: 0.00005 },
  { at: "2026-10-02T11:02:00Z", label: "map-form:aaaa000000000002:Beta", input_tokens: 18000, output_tokens: 4000, cost: 0.0009 },
];
const writer: WriterLine[] = [
  { at: "2026-10-02T11:00:30Z", purpose: "resolve", jobId: "aaaa000000000001", inputTokens: 900, cacheWriteTokens: 7000, cacheReadTokens: 0, outputTokens: 600, costUsd: 0.05 },
  { at: "2026-10-02T11:01:10Z", purpose: "log", jobId: "aaaa000000000001", inputTokens: 1500, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 80, costUsd: 0.01 },
];

describe("summarizeCost", () => {
  it("splits JEV and Claude by purpose and keeps discovery apart from the forms", () => {
    const c = summarizeCost(jev, writer);
    expect(c.jev.rate).toMatchObject({ calls: 1, costUsd: 0.0002 });
    expect(c.jev["map-form"]).toMatchObject({ calls: 3, inputTokens: 42000 });
    expect(c.claude.resolve).toMatchObject({ calls: 1, inputTokens: 7900, outputTokens: 600 });
    expect(c.forms).toBe(2);
    expect(c.discoveryUsd).toBeCloseTo(0.0002);
    expect(c.perForm.jevUsd).toBeCloseTo((0.001 + 0.0002 + 0.00005 + 0.0009) / 2);
    expect(c.perForm.claudeUsd).toBeCloseTo(0.03);
    expect(c.totalUsd).toBeCloseTo(0.0002 + 0.00215 + 0.06);
  });
  it("counts only calls at or after a given time", () => {
    const c = summarizeCost(jev, writer, "2026-10-02T11:01:30Z");
    expect(c.forms).toBe(1);
    expect(c.jev.rate).toBeUndefined();
    expect(c.claude.resolve).toBeUndefined();
  });
  it("prints a per-form and a per-ten figure, with Claude priced only when the Claude API is used", () => {
    process.env.WRITER_BACKEND = "api";
    expect(formatCost(summarizeCost(jev, writer))).toMatch(/Per 10 forms: JEV \$0\.0\d+ \+ Claude \$0\.3000 = \$0\.3\d+/);
    expect(formatCost(summarizeCost([], []))).toContain("no calls recorded");
    process.env.WRITER_BACKEND = "claude-code";
    const text = formatCost(summarizeCost(jev, writer));
    expect(text).toContain("on your subscription, no separate bill");
    expect(text).not.toContain("+ Claude");
    expect(text).toContain("Total billed (JEV)");
    delete process.env.WRITER_BACKEND;
  });
});
