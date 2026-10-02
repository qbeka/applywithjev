import { describe, expect, it } from "vitest";
import { checkKey, checkNode, checkProfile, checkResume, formatChecks, isReadyToRun, nextStep, type Check } from "../src/doctor.js";

const ok = (name: string): Check => ({ name, ok: true, detail: "fine", fix: "" });
const bad = (name: string, fix: string, optional = false): Check => ({ name, ok: false, detail: "missing", fix, optional });

describe("doctor", () => {
  it("accepts Node 22 and newer", () => {
    expect(checkNode("22.16.0").ok).toBe(true);
    expect(checkNode("20.11.1").ok).toBe(false);
  });
  it("wants a key, and never prints it", () => {
    expect(checkKey("").ok).toBe(false);
    const c = checkKey("sk-or-v1-abcdefghijklmnopqrstuvwxyz");
    expect(c.ok).toBe(true);
    expect(JSON.stringify(c)).not.toContain("abcdefghij");
    expect(checkKey("").fix).toMatch(/Do not paste the key into a chat/);
  });
  it("reads the example profile and names a missing one", () => {
    const { check, profile } = checkProfile(new URL("../data/profile.example.json", import.meta.url).pathname);
    expect(check.ok).toBe(true);
    expect(profile?.name.first).toBeTruthy();
    expect(checkProfile("/nowhere/profile.json").check).toMatchObject({ ok: false });
    expect(checkResume(null).ok).toBe(false);
  });
  it("names the first thing that blocks a run before anything optional", () => {
    const checks = [ok("Node.js"), bad("Your drafts", "write drafts", true), bad("OpenRouter key", "add the key"), bad("Your profile", "run setup")];
    expect(nextStep(checks)).toBe("add the key");
    expect(isReadyToRun(checks)).toBe(false);
    expect(formatChecks(checks)).toContain("Next step: add the key");
  });
  it("is ready when only optional things are missing, and still suggests them", () => {
    const checks = [ok("Node.js"), bad("Job queue", "run discover", true)];
    expect(isReadyToRun(checks)).toBe(true);
    expect(nextStep(checks)).toBe("run discover");
    expect(nextStep([ok("Node.js")])).toMatch(/Everything is in place/);
  });
});
