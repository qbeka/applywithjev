import { describe, expect, it } from "vitest";
import { dateFormatOf, isoOf, monthOfHeading, shapedForBox, showsDate, showsValue, toYmd } from "../src/util/dates.js";

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

describe("shapedForBox", () => {
  it("writes a month in the format the box names", () => {
    expect(shapedForBox("May 2027", "MM/DD/YYYY")).toBe("05/01/2027");
    expect(shapedForBox("2027-05-03", "Date (dd-mm-yyyy)")).toBe("03-05-2027");
    expect(shapedForBox("2027-05-03", "yyyy/mm/dd")).toBe("2027/05/03");
  });
  it("leaves a value alone when it is not a date or the box names no format", () => {
    expect(shapedForBox("Negotiable", "MM/DD/YYYY")).toBe("Negotiable");
    expect(shapedForBox("May 2027", "Start date")).toBe("May 2027");
    expect(dateFormatOf("mm/mm/yyyy")).toBeNull();
  });
});

describe("showsValue", () => {
  it("accepts the site's own shape of the same value", () => {
    expect(showsValue("7806958600", "(780) 695-8600")).toBe(true);
    expect(showsValue("780-695-8600", "+1 780 695 8600")).toBe(true);
    expect(showsValue("3", "33")).toBe(false);
    expect(showsValue("github.com/someone", "https://github.com/someone/")).toBe(true);
    expect(showsValue("May 2027", "05/01/2027")).toBe(true);
    expect(showsValue("Two  words here", "two words here")).toBe(true);
    expect(showsValue("Edmonton", "Edmonton, AB, Canada")).toBe(true);
    expect(showsValue("Edmonton, Alberta, Canada", "Edmonton, AB, CAN")).toBe(true);
    expect(showsValue("Edmonton, Alberta, Canada", "Calgary, AB, CAN")).toBe(false);
  });
  it("rejects a box that shows something else", () => {
    expect(showsValue("May 2027", "02/27/")).toBe(false);
    expect(showsValue("Edmonton", "")).toBe(false);
    expect(showsValue("2027", "2026")).toBe(false);
  });
});
