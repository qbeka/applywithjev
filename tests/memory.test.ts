import { describe, expect, it } from "vitest";
import { candidatesFor, fits, keyOf, kindClass, MemoryFile, openKey, prune, questionOf, recallExact, recallForm, recallSameFields, recallSimilar, remember, sameQuestion, type OpenField, type Resolution } from "../src/answers/memory.js";
import type { JevClient } from "../src/jev/client.js";

const field = (over: Partial<OpenField> = {}): OpenField => ({ selector: "#q1", kind: "textarea", label: "Which AI tools do you use?", question: "", hint: "", required: true, maxLength: null, options: [], why: "needs writing", ...over });
const empty = () => MemoryFile.parse({});
const FP = "fp1";
const resolved = (answers: Resolution["answers"], verdict: Resolution["verdict"] = "ready"): Resolution => ({ verdict, reason: "", answers });
const jevSaying = (choice: string, confidence: number) => ({ decide: async (_s: unknown, questions: Record<string, unknown>) => Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "choice", choice, confidence, probabilities: {} }])) }) as unknown as JevClient;

describe("how a question is named", () => {
  it("masks the company so one question is the same question everywhere", () => {
    const a = field({ kind: "select", label: "Have you worked at Acme before?", options: ["Yes", "No"] });
    const b = field({ kind: "select", label: "Have you worked at Globex before?", options: ["Yes", "No"] });
    expect(questionOf(a, "Acme")).toBe("Have you worked at {company} before?");
    expect(keyOf(a, "Acme")).toBe(keyOf(b, "Globex"));
    expect(questionOf(field({ label: "Acmeville office?" }), "Acme")).toBe("Acmeville office?");
  });
  it("names a checkbox by its question and its own label", () => {
    expect(questionOf(field({ kind: "checkbox", label: "Python", question: "Which languages do you know?" }), "Acme")).toBe("Which languages do you know? / Python");
  });
  it("keeps text, choices and checkboxes apart", () => {
    expect(kindClass(field())).toBe("text");
    expect(kindClass(field({ kind: "combobox" }))).toBe("choice");
    expect(kindClass(field({ kind: "checkbox" }))).toBe("checkbox");
    expect(keyOf(field({ label: "Pronouns" }), "A")).not.toBe(keyOf(field({ label: "Pronouns", kind: "select", options: ["He/him"] }), "A"));
  });
});

describe("whether a remembered value fits a field", () => {
  it("returns the form's own spelling of an option, and nothing for an option the form does not offer", () => {
    expect(fits("yes", field({ kind: "select", options: ["Yes", "No"] }))).toBe("Yes");
    expect(fits("Maybe", field({ kind: "select", options: ["Yes", "No"] }))).toBeNull();
  });
  it("respects the length of a text box", () => {
    expect(fits("a".repeat(50), field({ maxLength: 40 }))).toBeNull();
    expect(fits("a".repeat(40), field({ maxLength: 40 }))).toBe("a".repeat(40));
  });
});

describe("remember and recall", () => {
  const open = [field(), field({ selector: "#q2", label: "Why Acme?" })];
  const resolution = resolved([
    { selector: "#q1", value: "Claude Code, every day.", reusable: true },
    { selector: "#q2", value: "Acme builds rockets.", reusable: false },
  ]);
  const mem = remember(empty(), { jobId: "job1", company: "Acme", fingerprint: FP, open, resolution, landed: () => true, at: "2026-10-02T00:00:00Z" });

  it("reuses the whole resolution when the same form comes back with the same open fields", () => {
    expect(recallForm(mem, "job1", FP, open)).toEqual(resolution);
    expect(recallForm(mem, "job1", FP, [...open].reverse())).toEqual(resolution);
    expect(recallForm(mem, "job1", FP, [open[0] as OpenField])).toBeNull();
    expect(recallForm(mem, "job2", FP, open)).toBeNull();
  });
  it("reuses the form's own answers field by field when other fields are open this time", () => {
    const extra = field({ selector: "#q3", label: "Do you need an accommodation?", kind: "select", options: ["Yes", "No"] });
    const hits = recallSameFields(mem, "job1", FP, [open[1] as OpenField, extra]);
    expect([...hits.keys()]).toEqual(["#q2"]);
    expect(hits.get("#q2")).toMatchObject({ value: "Acme builds rockets.", reusable: false, source: "same form" });
    expect(recallSameFields(mem, "job1", FP, [{ ...(open[1] as OpenField), label: "Why Acme, in one line?" }]).size).toBe(0);
  });
  it("judges a held form whole again instead of reusing parts of it", () => {
    const held = remember(empty(), { jobId: "job1", company: "Acme", fingerprint: FP, open, resolution: { ...resolution, verdict: "needs_review" }, landed: () => true });
    expect(recallSameFields(held, "job1", FP, [open[0] as OpenField]).size).toBe(0);
    expect(recallForm(held, "job1", FP, open)?.verdict).toBe("needs_review");
  });
  it("forgets everything when the candidate's context changes", () => {
    expect(recallForm(mem, "job1", "fp2", open)).toBeNull();
    expect(recallExact(mem, "fp2", "Globex", open).size).toBe(0);
    expect(prune(mem, "fp2")).toEqual({ version: 1, forms: {}, answers: [] });
  });
  it("keeps for other forms only the answers the writer marked reusable", () => {
    expect(mem.answers.map((a) => a.question)).toEqual(["Which AI tools do you use?"]);
    const hits = recallExact(mem, FP, "Globex", [field({ selector: "#other" }), field({ selector: "#why", label: "Why Globex?" })]);
    expect([...hits.keys()]).toEqual(["#other"]);
    expect(hits.get("#other")).toMatchObject({ value: "Claude Code, every day.", source: "same question", from: "Acme" });
  });
  it("does not keep an answer the page did not show, or one that was itself recalled", () => {
    expect(remember(empty(), { jobId: "j", company: "Acme", fingerprint: FP, open, resolution, landed: () => false }).answers).toEqual([]);
    expect(remember(empty(), { jobId: "j", company: "Acme", fingerprint: FP, open, resolution, landed: () => true, recalled: new Set(["#q1"]) }).answers).toEqual([]);
  });
  it("keeps an unticked box as an answer, since an unticked box shows nothing", () => {
    const box = field({ selector: "#sms", kind: "checkbox", label: "Send me text messages", question: "" });
    const m = remember(empty(), { jobId: "j", company: "Acme", fingerprint: FP, open: [box], resolution: resolved([{ selector: "#sms", value: "false", reusable: true }]), landed: () => false });
    expect(recallExact(m, FP, "Globex", [box]).get("#sms")?.value).toBe("false");
  });
  it("answers a group of checkboxes from memory only when every box in it is remembered", () => {
    const q = "Which languages do you know?";
    const boxes = ["Python", "Java"].map((label, i) => field({ selector: `#b${i}`, kind: "checkbox", label, question: q }));
    const m = remember(empty(), { jobId: "j", company: "Acme", fingerprint: FP, open: boxes, resolution: resolved([{ selector: "#b0", value: "true", reusable: true }, { selector: "#b1", value: "true", reusable: true }]), landed: () => true });
    expect(recallExact(m, FP, "Globex", boxes).size).toBe(2);
    expect(recallExact(m, FP, "Globex", [...boxes, field({ selector: "#b2", kind: "checkbox", label: "Rust", question: q })]).size).toBe(0);
  });
  it("gives each form its own key for its open fields", () => {
    expect(openKey(open)).not.toBe(openKey([field({ required: false }), open[1] as OpenField]));
  });
});

describe("a question worded another way", () => {
  const mem = remember(empty(), { jobId: "job1", company: "Acme", fingerprint: FP, open: [field()], resolution: resolved([{ selector: "#q1", value: "Claude Code, every day.", reusable: true }]), landed: () => true });
  const asked = field({ selector: "#new", label: "What AI tools do you use today, and how?" });

  it("shows JEV only remembered questions of the same kind that the field could take", () => {
    expect(candidatesFor(mem, FP, "Globex", asked).map((c) => c.question)).toEqual(["Which AI tools do you use?"]);
    expect(candidatesFor(mem, FP, "Globex", { ...asked, maxLength: 5 })).toEqual([]);
    expect(candidatesFor(mem, FP, "Globex", { ...asked, kind: "select", options: ["Yes"] })).toEqual([]);
    expect(candidatesFor(mem, FP, "Globex", field({ label: "Describe your favourite hobby" }))).toEqual([]);
  });
  it("asks with a definition for every outcome, including none", () => {
    const q = sameQuestion("What AI tools do you use today, and how?", candidatesFor(mem, FP, "Globex", asked));
    expect(Object.keys(q.criteria)).toEqual(["q0", "none"]);
    expect(q.criteria.none).toMatch(/different country, place, technology/);
  });
  it("reuses the answer only when JEV is confident it is the same question", async () => {
    expect((await recallSimilar(jevSaying("q0", 0.95), mem, FP, "Globex", [asked])).get("#new")).toMatchObject({ value: "Claude Code, every day.", source: "similar question" });
    expect((await recallSimilar(jevSaying("q0", 0.8), mem, FP, "Globex", [asked])).size).toBe(0);
    expect((await recallSimilar(jevSaying("none", 0.99), mem, FP, "Globex", [asked])).size).toBe(0);
  });
  it("never asks JEV about a checkbox, and makes no call when there is nothing to compare", async () => {
    const never = { decide: async () => { throw new Error("JEV must not be called"); } } as unknown as JevClient;
    expect((await recallSimilar(never, mem, FP, "Globex", [field({ kind: "checkbox", label: "Which AI tools do you use?" })])).size).toBe(0);
    expect((await recallSimilar(never, empty(), FP, "Globex", [asked])).size).toBe(0);
  });
});
