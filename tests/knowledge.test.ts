import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { askingForCodeToday, Knowledge, learn, loadKnowledge, mergeKnowledge, notesFor, sanitize, shareKnowledge, signatureOf, signInHosts, SiteNotes, withLesson } from "../src/knowledge/sites.js";

const empty = () => SiteNotes.parse({});
const files = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "awj-know-"));
  return { shipped: path.join(dir, "sites.json"), local: path.join(dir, "knowledge.json") };
};

describe("a control's signature", () => {
  it("is its kind, and the widget that draws it when known", () => {
    expect(signatureOf({ kind: "tel", widget: "intl-tel" })).toBe("tel:intl-tel");
    expect(signatureOf({ kind: "text", widget: "" })).toBe("text");
    expect(signatureOf({ kind: "combobox" })).toBe("combobox");
  });
});

describe("what one form teaches", () => {
  it("records the way each kind of control took its value, and counts how often that held", () => {
    let n = withLesson(empty(), { landed: { "tel:intl-tel": "typed", text: "script" } }, "2026-10-02");
    n = withLesson(n, { landed: { "tel:intl-tel": "typed" } }, "2026-10-03");
    expect(n.controls).toEqual({ "tel:intl-tel": { method: "typed", worked: 2 }, text: { method: "script", worked: 1 } });
    expect(n.updated).toBe("2026-10-03");
  });
  it("starts the count again when another way worked", () => {
    const n = withLesson(withLesson(empty(), { landed: { text: "script" } }, "d"), { landed: { text: "typed" } }, "d");
    expect(n.controls.text).toEqual({ method: "typed", worked: 1 });
  });
  it("keeps what could not be set as trouble, until the day it is set", () => {
    let n = withLesson(empty(), { trouble: { "combobox:datalist": 'no option matches "Edmonton, Alberta, Canada"' } }, "d");
    n = withLesson(n, { trouble: { "combobox:datalist": "no option matches" } }, "d");
    expect(n.trouble["combobox:datalist"]).toEqual({ why: "no option matches", count: 2 });
    n = withLesson(n, { landed: { "combobox:datalist": "clicked" } }, "d");
    expect(n.trouble).toEqual({});
  });
  it("notes a sign-in, the pages of a form, an emailed code, and how forms ended", () => {
    let n = withLesson(empty(), { pages: 3, form: { ready: false } }, "d");
    n = withLesson(n, { pages: 1, form: { ready: true }, emailsCode: true }, "d");
    n = withLesson(n, { signIn: true }, "d");
    expect(n).toMatchObject({ pages: 3, forms: 2, ready: 1, emailsCode: true, signIn: true });
  });
});

describe("a site that asks for an emailed code", () => {
  it("is left alone for the rest of that day, and tried again the next", () => {
    const k = Knowledge.parse({ sites: { "job-boards.greenhouse.io": withLesson(empty(), { emailsCode: true }, "2026-10-02"), "jobs.lever.co": withLesson(empty(), { form: { ready: true } }, "2026-10-02") } });
    expect(askingForCodeToday(k, "2026-10-02")).toEqual(["greenhouse.io"]);
    expect(askingForCodeToday(k, "2026-10-03")).toEqual([]);
    expect(k.sites["job-boards.greenhouse.io"]?.emailsCode).toBe(true);
  });
});

describe("nothing of the person's goes into the notes", () => {
  it("takes quoted values, addresses and long numbers out of a reason", () => {
    expect(sanitize('no option matches "Edmonton, Alberta, Canada" among: "A" | "B"')).toBe("no option matches a value among: a value | a value");
    expect(sanitize("could not set someone@example.com or 7805551234")).toBe("could not set an address or a number");
    expect(sanitize("x".repeat(500)).length).toBe(120);
  });
});

describe("the two files", () => {
  it("are read as one, this machine's notes winning where both know a control", () => {
    const shipped = Knowledge.parse({ sites: { "a.example.com": { controls: { tel: { method: "script", worked: 4 } }, forms: 4, ready: 4, trouble: { calendar: { why: "did not open", count: 2 } } } } });
    const local = Knowledge.parse({ sites: { "a.example.com": { controls: { tel: { method: "typed", worked: 1 }, calendar: { method: "calendar", worked: 1 } }, forms: 1, signIn: false }, "b.example.com": { signIn: true } } });
    const k = mergeKnowledge(shipped, local);
    expect(k.sites["a.example.com"]).toMatchObject({ controls: { tel: { method: "typed" }, calendar: { method: "calendar" } }, forms: 5, ready: 4, trouble: {} });
    expect(signInHosts(k)).toEqual(["b.example.com"]);
    expect(notesFor("https://a.example.com/apply/1", k).controls.tel?.method).toBe("typed");
    expect(notesFor("https://unknown.example.com/", k).controls).toEqual({});
  });
  it("learns into this machine's file, and shares into the shipped one without counting anything twice", () => {
    const { shipped, local } = files();
    writeFileSync(shipped, JSON.stringify({ version: 1, sites: { "z.example.com": { forms: 2, ready: 2 } } }));
    learn("https://a.example.com/jobs/1", { landed: { text: "script" }, form: { ready: true } }, local);
    learn("https://a.example.com/jobs/2", { landed: { text: "script" }, form: { ready: false } }, local);
    expect(loadKnowledge(shipped, local).sites["a.example.com"]).toMatchObject({ forms: 2, ready: 1, controls: { text: { method: "script", worked: 2 } } });
    expect(shareKnowledge(shipped, local)).toBe(2);
    expect(Object.keys(JSON.parse(readFileSync(shipped, "utf8")).sites)).toEqual(["a.example.com", "z.example.com"]);
    expect(loadKnowledge(shipped, local).sites["a.example.com"]?.forms).toBe(2);
  });
  it("reads a missing or damaged file as knowing nothing", () => {
    const { shipped, local } = files();
    writeFileSync(local, "{ not json");
    expect(loadKnowledge(shipped, local)).toEqual({ version: 1, sites: {} });
  });
});
