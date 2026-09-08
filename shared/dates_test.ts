import { assertEquals } from "jsr:@std/assert@^1";
import {
  addDays,
  compare,
  datesInMonth,
  inMonth,
  minutesOf,
  monthBefore,
  monthOf,
  shiftMonth,
  weekdayOf,
  weeksThenMonday,
} from "./dates.ts";

Deno.test("monthOf takes the prefix, with no timezone in sight", () => {
  assertEquals(monthOf("2026-09-08"), "2026-09");
  assertEquals(monthOf("2026-01-01"), "2026-01");
  assertEquals(monthOf("2026-12-31"), "2026-12");
});

Deno.test("weekdayOf counts Monday as 1", () => {
  assertEquals(weekdayOf("2026-09-07"), 1); // Monday
  assertEquals(weekdayOf("2026-09-08"), 2);
  assertEquals(weekdayOf("2026-09-12"), 6); // Saturday
  assertEquals(weekdayOf("2026-09-13"), 7); // Sunday
});

Deno.test("datesInMonth covers the month and stops", () => {
  assertEquals(datesInMonth("2026-09").length, 30);
  assertEquals(datesInMonth("2026-02").length, 28);
  assertEquals(datesInMonth("2028-02").length, 29, "leap year");
  assertEquals(datesInMonth("2026-09")[0], "2026-09-01");
  assertEquals(datesInMonth("2026-09").at(-1), "2026-09-30");
});

Deno.test("addDays crosses month and year boundaries", () => {
  assertEquals(addDays("2026-09-30", 1), "2026-10-01");
  assertEquals(addDays("2026-12-31", 1), "2027-01-01");
  assertEquals(addDays("2026-01-01", -1), "2025-12-31");
});

Deno.test("shiftMonth wraps the year", () => {
  assertEquals(shiftMonth("2026-12", 1), "2027-01");
  assertEquals(shiftMonth("2026-01", -1), "2025-12");
  assertEquals(shiftMonth("2026-09", 0), "2026-09");
});

Deno.test("ordering is lexicographic because the format makes it so", () => {
  assertEquals(compare("2026-09-08", "2026-09-09"), -1);
  assertEquals(compare("2026-09-09", "2026-09-08"), 1);
  assertEquals(compare("2026-09-08", "2026-09-08"), 0);
  assertEquals(monthBefore("2026-08", "2026-09"), true);
  assertEquals(monthBefore("2026-09", "2026-09"), false);
  assertEquals(monthBefore("2027-01", "2026-12"), false);
});

Deno.test("inMonth", () => {
  assertEquals(inMonth("2026-09-30", "2026-09"), true);
  assertEquals(inMonth("2026-10-01", "2026-09"), false);
});

Deno.test("minutesOf", () => {
  assertEquals(minutesOf("00:00"), 0);
  assertEquals(minutesOf("09:30"), 570);
  assertEquals(minutesOf("17:00"), 1020);
  assertEquals(minutesOf("23:59"), 1439);
});

Deno.test("the due-date rule: four weeks, then Monday unless already Monday", () => {
  // 10.3 -- a Monday plus four weeks is a Monday, and is left alone.
  assertEquals(weekdayOf("2026-09-07"), 1);
  assertEquals(weeksThenMonday("2026-09-07", 4), "2026-10-05");
  assertEquals(weekdayOf("2026-10-05"), 1);

  // 10.4 -- every other weekday rolls forward to the next Monday, never back.
  assertEquals(weeksThenMonday("2026-09-08", 4), "2026-10-12"); // Tue -> Tue+4w=Mon+7
  assertEquals(weeksThenMonday("2026-09-13", 4), "2026-10-12"); // Sun -> next Mon
  assertEquals(weeksThenMonday("2026-09-12", 4), "2026-10-12"); // Sat -> next Mon
});

Deno.test("the due date is always four weeks out or more, never less", () => {
  // The rule only ever moves the date forward, which is the property that matters: a due date
  // should not quietly become sooner than the four weeks the terms promise.
  for (const d of datesInMonth("2026-09")) {
    const due = weeksThenMonday(d, 4);
    const bare = addDays(d, 28);
    assertEquals(due >= bare, true, `${d}: ${due} came before ${bare}`);
    assertEquals(weekdayOf(due), 1, `${d}: ${due} is not a Monday`);
    // ...and never more than six days more, or it has skipped a Monday.
    assertEquals(due <= addDays(bare, 6), true, `${d}: ${due} skipped a Monday`);
  }
});
