/**
 * Dates as people and forms write them. A profile says "May 2027", a form
 * wants a day picked in a calendar, and the box then shows "May 1, 2027".
 * These helpers turn one into the other and tell whether two are the same day.
 */
export type Ymd = { year: number; month: number; day: number };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** The month a word names: the full name or a short form of it ("Sep", "Sept."). "Maybe" is not May. */
const monthIndex = (word: string) => {
  const w = word.toLowerCase().replace(/\.$/, "");
  return w.length < 3 ? -1 : MONTHS.findIndex((m) => m.startsWith(w));
};

/**
 * A date from the ways a profile or the writer states one: 2027-05-03, 05/03/2027, May 3, 2027,
 * 3 May 2027, and a bare month, May 2027, which is taken as its first day.
 */
export function toYmd(value: string): Ymd | null {
  const v = value.trim();
  let m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(v);
  if (m) return valid({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3] ?? 1) });
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (m) return valid({ year: Number(m[3]), month: Number(m[1]), day: Number(m[2]) });
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(v);
  if (m && monthIndex(m[1] as string) >= 0) return valid({ year: Number(m[3]), month: monthIndex(m[1] as string) + 1, day: Number(m[2]) });
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(v);
  if (m && monthIndex(m[2] as string) >= 0) return valid({ year: Number(m[3]), month: monthIndex(m[2] as string) + 1, day: Number(m[1]) });
  m = /^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(v);
  if (m && monthIndex(m[1] as string) >= 0) return valid({ year: Number(m[2]), month: monthIndex(m[1] as string) + 1, day: 1 });
  return null;
}

function valid(d: Ymd): Ymd | null {
  const made = new Date(Date.UTC(d.year, d.month - 1, d.day));
  return d.year >= 1900 && d.year <= 2100 && made.getUTCMonth() === d.month - 1 && made.getUTCDate() === d.day ? d : null;
}

export const isoOf = (d: Ymd) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

/** The month and year a calendar's heading names: "October 2026", "Oct 2026", "2026 October". */
export function monthOfHeading(heading: string): { year: number; month: number } | null {
  const year = /\b(19|20)\d{2}\b/.exec(heading)?.[0];
  const word = heading.split(/[^A-Za-z]+/).find((w) => w.length >= 3 && monthIndex(w) >= 0);
  return year && word ? { year: Number(year), month: monthIndex(word) + 1 } : null;
}

/** True when what a date box shows is the date that was meant, however the box writes it. */
export function showsDate(shown: string, d: Ymd): boolean {
  const direct = toYmd(shown);
  if (direct) return direct.year === d.year && direct.month === d.month && direct.day === d.day;
  const numbers = (shown.match(/\d+/g) ?? []).map(Number);
  const word = shown.split(/[^A-Za-z]+/).some((w) => w.length >= 3 && monthIndex(w) === d.month - 1);
  return numbers.includes(d.year) && numbers.includes(d.day) && (word || numbers.filter((n) => n === d.month).length >= (d.month === d.day ? 2 : 1));
}
