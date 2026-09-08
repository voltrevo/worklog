/**
 * The part of `Temporal` this app uses, declared because TypeScript's libs do not have it yet.
 *
 * It is present at runtime — Deno has it behind one unstable flag and Chromium ships it — so this
 * is a types-only gap, not a capability one. Declaring the handful of members `shared/dates.ts`
 * touches, rather than pulling in a polyfill, keeps the shipped bundle free of a second date
 * implementation and makes the surface we depend on explicit: if this file has to grow, that is
 * worth noticing.
 */

declare namespace Temporal {
  interface PlainDateLike {
    readonly dayOfWeek: number;
    readonly daysInMonth: number;
    add(
      duration: { days?: number; weeks?: number; months?: number },
    ): PlainDateLike;
    toString(): string;
  }

  interface PlainYearMonthLike {
    add(duration: { months?: number }): PlainYearMonthLike;
    toString(): string;
  }

  interface PlainTimeLike {
    readonly hour: number;
    readonly minute: number;
    readonly second: number;
  }

  const PlainDate: { from(value: string): PlainDateLike };
  const PlainYearMonth: { from(value: string): PlainYearMonthLike };

  namespace Now {
    function plainDateISO(): PlainDateLike;
    function plainTimeISO(): PlainTimeLike;
  }
}
