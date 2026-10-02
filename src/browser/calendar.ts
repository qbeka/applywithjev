/**
 * Calendar date pickers: a box that cannot be typed into, with a pop-up of
 * months and days. Words cannot fill these. The picker is opened with a real
 * click, turned month by month with its own arrows, and the day is clicked.
 * The box is then read back and must show the date that was meant.
 */
import { BROWSER } from "../config.js";
import { sleep, type Page } from "./cdp.js";
import { monthOfHeading, showsDate, toYmd } from "../util/dates.js";
import { inFront, type Point } from "./session.js";

type Calendar = { open: boolean; heading: string; prev: Point; next: Point; days: { day: number; x: number; y: number }[] };

/**
 * Picks a date in the calendar that belongs to a date box. Returns null when the box shows the
 * date afterwards, or why it does not.
 */
export function pickDate(page: Page, selector: string, value: string): Promise<string | null> {
  const want = toYmd(value);
  if (!want) return Promise.resolve(`"${value}" is not a date the calendar can be set to`);
  return inFront(page, async () => {
    const read = () => page.awj<Calendar>("calendar", selector);
    let cal = await read();
    if (!cal.open) {
      const p = await page.awj<Point>("point", selector);
      if (!p.ok) return "control not found";
      await page.click(p.x, p.y);
      cal = await waitFor(read, (c) => c.open);
    }
    if (!cal.open) return "the calendar did not open";
    // Turn the months until the heading names the one that is wanted.
    for (let turns = 0; turns < BROWSER.calendarTurns; turns++) {
      const at = monthOfHeading(cal.heading);
      if (!at) return `could not read the calendar's month from "${cal.heading.slice(0, 40)}"`;
      const away = (want.year - at.year) * 12 + (want.month - at.month);
      if (away === 0) break;
      const arrow = away > 0 ? cal.next : cal.prev;
      if (!arrow.ok) return "the calendar has no arrow to another month";
      const before = cal.heading;
      await page.click(arrow.x, arrow.y);
      cal = await waitFor(read, (c) => c.open && c.heading !== before);
      if (cal.heading === before) return "the calendar did not turn to another month";
    }
    const at = monthOfHeading(cal.heading);
    if (!at || at.year !== want.year || at.month !== want.month) return "the calendar could not be turned to the month";
    const cell = cal.days.find((d) => d.day === want.day);
    if (!cell) return `the calendar does not offer day ${want.day}`;
    await page.click(cell.x, cell.y);
    await sleep(BROWSER.pollMs * 2);
    const shown = await page.awj<string>("shown", selector);
    if (!showsDate(shown, want)) return `the date box shows "${shown}" after the day was clicked`;
    // A picker that stays open after the pick is closed, so it does not cover the next field.
    if ((await read()).open) await page.key("Escape");
    return null;
  });
}

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + BROWSER.optionsMs / 2;
  let v = await read();
  while (!done(v) && Date.now() < deadline) {
    await sleep(BROWSER.pollMs);
    v = await read();
  }
  return v;
}
