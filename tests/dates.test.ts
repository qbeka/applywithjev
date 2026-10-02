import { describe, expect, it } from "vitest";
import { isoOf, monthOfHeading, showsDate, toYmd } from "../src/util/dates.js";

describe("toYmd", () => {
  it("reads the ways a date is written", () => {
    expect(toYmd("2027-05-03")).toEqual({ year: 2027, month: 5, day: 3 });
    expect(toYmd("05/03/2027")).toEqual({ year: 2027, month: 5, day: 3 });
    expect(toYmd("May 3, 2027")).toEqual({ year: 2027, month: 5, day: 3 });
    expect(toYmd("3 May 2027")).toEqual({ year: 2027, month: 5, day: 3 });
    expect(toYmd("Sept. 1st, 2027")).toEqual({ year: 2027, month: 9, day: 1 });
  });
  it("takes a bare month as its first day", () => {
    expect(toYmd("May 2027")).toEqual({ year: 2027, month: 5, day: 1 });
    expect(toYmd("2027-05")).toEqual({ year: 2027, month: 5, day: 1 });
    expect(isoOf({ year: 2027, month: 5, day: 1 })).toBe("2027-05-01");
  });
  it("refuses what is not a date", () => {
    expect(toYmd("Available whenever needed")).toBeNull();
    expect(toYmd("February 30, 2027")).toBeNull();
    expect(toYmd("Maybe 2027")).toBeNull();
    expect(toYmd("")).toBeNull();
  });
});

describe("a calendar's heading", () => {
  it("names a month and a year", () => {
    expect(monthOfHeading("October 2026")).toEqual({ year: 2026, month: 10 });
    expect(monthOfHeading("Oct 2026")).toEqual({ year: 2026, month: 10 });
    expect(monthOfHeading("2027 May")).toEqual({ year: 2027, month: 5 });
    expect(monthOfHeading("Pick a date")).toBeNull();
  });
});

describe("showsDate", () => {
  const d = { year: 2027, month: 5, day: 1 };
  it("accepts the date however the box writes it", () => {
    expect(showsDate("May 1, 2027", d)).toBe(true);
    expect(showsDate("2027-05-01", d)).toBe(true);
    expect(showsDate("05/01/2027", d)).toBe(true);
    expect(showsDate("01.05.2027", d)).toBe(true);
    expect(showsDate("Sat, 1 May 2027", d)).toBe(true);
  });
  it("rejects another day, another month, and an empty box", () => {
    expect(showsDate("May 2, 2027", d)).toBe(false);
    expect(showsDate("June 1, 2027", d)).toBe(false);
    expect(showsDate("05/02/2027", d)).toBe(false);
    expect(showsDate("", d)).toBe(false);
  });
});
