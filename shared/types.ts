/**
 * The domain vocabulary, shared by the server, both frontends and the wire protocol.
 *
 * Nothing here does I/O and nothing here imports a runtime. That is deliberate: requirement 1.19
 * wants one core behind the desktop app, the web app and both presentations, and the way to get
 * that is for the core to be unable to reach a filesystem, a socket or a DOM.
 */

/**
 * A calendar date as `YYYY-MM-DD`, with no time and no zone.
 *
 * **This is the type a work entry is filed under** (2.18, 17.13). It is a date rather than an
 * instant because every question downstream is asked in dates: which month an entry belongs to
 * (7.10), which invoice period covers it (8.17), what a day's total is. Storing an instant would
 * force each of those to pick a timezone, and there is no single right one — the entry was made on
 * one device and may be read on another.
 *
 * The zone is used exactly once, at the moment of recording: the date is whatever the local
 * calendar said on the device that started the timer (2.19, 2.20). After that it is a fact.
 */
export type DateString = string;

/** `HH:MM` on a 24-hour clock, local to whichever device is reading it (6.38). */
export type TimeString = string;

/** Milliseconds since the Unix epoch. Used for instants, which are a different thing to dates. */
export type Instant = number;

/** Monday is 1 and Sunday is 7 — ISO 8601 numbering, which is what a schedule is written in. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * One stretch of work.
 *
 * **The duration is authoritative, not the timing.** A timed entry carries `timing` and a
 * duration-only entry does not (2.8, 2.9), but reporting and billing read `durationMs` either way
 * (2.13) — which is what makes converting between the two forms a matter of adding or dropping
 * `timing` rather than a different kind of record (2.12).
 */
export interface WorkEntry {
  id: string;
  /** 2.18 — the day this is filed under, whatever the clock did. */
  date: DateString;
  durationMs: number;
  /** 4.1 — becomes the invoice's "Description of work / expense" (4.2). */
  billingTag: string;
  /**
   * Absent for a duration-only entry. Present, and consistent with `durationMs`, for a timed one.
   * A session that crossed midnight still belongs to `date`, so `endedAt` may fall on the next day
   * (2.21).
   */
  timing?: { startedAt: Instant; endedAt: Instant };
}

/** The single globally-active timer (2.2), as the server sees it. */
export interface ActiveTimer {
  startedAt: Instant;
  /** Fixed when the timer started, from the starting device's local calendar (2.19, 2.20). */
  date: DateString;
  billingTag: string;
}

/**
 * One weekday's working hours, or `null` for a day that is not worked (6.21, 6.22).
 *
 * One interval, on purpose. It is an approximation of a working day and 21.16 says it should stay
 * one: a break makes the arithmetic exact and the configuration screen worse, and the number this
 * feeds is a projection.
 */
export type DayInterval = { start: TimeString; end: TimeString } | null;

/** Indexed by `Weekday`. */
export type WeeklySchedule = Readonly<Record<Weekday, DayInterval>>;

/** 6.19, 6.20 — a pacing-only adjustment, never a billable record. */
export interface PacingOverride {
  date: DateString;
  /** `null` turns a workday off (leave); an interval turns a non-workday on, or reshapes one. */
  interval: DayInterval;
  reason?: string;
}

/** One public holiday, already filtered to the configured region (6.31, 6.33). */
export interface Holiday {
  date: DateString;
  name: string;
}

export interface PacingConfig {
  /**
   * 6.1 — hours, not milliseconds; this is a number a person types.
   *
   * 27.31 — `null` until somebody sets one. There is no number of hours a month that is right for
   * a stranger, and a screen that reads "12h behind" against one they never chose is a lie with a
   * decimal point in it.
   */
  monthlyTargetHours: number | null;
  schedule: WeeklySchedule;
  /** 6.32 — an ISO 3166-2 subdivision code, or a country code for a nationwide set. */
  region: string;
}

export type InvoiceStatus = "draft" | "issued" | "paid";
