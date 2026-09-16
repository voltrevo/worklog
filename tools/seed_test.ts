/**
 * The fixture's two invariants about *today*, which every screen driven from a seeded database
 * depends on and which were both being decided by chance.
 *
 * The timer screen draws today's total against today's scheduled hours, and `progress` caps at 1 —
 * so a day already at or past its schedule paints a full bar, the same picture whatever the figures
 * beneath it say. `tools/journey.mjs`'s 26.19 check skips a saturated reading rather than passing
 * on one, which is right; what it cannot do is measure when every reading is saturated.
 *
 * Measured on 2026-09-16, before this: today drew 8.75h against an 8h schedule, all four readings
 * were of a full bar, and the journey reported `0 usable readings` and failed with nothing in the
 * product wrong. On 2026-09-08, when the seed's constant was chosen, the same code came out under.
 * The end-to-end suite passed or failed by the date it was run on.
 *
 * These are unit tests over `seedPlan.ts` rather than assertions about a seeded database, because
 * the seeder runs on import and writing one would need a subprocess — and `deno task test` grants
 * `--allow-run=git` only, which 27.25 is right to keep narrow. The rule is what matters and the
 * rule is now in one place.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  fixtureSchedule,
  hoursFor,
  NINE_TO_FIVE,
  scheduledHours,
  TODAY_HEADROOM_HOURS,
} from "./seedPlan.ts";
import type { Weekday } from "../shared/types.ts";

const ALL_DAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 7];

Deno.test({
  name: "the fixture schedules today, whichever day of the week today is",
  fn() {
    for (const today of ALL_DAYS) {
      const schedule = fixtureSchedule(today);
      assert(
        schedule[today] !== null,
        `today is weekday ${today} and the fixture schedules nothing on it, so the timer bar's ` +
          `denominator is zero: 26.19 skips every reading for ofH === 0 and fails having ` +
          `measured nothing. Two days in seven, with the product working.`,
      );
      assert(
        scheduledHours(schedule, today) > 0,
        `and the interval has to have length, not merely exist`,
      );
    }
  },
});

Deno.test({
  name: "and it leaves the rest of the week alone — a weekday fixture is still Mon-Fri",
  fn() {
    // Today is a Wednesday here, so the weekend must still be unscheduled: the pacing screen's
    // "a weekend still to come is drawn as a non-workday" depends on it, and a fixture that
    // scheduled all seven days to make one check measurable would break that one instead.
    const schedule = fixtureSchedule(3);
    assertEquals(schedule[6], null, "Saturday stays off");
    assertEquals(schedule[7], null, "Sunday stays off");
    for (const d of [1, 2, 3, 4, 5] as Weekday[]) {
      assert(schedule[d] !== null, `weekday ${d} is scheduled`);
    }
  },
});

Deno.test({
  name: "a Saturday today adds Saturday and nothing else",
  fn() {
    const schedule = fixtureSchedule(6);
    assert(schedule[6] !== null, "the day the screens are about is scheduled");
    assertEquals(schedule[7], null, "and only that day — Sunday is untouched");
  },
});

Deno.test({
  name: "today's hours leave the bar visibly unfinished, whatever the draw was",
  fn() {
    const scheduled = scheduledHours(fixtureSchedule(3), 3);
    assertEquals(scheduled, 8, "09:00-17:00 is eight hours");

    // The whole range the seeder can draw for a weekday: `5 + random() * 4`.
    for (let raw = 5; raw <= 9; raw += 0.05) {
      const hours = hoursFor(raw, true, scheduled);
      assert(
        hours < scheduled,
        `a draw of ${raw.toFixed(2)}h became ${hours}h against ${scheduled}h scheduled — at or ` +
          `past the schedule the bar is full and 26.19 can take no usable reading`,
      );
      assert(
        scheduled - hours >= 1,
        `${scheduled - hours}h of headroom from a draw of ${raw.toFixed(2)}h; 26.19 runs the ` +
          `timer four times before reading the bar, so a margin it can close itself is a check ` +
          `that passes until the day it matters`,
      );
    }
  },
});

Deno.test({
  name: "and a day that is not today is left entirely to the draw",
  fn() {
    // The variety is the point of the pacing screen: days over the schedule and days under it are
    // both wanted, and capping every day would flatten the picture this fixture exists to produce.
    const scheduled = scheduledHours(fixtureSchedule(3), 3);
    assertEquals(hoursFor(8.75, false, scheduled), 8.75, "an over-schedule day survives");
    assertEquals(hoursFor(9, false, scheduled), 9, "and so does the top of the range");
  },
});

Deno.test({
  name: "an unscheduled day cannot be capped against a schedule it does not have",
  fn() {
    // `scheduled === 0` would make the cap `0 - 1.5`, i.e. a negative duration. Today is always
    // scheduled now, so this is the guard rather than the case — but a rule that produces a
    // negative only when another rule is broken is worth pinning.
    assertEquals(hoursFor(3, true, 0), 3, "the draw stands when there is no schedule to cap to");
    assert(hoursFor(3, true, 0) > 0, "and it is never negative");
  },
});

Deno.test({
  name: "the headroom is stated once and is more than four short sessions",
  fn() {
    assertEquals(NINE_TO_FIVE.start, "09:00");
    assert(
      TODAY_HEADROOM_HOURS >= 1,
      "26.19 starts and stops the timer four times before it reads the bar",
    );
  },
});
