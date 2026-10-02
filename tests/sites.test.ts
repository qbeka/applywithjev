import { describe, expect, it } from "vitest";
import { addSite, hostOf, isConnected, signInState, sitesNeedingSignIn, type Seen } from "../src/browser/sites.js";
import { isWalled } from "../src/jobs/walled.js";

const looks = (...boxes: boolean[]): Seen[] => boxes.map((hasPassword, i) => ({ at: i * 1000, hasPassword }));

describe("whether a sign-in is over", () => {
  it("says nothing while no sign-in page has been shown", () => {
    expect(signInState(looks(false, false, false), 4000)).toBe("no_sign_in_seen");
  });
  it("waits while the password box is on the page, and for a moment after it goes", () => {
    expect(signInState(looks(false, true, true), 4000)).toBe("waiting");
    expect(signInState(looks(true, true, false, false), 4000)).toBe("waiting");
  });
  it("is over once no password box has been there for the quiet time", () => {
    expect(signInState(looks(true, true, false, false, false, false, false), 4000)).toBe("signed_in");
  });
  it("starts waiting again when a second step asks for a password", () => {
    expect(signInState(looks(true, false, false, false, false, false, true), 4000)).toBe("waiting");
  });
});

describe("connected sites", () => {
  it("keeps one entry per host and the date of the first sign-in", () => {
    const once = addSite([], "https://www.Tesla.com/careers/search/job/1", "2026-10-02T00:00:00Z");
    const twice = addSite(once, "https://www.tesla.com/careers/other", "2026-10-09T00:00:00Z");
    expect(twice).toEqual([{ host: "www.tesla.com", url: "https://www.tesla.com/careers/other", connectedAt: "2026-10-02T00:00:00Z", checkedAt: "2026-10-09T00:00:00Z" }]);
    expect(isConnected("https://www.tesla.com/careers/search/job/285202", twice)).toBe(true);
    expect(isConnected("https://shop.tesla.com/x", twice)).toBe(false);
    expect(hostOf("jobs.example.com/apply")).toBe("jobs.example.com");
  });
  it("makes a site the person signed in to no longer walled", () => {
    expect(isWalled("https://jobs.ea.com/en_US/careers/1", [])).toBe(true);
    expect(isWalled("https://jobs.ea.com/en_US/careers/1", [], ["jobs.ea.com"])).toBe(false);
    expect(isWalled("https://careers.example.com/1", ["careers.example.com"], [])).toBe(true);
    expect(isWalled("https://careers.example.com/1", ["careers.example.com"], ["careers.example.com"])).toBe(false);
  });
  it("lists the sites whose jobs wait on a sign-in, most jobs first, without the connected ones", () => {
    const e = (url: string, company: string, status: string, statusReason: string | null) => ({ status, statusReason, job: { url, company } });
    const entries = [
      e("https://a.example.com/job/1", "Alpha", "skipped", "careers site needs an account"),
      e("https://b.example.com/job/1", "Beta", "skipped", "careers site needs an account"),
      e("https://b.example.com/job/2", "Beta", "blocked", "login or account required. To sign in yourself, run: connect https://b.example.com/login"),
      e("https://c.example.com/job/1", "Gamma", "skipped", "workday (needs an account per company)"),
      e("https://d.example.com/job/1", "Delta", "applied", null),
      e("https://e.example.com/job/1", "Epsilon", "skipped", "careers site needs an account"),
    ];
    const connected = [{ host: "e.example.com", url: "https://e.example.com", connectedAt: "", checkedAt: "" }];
    expect(sitesNeedingSignIn(entries, connected)).toEqual([
      { host: "b.example.com", url: "https://b.example.com/job/1", companies: ["Beta"], jobs: 2 },
      { host: "a.example.com", url: "https://a.example.com/job/1", companies: ["Alpha"], jobs: 1 },
    ]);
  });
});
