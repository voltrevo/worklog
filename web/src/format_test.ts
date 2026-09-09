/**
 * Formatting, and the one piece of it that is not cosmetic.
 *
 * `instantAt` turns a wall-clock time typed into a form into an instant, which is the same rule as
 * 2.19 read backwards: what somebody types means what it means where they are standing. Getting it
 * wrong moves an entry by hours, and moves it silently.
 */

/// <reference lib="dom" />

import { assertEquals } from "jsr:@std/assert@^1";
import { instantAt, parseNumber, timeValue } from "./format.ts";
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
