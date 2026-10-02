import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPrompt, parseResolution, type OpenField } from "../src/answers/resolve.js";
import { ProfileSchema } from "../src/profile/schema.js";

const profile = ProfileSchema.parse(JSON.parse(readFileSync(new URL("../data/profile.example.json", import.meta.url), "utf8")));
const open: OpenField[] = [{ selector: "#q1", kind: "textarea", label: "Why Acme?", hint: "", required: true, maxLength: 500, options: [], why: "needs writing (why_company)" }];

describe("parseResolution", () => {
  it("reads a bare object and one wrapped in a code fence", () => {
    const body = '{"verdict":"ready","reason":"","answers":[{"selector":"#q1","value":"Because."}]}';
    expect(parseResolution(body).answers[0]).toEqual({ selector: "#q1", value: "Because." });
    expect(parseResolution("```json\n" + body + "\n```").verdict).toBe("ready");
  });
  it("defaults the optional parts and rejects anything that is not a verdict", () => {
    expect(parseResolution('{"verdict":"skip"}')).toEqual({ verdict: "skip", reason: "", answers: [] });
    expect(() => parseResolution('{"verdict":"maybe"}')).toThrow();
    expect(() => parseResolution("I could not decide.")).toThrow(/JSON/);
  });
});

describe("buildPrompt", () => {
  const prompt = JSON.parse(buildPrompt(profile, null, [{ label: "Email", value: "ada@example.com" }], open)) as Record<string, any>;
  it("hands the writer the facts, the standing answers, what is filled and what is open", () => {
    expect(prompt.candidate.facts).toEqual(profile.facts);
    expect(prompt.candidate.standingAnswers).toEqual(profile.answers);
    expect(prompt.candidate.workAuthorization.authorizedCountries).toEqual(["Canada"]);
    expect(prompt.already_filled).toEqual([{ label: "Email", value: "ada@example.com" }]);
    expect(prompt.open_fields[0]).toMatchObject({ selector: "#q1", required: true, maxLength: 500 });
    expect(Object.keys(prompt.bank)).toContain("why_company");
  });
  it("carries no secret and no resume path", () => {
    const text = JSON.stringify(prompt);
    expect(text).not.toMatch(/sk-or-v1-|OPENROUTER/);
    expect(text).not.toContain(profile.resume.path);
  });
});
