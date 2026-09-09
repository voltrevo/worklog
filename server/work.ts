/**
 * Work entries and the one global timer.
 *
 * Every mutation here is an authoritative server operation (2.3): the frontends ask, they do not
 * decide. The timer in particular has no client-side half — a device sends "start" with the date
 * its own calendar says (2.19) and the server does the rest, so two devices pressing start at the
 * same moment resolve in SQLite rather than in whichever request arrived first.
 */

import type { ActiveTimer, DateString, Instant, WorkEntry } from "@worklog/shared/types";
import { type Db, transact } from "./db.ts";

/** Thrown for a request that is refused on its merits, as opposed to one that broke. */
export class Refused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "Refused";
  }
}

interface EntryRow {
  id: string;
  date: string;
  duration_ms: number;
  billing_tag: string;
  started_at: number | null;
  ended_at: number | null;
}

function toEntry(row: EntryRow): WorkEntry {
  const timing = row.started_at !== null && row.ended_at !== null
    ? { startedAt: Number(row.started_at), endedAt: Number(row.ended_at) }
    : undefined;
  return {
    id: row.id,
    date: row.date,
    durationMs: Number(row.duration_ms),
    billingTag: row.billing_tag,
    ...(timing ? { timing } : {}),
  };
}

const SELECT = `SELECT id, date, duration_ms, billing_tag, started_at, ended_at FROM work_entry`;

/** Every entry in a calendar month, earliest first. The month is a string prefix (7.10). */
export function entriesInMonth(db: Db, month: string): WorkEntry[] {
  return db.prepare(`${SELECT} WHERE substr(date, 1, 7) = ? ORDER BY date, started_at, id`)
    .all(month)
    .map((r) => toEntry(r as unknown as EntryRow));
}

/** 7.4 — a half-open range `[from, to)`, which the UI does not expose in v1 (7.9). */
export function entriesInRange(db: Db, from: DateString, to: DateString): WorkEntry[] {
  return db.prepare(`${SELECT} WHERE date >= ? AND date < ? ORDER BY date, started_at, id`)
    .all(from, to)
    .map((r) => toEntry(r as unknown as EntryRow));
}

export function entriesOn(db: Db, date: DateString): WorkEntry[] {
  return db.prepare(`${SELECT} WHERE date = ? ORDER BY started_at, id`)
    .all(date)
    .map((r) => toEntry(r as unknown as EntryRow));
}

export function getEntry(db: Db, id: string): WorkEntry | undefined {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id);
  return row ? toEntry(row as unknown as EntryRow) : undefined;
}

export interface NewEntry {
  date: DateString;
  durationMs: number;
  billingTag: string;
  /** Omit for a duration-only entry (2.9). */
  timing?: { startedAt: Instant; endedAt: Instant };
}

/**
 * What a work entry has to be, checked where every route passes.
 *
 * **The server used to accept all of this**, and the client's validation was the only thing
 * stopping it: `date: "banana"` stored verbatim, `"2026-13-45"` likewise, a tag of three spaces, a
 * 10,000-character tag, a 400-hour day, and a `timing` whose interval disagreed with the duration
 * beside it.
 *
 * The date is the one that matters most. Every view groups by month, so an entry dated "banana"
 * is in no month: it is not on the history screen, not in a total, not on an invoice, and not
 * missing either — it is simply somewhere nobody looks. Silent, and permanent.
 *
 * A disagreeing `timing` is the second. The invoice bills `durationMs` and the history screen
 * shows the interval, so the same entry says two different things depending on where you read it,
 * and one of them is what gets paid. 25.28 made that impossible in the editor; this makes it
 * impossible at all.
 *
 * 1.8 is the reason this is here rather than only in the frontend: the server is the authority,
 * and a rule enforced only by the thing sending the request is not enforced.
 */
const MAX_TAG = 200;

function validate(input: NewEntry): NewEntry {
  const billingTag = input.billingTag.trim();
  if (!billingTag) throw new Refused("no-billing-tag", "a work entry needs a billing tag");
  if (billingTag.length > MAX_TAG) {
    throw new Refused("tag-too-long", `a billing tag is at most ${MAX_TAG} characters`);
  }

  // `YYYY-MM-DD`, *and* a day that exists: the shape alone admits 2026-02-31, and `Date` would
  // roll it forward to March without complaining.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !isRealDate(input.date)) {
    throw new Refused("bad-date", `${JSON.stringify(input.date)} is not a calendar date`);
  }

  const durationMs = Math.round(input.durationMs);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Refused("bad-duration", "a duration cannot be negative or unreadable");
  }
  /*
   * **No upper bound, deliberately.** I added a 24-hour cap here and `work_test.ts` refused it,
   * correctly: 2.16 says warn about an implausibly long timer and 2.17 says do not silently guess
   * corrections for one. Refusing to *store* thirty hours is a harsher version of guessing — the
   * record is destroyed rather than adjusted, and the person is left with nothing where they had
   * a wrong number they could fix.
   *
   * Everything else this function checks is about *coherence*: a date that is a date, a tag that
   * is a tag, an interval that agrees with the duration printed beside it. Plausibility is a
   * different question and it is answered by a warning on screen.
   */

  if (input.timing) {
    const span = input.timing.endedAt - input.timing.startedAt;
    if (span !== durationMs) {
      throw new Refused(
        "timing-disagrees",
        "a timed entry's duration is its interval; these do not match",
      );
    }
  }

  return { ...input, billingTag, durationMs };
}

function isRealDate(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number);
  if (m! < 1 || m! > 12 || d! < 1) return false;
  // Day 0 of the next month is the last day of this one.
  return d! <= new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

export function addEntry(db: Db, raw: NewEntry, now: Instant = Date.now()): WorkEntry {
  const input = validate(raw);
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO work_entry (id, date, duration_ms, billing_tag, started_at, ended_at,
                             created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.date,
    Math.round(input.durationMs),
    input.billingTag,
    input.timing?.startedAt ?? null,
    input.timing?.endedAt ?? null,
    now,
    now,
  );
  return { id, ...input, durationMs: Math.round(input.durationMs) };
}

/**
 * Edit an entry, including converting it between forms (2.7, 2.12).
 *
 * Passing `timing: null` explicitly drops the timing and makes it duration-only; omitting the key
 * leaves whatever was there. The two have to be distinguishable, because "no change" and "remove
 * the times" are different edits and `undefined` cannot mean both.
 */
export interface EntryPatch {
  date?: DateString;
  durationMs?: number;
  billingTag?: string;
  timing?: { startedAt: Instant; endedAt: Instant } | null;
}

export function updateEntry(
  db: Db,
  id: string,
  patch: EntryPatch,
  now: Instant = Date.now(),
): WorkEntry {
  return transact(db, () => {
    const current = getEntry(db, id);
    if (!current) throw new Refused("no-such-entry", `no work entry ${id}`);

    const next: WorkEntry = {
      ...current,
      ...(patch.date !== undefined ? { date: patch.date } : {}),
      ...(patch.durationMs !== undefined ? { durationMs: Math.round(patch.durationMs) } : {}),
      ...(patch.billingTag !== undefined ? { billingTag: patch.billingTag } : {}),
    };
    if (patch.timing === null) delete next.timing;
    else if (patch.timing !== undefined) {
      next.timing = patch.timing;
      /*
       * 25.28 — the duration of a timed entry *is* its interval.
       *
       * Setting the times without saying a duration is a complete statement, so the duration
       * follows. It used to keep whatever was there: an entry could say two hours in the total
       * and 09:00–10:00 on the row, and the invoice billed the first. Saying both, and
       * disagreeing, is refused by `validate`; saying one is answered.
       */
      if (patch.durationMs === undefined) {
        next.durationMs = patch.timing.endedAt - patch.timing.startedAt;
      }
    }

    // The same rules as adding one. An edit can reach every field an insert can, so a check that
    // only guarded `addEntry` guarded the easier half.
    const checked = validate(next);
    next.date = checked.date;
    next.durationMs = checked.durationMs;
    next.billingTag = checked.billingTag;

    db.prepare(
      `UPDATE work_entry SET date = ?, duration_ms = ?, billing_tag = ?, started_at = ?,
                             ended_at = ?, updated_at = ? WHERE id = ?`,
    ).run(
      next.date,
      next.durationMs,
      next.billingTag,
      next.timing?.startedAt ?? null,
      next.timing?.endedAt ?? null,
      now,
      id,
    );
    return next;
  });
}

export function deleteEntry(db: Db, id: string): boolean {
  return db.prepare("DELETE FROM work_entry WHERE id = ?").run(id).changes > 0;
}

// ------------------------------------------------------------------------ the timer

interface TimerRow {
  started_at: number;
  date: string;
  billing_tag: string;
}

export function activeTimer(db: Db): ActiveTimer | undefined {
  const row = db.prepare("SELECT started_at, date, billing_tag FROM active_timer WHERE id = 1")
    .get() as unknown as TimerRow | undefined;
  return row
    ? { startedAt: Number(row.started_at), date: row.date, billingTag: row.billing_tag }
    : undefined;
}

export interface StartInput {
  billingTag: string;
  /** The starting device's local calendar date (2.19). The server does not second-guess it. */
  date: DateString;
  now?: Instant;
}

/**
 * Start the timer, or refuse because one is already running (2.2).
 *
 * The date is taken now and kept (2.20). A session that runs past midnight therefore belongs
 * entirely to the day it began on (2.21), and stopping it from a device in another timezone cannot
 * move it.
 */
export function startTimer(db: Db, input: StartInput): ActiveTimer {
  const now = input.now ?? Date.now();
  // 24.1, 24.9 — refused rather than defaulted. The frontend used to fall back through the last
  // tag used to the invented word "Work", so a fresh server recorded work against a tag nobody
  // had chosen. The rule is the same everywhere: a missing required value is a refusal.
  const billingTag = input.billingTag.trim();
  if (!billingTag) throw new Refused("no-billing-tag", "a timer needs a billing tag");
  return transact(db, () => {
    const running = activeTimer(db);
    if (running) throw new Refused("timer-already-running", "a timer is already running");
    db.prepare("INSERT INTO active_timer (id, started_at, date, billing_tag) VALUES (1, ?, ?, ?)")
      .run(now, input.date, billingTag);
    return { startedAt: now, date: input.date, billingTag };
  });
}

/**
 * 24.10 — correct a running timer's tag without stopping it.
 *
 * The alternative was stop, edit in History, start again, which loses the running session's
 * continuity to fix a label. Only the tag can change: the start time and the date are what the
 * timer *is*, and 2.19 fixes the date at the start on purpose.
 */
export function retagTimer(db: Db, billingTag: string): ActiveTimer {
  const wanted = billingTag.trim();
  if (!wanted) throw new Refused("no-billing-tag", "a timer needs a billing tag");
  return transact(db, () => {
    const running = activeTimer(db);
    if (!running) throw new Refused("no-timer-running", "no timer is running");
    db.prepare("UPDATE active_timer SET billing_tag = ? WHERE id = 1").run(wanted);
    return { ...running, billingTag: wanted };
  });
}

/**
 * 25.27 — move a running timer's start.
 *
 * The case this is for is forgetting to press Start: you notice at 11:20 that you began at 09:30,
 * and the only remedies were to stop the timer and hand-add a past entry, or to let it record the
 * wrong thing. Both lose the fact that you are still working.
 *
 * Refused in the future, because a session that has not begun is not running, and every figure
 * downstream — today's total, the pace, the segments on the bar — would go negative from a value
 * the UI would then have to defend against one screen at a time.
 */
export function restartTimerAt(db: Db, startedAt: Instant, now: Instant = Date.now()): ActiveTimer {
  return transact(db, () => {
    const running = activeTimer(db);
    if (!running) throw new Refused("no-timer-running", "no timer is running");
    if (startedAt > now) {
      throw new Refused("start-in-the-future", "a timer cannot have started in the future");
    }
    if (now - startedAt > IMPLAUSIBLE_START_MS) {
      throw new Refused(
        "start-too-long-ago",
        "that start is more than two days ago; add it as a past entry instead",
      );
    }
    db.prepare("UPDATE active_timer SET started_at = ? WHERE id = 1").run(startedAt);
    return { ...running, startedAt };
  });
}

/**
 * Two days. Not a policy about how long anyone works — 2.19's implausible-timer warning already
 * covers that — but a bound on what this message can be used to invent, since a start moved back
 * far enough files today's work under a date nobody is looking at.
 */
const IMPLAUSIBLE_START_MS = 2 * 24 * 3_600_000;

/** 2.5 — stopping persists the work. The entry is timed, since the times are genuinely known. */
export function stopTimer(db: Db, now: Instant = Date.now()): WorkEntry {
  return transact(db, () => {
    const running = activeTimer(db);
    if (!running) throw new Refused("no-timer-running", "no timer is running");
    db.prepare("DELETE FROM active_timer WHERE id = 1").run();
    // A clock that went backwards -- an NTP step, a laptop resuming -- would otherwise write an
    // entry that ended before it began, which the table refuses outright. Clamping the *duration*
    // alone is not enough: the timing has to be consistent with itself, so the end is pulled up to
    // the start and the session records as zero rather than as a negative one.
    const endedAt = Math.max(now, running.startedAt);
    return addEntry(db, {
      date: running.date,
      durationMs: endedAt - running.startedAt,
      billingTag: running.billingTag,
      timing: { startedAt: running.startedAt, endedAt },
    }, now);
  });
}

/** Cancel without recording anything. Not a requirement; the counterpart to a mistaken start. */
export function discardTimer(db: Db): boolean {
  return db.prepare("DELETE FROM active_timer WHERE id = 1").run().changes > 0;
}

/**
 * 2.16 — how long the running timer has been going, for warning about an implausible one.
 *
 * It returns a number and says nothing about what to do with it. 2.17 forbids guessing a
 * correction, so nothing here truncates, splits or stops a long timer; the UI warns and the person
 * decides.
 */
export function runningMs(timer: ActiveTimer, now: Instant = Date.now()): number {
  return Math.max(0, now - timer.startedAt);
}

/** 4.5, 4.6 — tags already used, most recently first, for autocomplete. */
export function recentBillingTags(db: Db, limit = 20): string[] {
  return db.prepare(
    `SELECT billing_tag FROM work_entry GROUP BY billing_tag
     ORDER BY max(created_at) DESC LIMIT ?`,
  ).all(limit).map((r) => (r as { billing_tag: string }).billing_tag);
}
