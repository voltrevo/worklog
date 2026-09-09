/**
 * Formatting, and the one piece of it that is not cosmetic.
 *
 * `instantAt` turns a wall-clock time typed into a form into an instant, which is the same rule as
 * 2.19 read backwards: what somebody types means what it means where they are standing. Getting it
 * wrong moves an entry by hours, and moves it silently.
 */

/// <reference lib="dom" />

import { assertEquals } from "jsr:@std/assert@^1";
import { clock, duration, instantAt, pace, parseNumber, timeValue } from "./format.ts";
Deno.test("24.11 -- a wall-clock time on a date becomes an instant on this device's clock", () => {
  const at = instantAt("2026-09-08", "09:30");
  assertEquals(at !== undefined, true);
  // Round trip: whatever zone the test runs in, reading it back gives the time that was typed.
  assertEquals(timeValue(at!), "09:30");
});

Deno.test("a malformed time is undefined, not an Invalid Date", () => {
  // `new Date("2026-09-08Tnonsense")` is NaN, and NaN reaching the server as a timestamp is how a
  // NOT NULL column ends up being the thing that reports a typo.
  for (const bad of ["", "9:30", "0930", "nonsense", "25:00:00"]) {
    assertEquals(instantAt("2026-09-08", bad), undefined, bad);
  }
});

Deno.test("midnight and the last minute of the day both round trip", () => {
  assertEquals(timeValue(instantAt("2026-09-08", "00:00")!), "00:00");
  assertEquals(timeValue(instantAt("2026-09-08", "23:59")!), "23:59");
});

Deno.test("parseNumber accepts what a person types and nothing else", () => {
  assertEquals(parseNumber("120"), 120);
  assertEquals(parseNumber("120.50"), 120.5);
  assertEquals(parseNumber("-3"), -3);
  // Pasted from a spreadsheet.
  assertEquals(parseNumber("  120  "), 120);
});

Deno.test("parseNumber refuses what Number would have taken", () => {
  // Every one of these is a number to `Number()`, and none of them is one to a person filling in
  // an hourly rate. The old code stored `NaN || 0` for the first two and a real value for the rest.
  assertEquals(parseNumber("abc"), undefined);
  assertEquals(parseNumber("12abc"), undefined);
  assertEquals(parseNumber("0x10"), undefined);
  assertEquals(parseNumber("1e3"), undefined);
  assertEquals(parseNumber("Infinity"), undefined);
  assertEquals(parseNumber("12,50"), undefined);
});

Deno.test("parseNumber treats empty as absent rather than zero", () => {
  // `Number("")` is 0, which is how a cleared rate box became a rate of nothing.
  assertEquals(parseNumber(""), undefined);
  assertEquals(parseNumber("   "), undefined);
  assertEquals(parseNumber("."), undefined);
});

Deno.test("25.6 -- a duration is hours to one decimal place", () => {
  assertEquals(duration(0), "0.0h");
  assertEquals(duration(14 * 60_000), "0.2h");
  assertEquals(duration(3 * 3_600_000 + 14 * 60_000), "3.2h");
  assertEquals(duration(40 * 3_600_000), "40.0h");
  // Half-to-even, same rule as the invoice — the point of 25.6 is that these agree.
  assertEquals(duration(15 * 60_000), "0.2h");
  assertEquals(duration(21 * 60_000), "0.4h");
});

Deno.test("but the running clock still counts seconds", () => {
  // 25.6 exempts it explicitly. A figure that flicks between 2.5 and 2.6 while you watch is not a
  // clock, and the seconds are the reason to look at this one at all.
  assertEquals(clock(87_000), "1:27");
  assertEquals(clock(3600_000 + 27 * 60_000 + 16_000), "1:27:16");
});

Deno.test("pace rounds before it decides whether you are on target", () => {
  // A minute either way is 0.0h, and "0.0h ahead" is a sentence with no content that reads as a
  // bug. Rounding first is what makes the two agree.
  assertEquals(pace(1 / 60).text, "exactly on target");
  assertEquals(pace(-1 / 60).text, "exactly on target");
  assertEquals(pace(0).tone, "flat");
  assertEquals(pace(4).text, "4.0h ahead");
  assertEquals(pace(4).tone, "good");
  assertEquals(pace(-2.5).text, "2.5h behind");
  assertEquals(pace(-2.5).tone, "bad");
});
