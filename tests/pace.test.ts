import { describe, expect, it, vi } from "vitest";
import { limiter, paced, spacer } from "../src/util/pace.js";

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("limiter", () => {
  it("never runs more than n pieces of work at once, and runs them all", async () => {
    const limit = limiter(2);
    let active = 0;
    let most = 0;
    const done: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        limit(async () => {
          active++;
          most = Math.max(most, active);
          await tick(5);
          active--;
          done.push(n);
        }),
      ),
    );
    expect(most).toBe(2);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
  });
  it("keeps going after a piece of work fails", async () => {
    const limit = limiter(1);
    await expect(limit(async () => Promise.reject(new Error("no")))).rejects.toThrow("no");
    expect(await limit(async () => "ok")).toBe("ok");
  });
});

describe("spacer", () => {
  it("leaves a pause between two pieces of work for the same site, and none between different sites", async () => {
    vi.useFakeTimers();
    const spaced = spacer(1000);
    const started: string[] = [];
    const work = (name: string) => async () => {
      started.push(name);
    };
    const all = Promise.all([spaced("a.com", work("a1")), spaced("a.com", work("a2")), spaced("b.com", work("b1"))]);
    await vi.advanceTimersByTimeAsync(10);
    expect(started.sort()).toEqual(["a1", "b1"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toContain("a2");
    await all;
    vi.useRealTimers();
  });
  it("still lets the next one run when the one before it failed", async () => {
    const spaced = spacer(1);
    await expect(spaced("a.com", async () => Promise.reject(new Error("no")))).rejects.toThrow("no");
    expect(await spaced("a.com", async () => "ok")).toBe("ok");
  });
});

describe("paced", () => {
  it("returns results in the order of the items, whatever order they finish in", async () => {
    const out = await paced([30, 5, 15], (n) => `site-${n}.example`, async (n) => {
      await tick(n);
      return n * 2;
    });
    expect(out).toEqual([60, 10, 30]);
  });
});
