import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { type Db, open } from "./db.ts";
import {
  activeTimer,
  addEntry,
  deleteEntry,
  discardTimer,
  entriesInMonth,
  entriesInRange,
  entriesOn,
  getEntry,
  recentBillingTags,
  Refused,
  runningMs,
  startTimer,
  stopTimer,
  updateEntry,
} from "./work.ts";

const HOUR = 3_600_000;
const T0 = 1_788_000_000_000; // a fixed instant, so nothing here depends on when it runs

function fresh(): Db {
  return open({ path: ":memory:" });
}

Deno.test("2.9 -- a duration attributed to yesterday, with no invented times", () => {
  const db = fresh();
  const e = addEntry(db, { date: "2026-09-07", durationMs: 2 * HOUR, billingTag: "Admin" }, T0);
  assertEquals(e.timing, undefined);
  assertEquals(getEntry(db, e.id)?.timing, undefined, "and it stays absent through the database");
  assertEquals(getEntry(db, e.id)?.durationMs, 2 * HOUR);
  db.close();
});

Deno.test("2.11 -- timed and duration-only entries coexist on one day", () => {
  const db = fresh();
  addEntry(db, { date: "2026-09-08", durationMs: HOUR, billingTag: "Admin" }, T0);
  addEntry(db, {
    date: "2026-09-08",
    durationMs: 2 * HOUR,
    billingTag: "Product Development",
    timing: { startedAt: T0, endedAt: T0 + 2 * HOUR },
  }, T0);
  const day = entriesOn(db, "2026-09-08");
  assertEquals(day.length, 2);
  assertEquals(day.filter((e) => e.timing).length, 1);
  db.close();
});

Deno.test("2.12 -- an entry converts between forms in both directions", () => {
  const db = fresh();
  const e = addEntry(db, {
    date: "2026-09-08",
    durationMs: 2 * HOUR,
    billingTag: "Admin",
    timing: { startedAt: T0, endedAt: T0 + 2 * HOUR },
  }, T0);

  // Explicit null drops the timing; the duration is untouched, which is 2.13's point.
  const bare = updateEntry(db, e.id, { timing: null }, T0);
  assertEquals(bare.timing, undefined);
  assertEquals(bare.durationMs, 2 * HOUR);
  assertEquals(getEntry(db, e.id)?.timing, undefined);

  const timed = updateEntry(db, e.id, { timing: { startedAt: T0, endedAt: T0 + HOUR } }, T0);
  assertEquals(timed.timing?.endedAt, T0 + HOUR);
  db.close();
});

Deno.test("omitting timing leaves it alone, which is why null has to mean something else", () => {
  const db = fresh();
  const e = addEntry(db, {
    date: "2026-09-08",
    durationMs: HOUR,
    billingTag: "Admin",
    timing: { startedAt: T0, endedAt: T0 + HOUR },
  }, T0);
  const renamed = updateEntry(db, e.id, { billingTag: "Meetings" }, T0);
  assertEquals(renamed.timing?.startedAt, T0, "an unrelated edit did not erase the times");
  assertEquals(renamed.billingTag, "Meetings");
  db.close();
});

Deno.test("editing a missing entry is refused rather than silently creating one", () => {
  const db = fresh();
  assertThrows(() => updateEntry(db, "nope", { durationMs: 1 }), Refused, "no work entry");
  assertEquals(deleteEntry(db, "nope"), false);
  db.close();
});

Deno.test("entries are found by month and by half-open range", () => {
  const db = fresh();
  for (const d of ["2026-08-31", "2026-09-01", "2026-09-30", "2026-10-01"]) {
    addEntry(db, { date: d, durationMs: HOUR, billingTag: "Admin" }, T0);
  }
  assertEquals(entriesInMonth(db, "2026-09").map((e) => e.date), ["2026-09-01", "2026-09-30"]);
  assertEquals(
    entriesInRange(db, "2026-09-01", "2026-10-01").map((e) => e.date),
    ["2026-09-01", "2026-09-30"],
    "the upper bound is excluded",
  );
  db.close();
});

Deno.test("2.2 -- a second start is refused while one is running", () => {
  const db = fresh();
  startTimer(db, { billingTag: "Product Development", date: "2026-09-08", now: T0 });
  assertThrows(
    () => startTimer(db, { billingTag: "Meetings", date: "2026-09-08", now: T0 + 1000 }),
    Refused,
    "already running",
  );
  assertEquals(activeTimer(db)?.billingTag, "Product Development", "the first one is untouched");
  db.close();
});

Deno.test("2.5 -- stopping records the work, as a timed entry", () => {
  const db = fresh();
  startTimer(db, { billingTag: "Product Development", date: "2026-09-08", now: T0 });
  const e = stopTimer(db, T0 + 90 * 60_000);
  assertEquals(e.durationMs, 90 * 60_000);
  assertEquals(e.timing, { startedAt: T0, endedAt: T0 + 90 * 60_000 });
  assertEquals(activeTimer(db), undefined);
  assertEquals(entriesOn(db, "2026-09-08").length, 1);
  db.close();
});

Deno.test("stopping when nothing is running is refused, not a zero-length entry", () => {
  const db = fresh();
  assertThrows(() => stopTimer(db, T0), Refused, "no timer is running");
  assertEquals(entriesInMonth(db, "2026-09").length, 0);
  db.close();
});

Deno.test("2.21 -- a session across midnight belongs entirely to the day it began", () => {
  const db = fresh();
  startTimer(db, { billingTag: "Product Development", date: "2026-09-08", now: T0 });
  const e = stopTimer(db, T0 + 6 * HOUR); // whatever the wall clock now says
  assertEquals(e.date, "2026-09-08");
  assertEquals(entriesOn(db, "2026-09-09").length, 0);
  db.close();
});

Deno.test("2.23 -- the stopping device's timezone cannot move the entry's date", () => {
  // The date is fixed at start (2.20) and `stopTimer` takes no date at all, so there is no
  // parameter through which another device's calendar could reach it. Asserted rather than argued
  // because "there is no way to do X" is exactly the kind of claim a later signature change breaks.
  const db = fresh();
  startTimer(db, { billingTag: "Admin", date: "2026-09-08", now: T0 });
  assertEquals(stopTimer(db, T0 + HOUR).date, "2026-09-08");
  db.close();
});

Deno.test("a timer can be discarded without recording anything", () => {
  const db = fresh();
  startTimer(db, { billingTag: "Admin", date: "2026-09-08", now: T0 });
  assertEquals(discardTimer(db), true);
  assertEquals(activeTimer(db), undefined);
  assertEquals(entriesInMonth(db, "2026-09").length, 0);
  assertEquals(discardTimer(db), false, "and discarding nothing says so");
  db.close();
});

Deno.test("2.16/2.17 -- a long timer is measured and reported, never corrected", () => {
  const db = fresh();
  const t = startTimer(db, { billingTag: "Admin", date: "2026-09-08", now: T0 });
  assertEquals(runningMs(t, T0 + 30 * HOUR), 30 * HOUR);
  // Thirty hours later it is still running, and stopping it still records all thirty.
  assertEquals(activeTimer(db)?.startedAt, T0);
  assertEquals(stopTimer(db, T0 + 30 * HOUR).durationMs, 30 * HOUR);
  db.close();
});

Deno.test("a clock that went backwards produces a zero-length entry, not a crash", () => {
  // An NTP step or a laptop resuming can make `now` earlier than the start. Clamping only the
  // duration is not enough -- the timing has to agree with itself, or the table's own CHECK throws
  // and stopping the timer fails outright. That is how this was found.
  const db = fresh();
  startTimer(db, { billingTag: "Admin", date: "2026-09-08", now: T0 });
  const e = stopTimer(db, T0 - 5000);
  assertEquals(e.durationMs, 0);
  assertEquals(e.timing, { startedAt: T0, endedAt: T0 });
  assertEquals(getEntry(db, e.id)?.durationMs, 0, "and it reached the database");
  db.close();
});

Deno.test("4.5 -- recent billing tags come back newest first, without duplicates", () => {
  const db = fresh();
  addEntry(db, { date: "2026-09-01", durationMs: HOUR, billingTag: "Admin" }, T0);
  addEntry(db, { date: "2026-09-02", durationMs: HOUR, billingTag: "Research" }, T0 + 1000);
  addEntry(db, { date: "2026-09-03", durationMs: HOUR, billingTag: "Admin" }, T0 + 2000);
  assertEquals(recentBillingTags(db), ["Admin", "Research"]);
  db.close();
});
