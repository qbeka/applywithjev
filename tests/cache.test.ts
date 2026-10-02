import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ratingKey } from "../src/jobs/rate.js";
import type { Job } from "../src/jobs/normalize.js";
import { ProfileSchema } from "../src/profile/schema.js";
import { hashOf, KeyedCache } from "../src/util/cache.js";
import { readFileSync } from "node:fs";

const file = () => path.join(mkdtempSync(path.join(os.tmpdir(), "awj-cache-")), "c.json");

describe("KeyedCache", () => {
  it("gives back what was stored, across instances, and counts the hits", () => {
    const f = file();
    const a = new KeyedCache<number>(f);
    expect(a.get("k")).toBeUndefined();
    a.set("k", 7);
    a.save();
    const b = new KeyedCache<number>(f);
    expect(b.get("k")).toBe(7);
    expect(b.hits).toBe(1);
  });
  it("drops what a run did not use, so it stays the size of one run", () => {
    const f = file();
    const a = new KeyedCache<number>(f);
    a.set("old", 1);
    a.set("kept", 2);
    a.save();
    const b = new KeyedCache<number>(f);
    b.get("kept");
    b.save();
    expect(new KeyedCache<number>(f).get("old")).toBeUndefined();
    expect(new KeyedCache<number>(f).get("kept")).toBe(2);
  });
  it("keeps everything up to a limit when asked to, newest last", () => {
    const f = file();
    const a = new KeyedCache<number>(f, "all", 2);
    a.set("a", 1);
    a.set("b", 2);
    a.set("c", 3);
    a.save();
    const b = new KeyedCache<number>(f, "all", 2);
    expect([b.get("a"), b.get("b"), b.get("c")]).toEqual([undefined, 2, 3]);
  });
  it("reads a damaged file as empty", () => {
    expect(new KeyedCache<number>("/nowhere/at/all.json").get("x")).toBeUndefined();
  });
});

describe("what a rating depends on", () => {
  const profile = ProfileSchema.parse(JSON.parse(readFileSync(new URL("../data/profile.example.json", import.meta.url), "utf8")));
  const job = (over: Partial<Job> = {}): Job => ({ id: "j", source: "s", company: "Acme", title: "SWE Intern", url: "https://x/1", ats: "greenhouse", locations: ["Toronto, ON"], postedAt: "2026-10-01", terms: [], sponsorship: "unknown", degrees: [], category: null, description: "We build rockets.", ...over }) as Job;
  it("stays the same from one day to the next for an unchanged posting", () => {
    expect(ratingKey(job(), profile)).toBe(ratingKey(job({ postedAt: "2026-09-20" }), profile));
  });
  it("changes when the posting, or the candidate, changes", () => {
    expect(ratingKey(job({ description: "We build boats." }), profile)).not.toBe(ratingKey(job(), profile));
    expect(ratingKey(job(), { ...profile, facts: [...profile.facts, "A new fact."] })).not.toBe(ratingKey(job(), profile));
    expect(hashOf({ a: 1 })).toBe(hashOf({ a: 1 }));
  });
});
