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
  restartTimerAt,
  retagTimer,
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

  // 25.28 — and adding times back sets the duration to what they say. This used to leave the old
  // two hours in place beside a one-hour interval: the row read 09:00–10:00 and the month total
  // counted two, and the invoice billed the total.
  const timed = updateEntry(db, e.id, { timing: { startedAt: T0, endedAt: T0 + HOUR } }, T0);
  assertEquals(timed.timing?.endedAt, T0 + HOUR);
  assertEquals(timed.durationMs, HOUR);
  assertEquals(getEntry(db, e.id)?.durationMs, HOUR);
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

Deno.test("24.9 -- a timer will not start without a billing tag", () => {
  // It used to accept whatever the frontend sent, and the frontend sent `tag || last || "Work"`.
  // The refusal belongs here: a rule enforced only in the UI is a rule that holds until somebody
  // writes a second UI, or a script.
  const db = fresh();
  for (const billingTag of ["", "   ", "\t"]) {
    assertThrows(
      () => startTimer(db, { billingTag, date: "2026-09-08", now: T0 }),
      Refused,
      "needs a billing tag",
    );
  }
  assertEquals(activeTimer(db), undefined, "a refused start left a timer behind");
  db.close();
});

Deno.test("24.10 -- a running timer can be retagged, and nothing else about it moves", () => {
  const db = fresh();
  startTimer(db, {
    billingTag: "  Feature development  ",
    date: "2026-09-08",
    now: 1_788_000_000_000,
  });
  const before = activeTimer(db)!;
  assertEquals(before.billingTag, "Feature development", "the tag is stored trimmed");

  const after = retagTimer(db, "Code review");
  assertEquals(after.billingTag, "Code review");
  // 2.19 — the date is decided at the start and nothing later moves it, retagging included.
  assertEquals(after.startedAt, before.startedAt);
  assertEquals(after.date, before.date);

  assertThrows(() => retagTimer(db, "  "), Refused, "needs a billing tag");
  assertEquals(activeTimer(db)?.billingTag, "Code review", "a refused retag changed it anyway");
  db.close();
});

Deno.test("retagging when nothing is running is refused", () => {
  const db = fresh();
  assertThrows(() => retagTimer(db, "Anything"), Refused, "no timer is running");
  db.close();
});

Deno.test("25.27 -- a running timer's start can be corrected", () => {
  const db = fresh();
  startTimer(db, { billingTag: "Product Development", date: "2026-09-08", now: T0 });
  // Noticed at T0 + 2h that it should have begun 90 minutes before that.
  const moved = restartTimerAt(db, T0 - 90 * 60_000, T0 + 2 * HOUR);
  assertEquals(moved.startedAt, T0 - 90 * 60_000);
  assertEquals(activeTimer(db)?.startedAt, T0 - 90 * 60_000);
  // The tag is untouched: this message moves one thing.
  assertEquals(moved.billingTag, "Product Development");
  db.close();
});

Deno.test("and the corrected start is what the entry records when it stops", () => {
  // Without this the correction would be cosmetic — visible on the timer screen and absent from
  // the work, which is the only place it matters.
  const db = fresh();
  startTimer(db, { billingTag: "Product Development", date: "2026-09-08", now: T0 });
  restartTimerAt(db, T0 - HOUR, T0);
  const entry = stopTimer(db, T0 + HOUR);
  assertEquals(entry.durationMs, 2 * HOUR);
  assertEquals(entry.timing?.startedAt, T0 - HOUR);
  db.close();
});

Deno.test("a start in the future or two days back is refused", () => {
  const db = fresh();
  startTimer(db, { billingTag: "Product Development", date: "2026-09-08", now: T0 });
  // Every figure downstream is `now - startedAt`; a future start makes all of them negative.
  assertThrows(() => restartTimerAt(db, T0 + HOUR, T0), Refused, "future");
  assertThrows(() => restartTimerAt(db, T0 - 3 * 24 * HOUR, T0), Refused, "past entry instead");
  // Unchanged by either refusal.
  assertEquals(activeTimer(db)?.startedAt, T0);
  db.close();
});

Deno.test("moving the start of a timer that is not running is refused", () => {
  const db = fresh();
  assertThrows(() => restartTimerAt(db, T0 - HOUR, T0), Refused, "no timer is running");
  db.close();
});

Deno.test("25.3 -- the server refuses an entry it could not show anybody", () => {
  /*
   * All of these were accepted, and stored, and the client's validation was the only thing
   * stopping them. 1.8 makes the server the authority; a rule enforced only by the sender is not
   * enforced.
   *
   * The date is the one that matters. Every view groups by month, so an entry dated "banana" is
   * in no month — not on the history screen, not in a total, not on an invoice, and not reported
   * missing either. It is simply somewhere nobody looks.
   */
  const db = fresh();
  const bad = (why: string, input: Parameters<typeof addEntry>[1]) =>
    assertThrows(() => addEntry(db, input), Refused, why);

  bad("not a calendar date", { date: "banana" as never, durationMs: HOUR, billingTag: "x" });
  bad("not a calendar date", { date: "2026-13-45" as never, durationMs: HOUR, billingTag: "x" });
  // The shape alone admits this one; `Date` would roll it into March without a word.
  bad("not a calendar date", { date: "2026-02-31" as never, durationMs: HOUR, billingTag: "x" });
  bad("needs a billing tag", { date: "2026-09-01", durationMs: HOUR, billingTag: "   " });
  bad("at most 200", { date: "2026-09-01", durationMs: HOUR, billingTag: "z".repeat(201) });
  bad("negative or unreadable", { date: "2026-09-01", durationMs: -HOUR, billingTag: "x" });

  // 29 February 2028 is real; 2026 is not a leap year, so the check has to know which.
  addEntry(db, { date: "2028-02-29", durationMs: HOUR, billingTag: "x" });
  bad("not a calendar date", { date: "2026-02-29" as never, durationMs: HOUR, billingTag: "x" });
  db.close();
});

Deno.test("a timed entry whose interval disagrees with its duration is refused", () => {
  // The invoice bills `durationMs`; the history screen shows the interval. Accepting both means
  // the same entry says two different things depending on where you read it, and one of them is
  // what gets paid.
  const db = fresh();
  assertThrows(
    () =>
      addEntry(db, {
        date: "2026-09-01",
        durationMs: HOUR,
        billingTag: "x",
        timing: { startedAt: T0, endedAt: T0 + 3 * HOUR },
      }),
    Refused,
    "these do not match",
  );
  // And the honest version goes in.
  const ok = addEntry(db, {
    date: "2026-09-01",
    durationMs: 3 * HOUR,
    billingTag: "x",
    timing: { startedAt: T0, endedAt: T0 + 3 * HOUR },
  });
  assertEquals(ok.durationMs, 3 * HOUR);
  db.close();
});

Deno.test("and an edit is held to the same rules as an insert", () => {
  // An edit reaches every field an insert does, so a check on `addEntry` alone guarded the easier
  // half — and editing is where a person actually retypes a date.
  const db = fresh();
  const e = addEntry(db, { date: "2026-09-01", durationMs: HOUR, billingTag: "x" });
  assertThrows(() => updateEntry(db, e.id, { date: "banana" as never }), Refused, "calendar date");
  assertThrows(() => updateEntry(db, e.id, { billingTag: "  " }), Refused, "billing tag");
  // Both, and disagreeing. Timing *alone* is a complete statement and sets the duration — see
  // 25.28 above; it is only saying two different things at once that is refused.
  assertThrows(
    () =>
      updateEntry(db, e.id, {
        durationMs: HOUR,
        timing: { startedAt: T0, endedAt: T0 + 5 * HOUR },
      }),
    Refused,
    "do not match",
  );
  // Unchanged by any of them.
  assertEquals(getEntry(db, e.id)?.date, "2026-09-01");
  db.close();
});

Deno.test("a tag is stored trimmed, so two spellings are one tag", () => {
  const db = fresh();
  const e = addEntry(db, { date: "2026-09-01", durationMs: HOUR, billingTag: "  Product  " });
  assertEquals(e.billingTag, "Product");
  assertEquals(getEntry(db, e.id)?.billingTag, "Product");
  db.close();
});
