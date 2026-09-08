/**
 * The month picker, shared by History, Pacing and Invoices (24.14).
 *
 * **Nothing in here moves.** "This month" used to be rendered only when you were not on this
 * month, in a right-aligned row — so pressing ‹ made the button appear, the group grew leftward,
 * and ‹ slid out from under the pointer. Pressing back twice meant chasing the button.
 *
 * So the slot is always there and the button is only made invisible, which reserves its width. A
 * disabled button would also hold the space, but a permanently greyed control on three screens is
 * clutter for a state that is the common one.
 */

import { monthOf, shiftMonth, today } from "@worklog/shared/dates";
import { monthName } from "../format.ts";

export function MonthNav(
  { month, setMonth }: { month: string; setMonth: (m: string) => void },
) {
  const current = monthOf(today());
  const onCurrent = month === current;
  return (
    <div className="row month-nav">
      <button className="btn" type="button" onClick={() => setMonth(shiftMonth(month, -1))}>
        ‹
      </button>
      <strong className="month-name">{monthName(month)}</strong>
      <button className="btn" type="button" onClick={() => setMonth(shiftMonth(month, 1))}>
        ›
      </button>
      <button
        className="btn"
        type="button"
        // Hidden rather than absent: `visibility` keeps the width, `display: none` would give the
        // layout back and reintroduce exactly the jump this exists to prevent.
        style={{ visibility: onCurrent ? "hidden" : "visible" }}
        aria-hidden={onCurrent}
        tabIndex={onCurrent ? -1 : 0}
        onClick={() => setMonth(current)}
      >
        This month
      </button>
    </div>
  );
}
