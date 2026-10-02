/**
 * Pacing. Job boards answer a burst from one person with errors or a human
 * check, so work is spread out per site: a few forms at once, a pause between
 * two starts at the same site, and one submission at a time.
 */
import { RUN } from "../config.js";
import { hostIs } from "../jobs/normalize.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** At most n pieces of work at once, started in the order they were asked for. */
export function limiter(n: number): <T>(work: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (work) => {
    if (active >= n) await new Promise<void>((go) => waiting.push(go));
    active++;
    try {
      return await work();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** One piece of work at a time per key, with a pause after each before the next for the same key starts. Other keys are not held up. */
export function spacer(gapMs: number | ((key: string) => number)): <T>(key: string, work: () => Promise<T>) => Promise<T> {
  const turns = new Map<string, Promise<unknown>>();
  const gap = (key: string) => (typeof gapMs === "number" ? gapMs : gapMs(key));
  return (key, work) => {
    const run = (turns.get(key) ?? Promise.resolve()).then(work);
    turns.set(key, run.then(() => sleep(gap(key)), () => sleep(gap(key))));
    return run;
  };
}

/** Runs work over items side by side, holding each site to RUN.perHostConcurrency at once and RUN.hostGapMs between starts. */
export async function paced<T, R>(items: T[], host: (item: T) => string, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const todo = items.map((item, index) => ({ item, index }));
  const sites = new Map<string, { active: number; last: number }>();
  const worker = async () => {
    while (todo.length) {
      const now = Date.now();
      const at = todo.findIndex(({ item }) => {
        const s = sites.get(host(item));
        const gentle = RUN.gentleHosts.some((h) => hostIs(host(item), h));
        return !s || (s.active < (gentle ? 1 : RUN.perHostConcurrency) && now - s.last >= (gentle ? RUN.gentleGapMs : RUN.hostGapMs));
      });
      if (at < 0) {
        await sleep(200);
        continue;
      }
      const [{ item, index }] = todo.splice(at, 1) as [{ item: T; index: number }];
      const site = sites.get(host(item)) ?? { active: 0, last: 0 };
      sites.set(host(item), { active: site.active + 1, last: Date.now() });
      try {
        results[index] = await work(item);
      } finally {
        const s = sites.get(host(item)) as { active: number; last: number };
        s.active--;
        // The pause counts from when a form finishes, not from when it started.
        s.last = Date.now();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RUN.fillConcurrency, items.length) }, worker));
  return results;
}
