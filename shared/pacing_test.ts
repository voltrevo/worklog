import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@^1";
import type { Holiday, PacingOverride, WorkEntry } from "./types.ts";
import { type Calendar, defaultSchedule, emptyCalendar } from "./schedule.ts";
import { project, workedToday } from "./pacing.ts";

const HOUR = 3_600_000;

function entry(date: string, hours: number, billingTag = "Product Development"): WorkEntry {
  return { id: `${date}-${hours}`, date, durationMs: hours * HOUR, billingTag };
}

function calendar(
  holidays: Holiday[] = [],
  overrides: PacingOverride[] = [],
): Calendar {
  return {
    schedule: defaultSchedule(),
    holidays: new Map(holidays.map((h) => [h.date, h])),
    overrides: new Map(overrides.map((o) => [o.date, o])),
  };
}

// September 2026 begins on a Tuesday and has 22 weekdays, so a nine-to-five month is 176 hours.
const SEP = "2026-09";
const SEP_CAPACITY = 176;

// Taking the 8th as "today" splits the month's 22 workdays into 5 before (the 1st to the 4th and
// the 7th), the day itself, and 16 after. **A past workday with nothing recorded on it contributes
// nothing** -- the interval is gone and no work replaced it -- so a projection taken on the 8th
// starts 40 hours below capacity however the rest of the day goes. Every expectation below is
// written as that arithmetic rather than as a bare number, because the bare number looks wrong.
const BEFORE_8TH = 5 * 8;
const AFTER_8TH = 16 * 8;

Deno.test("capacity is the sum of the month's scheduled hours", () => {
  const p = project({
    month: SEP,
    cal: emptyCalendar(),
    monthlyTargetHours: 160,
    entries: [],
    today: "2026-08-31",
    nowMinutes: 0,
  });
  assertEquals(p.capacityHours, SEP_CAPACITY);
  assertEquals(p.slackHours, SEP_CAPACITY - 160);
});

Deno.test("a month entirely in the future projects its whole capacity", () => {
  const p = project({
    month: SEP,
    cal: emptyCalendar(),
    monthlyTargetHours: 160,
    entries: [],
    today: "2026-08-31",
    nowMinutes: 12 * 60,
  });
  assertEquals(p.projectedHours, SEP_CAPACITY);
  assertEquals(p.paceHours, SEP_CAPACITY - 160);
  assertEquals(p.remainingToday, 0, "today is not in this month");
});

Deno.test("a month entirely in the past projects exactly what was worked", () => {
  const entries = [entry("2026-09-01", 8), entry("2026-09-02", 6)];
  const p = project({
    month: SEP,
    cal: emptyCalendar(),
    monthlyTargetHours: 160,
    entries,
    today: "2026-10-15",
    nowMinutes: 10 * 60,
  });
  assertEquals(p.workedHours, 14);
  assertEquals(p.projectedHours, 14, "no interval is left anywhere in a past month");
  assertEquals(p.paceHours, 14 - 160);
});

Deno.test("the projection moves as the scheduled day elapses, with no work at all", () => {
  const at = (nowMinutes: number) =>
    project({
      month: SEP,
      cal: emptyCalendar(),
      monthlyTargetHours: 160,
      entries: [],
      today: "2026-09-08", // a Tuesday
      nowMinutes,
    }).projectedHours;

  // 6.27 -- before the day starts, today's whole interval is still ahead. The first week is
  // already lost, because nothing was recorded against it.
  assertEquals(at(8 * 60), AFTER_8TH + 8);
  // ...at midday half of today is gone too, and nothing was worked to replace it.
  assertEquals(at(13 * 60), AFTER_8TH + 4);
  // ...and by five o'clock the whole day has gone the same way.
  assertEquals(at(17 * 60), AFTER_8TH);
  assertEquals(at(23 * 60), AFTER_8TH, "it cannot drop below losing the day");
  assertEquals(SEP_CAPACITY - BEFORE_8TH - 8, AFTER_8TH, "the split accounts for the month");
});

Deno.test("work recorded today replaces what the elapsed interval gave up", () => {
  const p = project({
    month: SEP,
    cal: emptyCalendar(),
    monthlyTargetHours: 160,
    entries: [entry("2026-09-08", 4)],
    today: "2026-09-08",
    nowMinutes: 13 * 60, // four scheduled hours gone, four worked
  });
  assertEquals(p.actualToday, 4);
  assertEquals(p.remainingToday, 4);
  assertEquals(p.todayContribution, 8, "6.26 -- worked plus what is left");
  assertEquals(p.projectedHours, AFTER_8TH + 8, "today is whole again; the lost week is not");
});

Deno.test("6.28 -- work before the interval starts reads as ahead, not absorbed", () => {
  const early = project({
    month: SEP,
    cal: emptyCalendar(),
    monthlyTargetHours: 160,
    entries: [entry("2026-09-08", 2)],
    today: "2026-09-08",
    nowMinutes: 8 * 60, // 7am-9am worked, and the whole interval is still ahead
  });
  assertEquals(early.remainingToday, 8, "the interval has not started");
  assertEquals(early.todayContribution, 10, "the two hours are on top, not absorbed");
  assertEquals(early.projectedHours, AFTER_8TH + 10);
});

Deno.test("work after the interval ends also reads as ahead", () => {
  const late = project({
    month: SEP,
    cal: emptyCalendar(),
    monthlyTargetHours: 160,
    entries: [entry("2026-09-08", 10)],
    today: "2026-09-08",
    nowMinutes: 19 * 60,
  });
  assertEquals(late.remainingToday, 0);
  assertEquals(late.projectedHours, AFTER_8TH + 10, "ten worked beats the eight scheduled");
});

Deno.test("a weekend worked counts in full, because the weekend was scheduled as nothing", () => {
  // On Monday the 14th: nine workdays are behind (72 hours, all lost -- nothing was recorded on
  // them), today is untouched, and twelve workdays are ahead. The Saturday is the only recorded
  // work, and it lands whole, because a day with no interval had nothing to absorb it.
  const p = project({
    month: SEP,
    cal: emptyCalendar(),
    monthlyTargetHours: 160,
    entries: [entry("2026-09-12", 5)], // a Saturday
    today: "2026-09-14",
    nowMinutes: 9 * 60,
  });
  assertEquals(p.actualBeforeToday, 5);
  assertEquals(p.todayContribution, 8);
  assertEquals(p.remainingWorkdayHours, 12 * 8);
  assertEquals(p.projectedHours, 5 + 8 + 12 * 8);
});

Deno.test("a public holiday takes its day out of capacity and out of the projection", () => {
  const cal = calendar([{ date: "2026-10-05", name: "Labour Day" }]);
  const p = project({
    month: "2026-10",
    cal,
    monthlyTargetHours: 160,
    entries: [],
    today: "2026-09-01",
    nowMinutes: 0,
  });
  // October 2026 has 22 weekdays; one holiday removes eight hours.
  assertEquals(p.capacityHours, 22 * 8 - 8);
  assertEquals(p.projectedHours, p.capacityHours);
  assertEquals(p.holidays.map((h) => h.name), ["Labour Day"], "6.37 -- and it says which");
});

Deno.test("an override outranks a holiday, so a holiday you choose to work counts", () => {
  const cal = calendar(
    [{ date: "2026-10-05", name: "Labour Day" }],
    [{ date: "2026-10-05", interval: { start: "09:00", end: "13:00" }, reason: "catching up" }],
  );
  const p = project({
    month: "2026-10",
    cal,
    monthlyTargetHours: 160,
    entries: [],
    today: "2026-09-01",
    nowMinutes: 0,
  });
  assertEquals(p.capacityHours, 22 * 8 - 8 + 4);
  assertEquals(p.holidays.length, 0, "the day is no longer shaped by the holiday");
});

Deno.test("an override can also take a workday off, which is what leave is", () => {
  const cal = calendar([], [{ date: "2026-09-08", interval: null, reason: "leave" }]);
  const p = project({
    month: SEP,
    cal,
    monthlyTargetHours: 160,
    entries: [],
    today: "2026-09-01",
    nowMinutes: 0,
  });
  assertEquals(p.capacityHours, SEP_CAPACITY - 8);
});

Deno.test("entries outside the month are ignored rather than counted", () => {
  const p = project({
    month: SEP,
    cal: emptyCalendar(),
    monthlyTargetHours: 160,
    entries: [entry("2026-08-31", 8), entry("2026-10-01", 8), entry("2026-09-01", 3)],
    today: "2026-09-30",
    nowMinutes: 23 * 60,
  });
  assertEquals(p.workedHours, 3);
});

Deno.test("the parts add up to the whole, on every day of a worked month", () => {
  // A guard on the decomposition rather than on any one number: whatever the shape of the month,
  // the reported terms must reconstruct the projection, or the pacing detail lies.
  //
  // This is the check that earned its place. 6.29 names three terms, and with three terms this
  // fails by exactly the hours of the future-dated entries below -- work filed forward is neither
  // "before today" nor a *scheduled* hour still to come, so it fell through the decomposition
  // while still being counted in the total. `actualAfterToday` is the fourth term it wanted.
  const entries = [
    entry("2026-09-01", 7.5),
    entry("2026-09-02", 8),
    entry("2026-09-05", 2), // a Saturday
    entry("2026-09-08", 3),
    entry("2026-09-21", 4), // future-dated
  ];
  for (const day of ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-30"]) {
    for (const now of [0, 8 * 60, 12 * 60, 17 * 60, 23 * 60 + 59]) {
      const p = project({
        month: SEP,
        cal: emptyCalendar(),
        monthlyTargetHours: 160,
        entries,
        today: day,
        nowMinutes: now,
      });
      assertAlmostEquals(
        p.actualBeforeToday + p.todayContribution + p.remainingWorkdayHours + p.actualAfterToday,
        p.projectedHours,
        1e-9,
        `${day} @ ${now}`,
      );
      assertAlmostEquals(p.paceHours, p.projectedHours - 160, 1e-9);
    }
  }
});

Deno.test("the projection never rises as the clock advances on an idle day", () => {
  // Time passing cannot make you more likely to hit the target. If this ever fails, some term is
  // being counted twice as the interval elapses.
  let previous = Infinity;
  for (let m = 0; m <= 24 * 60; m += 15) {
    const p = project({
      month: SEP,
      cal: emptyCalendar(),
      monthlyTargetHours: 160,
      entries: [],
      today: "2026-09-08",
      nowMinutes: m,
    });
    assertEquals(p.projectedHours <= previous + 1e-9, true, `rose at ${m} minutes`);
    previous = p.projectedHours;
  }
});

Deno.test("workedToday adds the running timer to what is already recorded", () => {
  const entries = [entry("2026-09-08", 2), entry("2026-09-07", 8)];
  assertEquals(workedToday(entries, "2026-09-08"), 2 * HOUR);
  assertEquals(workedToday(entries, "2026-09-08", 30 * 60 * 1000), 2.5 * HOUR);
  assertEquals(workedToday(entries, "2026-09-09"), 0);
});

Deno.test("24.41 -- elapsed scheduled hours is the month's working time already gone", () => {
  const of = (today: string, nowMinutes: number) =>
    project({
      month: SEP,
      cal: emptyCalendar(),
      monthlyTargetHours: 160,
      entries: [],
      today,
      nowMinutes,
    }).elapsedScheduledHours;

  // Before the month starts, none of it has elapsed; after it ends, all of it has.
  assertEquals(of("2026-08-31", 0), 0);
  assertEquals(of("2026-10-01", 0), SEP_CAPACITY);

  // On the 8th at nine, the five earlier workdays are gone and the day itself has not begun.
  assertEquals(of("2026-09-08", 9 * 60), BEFORE_8TH);
  // Half past one is half the nine-to-five gone.
  assertEquals(of("2026-09-08", 13 * 60), BEFORE_8TH + 4);
  assertEquals(of("2026-09-08", 17 * 60), BEFORE_8TH + 8);

  // A Sunday adds nothing however long you stare at it: this is working time, not calendar time,
  // which is the whole reason the bar is worth drawing.
  assertEquals(of("2026-09-06", 23 * 60), 4 * 8);
});

Deno.test("elapsed and remaining are the two halves of capacity", () => {
  // The invariant behind the bar: whatever the clock says, what has gone plus what is left is the
  // month. Derived from the same per-day `remaining` as the projection, so they cannot drift.
  for (const nowMinutes of [0, 9 * 60, 12 * 60 + 37, 17 * 60, 23 * 60 + 59]) {
    const p = project({
      month: SEP,
      cal: emptyCalendar(),
      monthlyTargetHours: 160,
      entries: [],
      today: "2026-09-08",
      nowMinutes,
    });
    const stillAhead = p.days.reduce((t, d) => t + d.remaining, 0);
    assertAlmostEquals(p.elapsedScheduledHours + stillAhead, p.capacityHours, 1e-9);
  }
});
