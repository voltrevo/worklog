/**
 * Where the month is going, and why (section 6).
 *
 * **It shows its working.** A pace figure on its own is a number to be believed or not; 6.18 asks
 * for the capacity and slack behind it and 6.37 for the holidays that shaped it, and both are here
 * because the failure this guards against is a wrong holiday quietly moving the target by a day.
 *
 * The projection's four terms are shown adding up, for the same reason — if the arithmetic is
 * visible, a bug in it is visible too.
 */

import { useStore } from "../state.tsx";
import { hours, pace } from "../format.ts";
import { formatDay } from "@worklog/shared/dates";
import { MonthNav } from "./MonthNav.tsx";
import { useNav } from "../App.tsx";
import type { DayPacing } from "@worklog/shared/pacing";

/**
 * A day's state, and the order the questions are asked in.
 *
 * Four states, asked in the order that makes each of them reachable. This asked "is it in the
 * future" first, and that answer won over "is it a workday at all" — so a Saturday three weeks out
 * was drawn as a day still to fill. Worse, it decided "scheduled" from `remaining > 0 || actual >
 * 0`, and a past workday with nothing recorded has neither: the red state, the one thing a pacing
 * screen exists to point at, could not be reached by any day at all.
 *
 * `d.scheduled` is the day's own hours and answers the workday question directly. `d.remaining`
 * then separates "there is still time" from "the day is over" without needing today's date: a
 * future day has all its hours left, this afternoon has some, and a day that has ended has none.
 *
 * **27.17 — a holiday is its own thing**, not merely a day that is not a workday. It came out as
 * "not a workday", indistinguishable from a Sunday, so a month with four fewer working hours in it
 * looked exactly like one without — and the reason the capacity had moved was nowhere on the
 * screen that shows the capacity. Above `scheduled === 0` because that is what a holiday makes it:
 * the more specific answer to the same question.
 */
type DayState = "worked" | "holiday" | "off" | "future" | "missed";

function dayState(d: DayPacing): DayState {
  return d.actual > 0
    ? "worked"
    : d.holiday
    ? "holiday"
    : d.scheduled === 0
    ? "off"
    : d.remaining > 0
    ? "future"
    : "missed";
}

/** In the order they are explained, which is roughly the order they matter. */
const LEGEND: [DayState, string][] = [
  ["worked", "worked"],
  ["missed", "scheduled, nothing recorded"],
  ["future", "still to come"],
  ["off", "not a workday"],
  ["holiday", "a public holiday"],
];

export function Pacing() {
  const { snapshot, month, setMonth } = useStore();
  const go = useNav();
  if (!snapshot) return <p className="muted">Loading…</p>;

  const p = snapshot.pacing;
  /*
   * 27.31 — with no monthly target there is no ahead or behind, and the screen says that instead
   * of picking one of the two available lies ("on target", or "behind by everything").
   */
  const paced = p.paceHours === null ? undefined : pace(p.paceHours);
  /*
   * One walk, giving the squares and the legend both (27.32). A second pass to work out which
   * states occur would be a second copy of `dayState`, and the two would disagree the next time
   * one of them changed.
   */
  const days = p.days.map((day) => ({ day, state: dayState(day) }));
  const present = new Set(days.map((d) => d.state));

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row between wrap">
        <h1>Pacing</h1>
        <MonthNav month={month} setMonth={setMonth} />
      </div>

      {snapshot.holidayWarning && <div className="notice warn">{snapshot.holidayWarning}</div>}

      {
        /*
         * 27.32 — an empty week says so, once, rather than through a screen of zeroes.
         *
         * Every figure below reads nought with no schedule, which is true and unhelpful: it looks
         * the same as a month that happens to be entirely holidays. This is the difference, and it
         * is the only place on the screen that can state it.
         */
      }
      {!p.scheduleSet && (
        <div className="notice">
          No working hours are set, so nothing is scheduled and there is no capacity to pace
          against.{" "}
          <button className="link" type="button" onClick={() => go("settings")}>
            Set your working hours
          </button>
        </div>
      )}

      {
        /*
        24.17 — two figures, and nothing else.
        This card used to carry a heading saying "Projection" on the screen called Pacing, a
        paragraph explaining how the arithmetic works, and the target the projection was measured
        against. The heading and the target were noise; the paragraph is documentation and has gone
        to the README (24.18).
      */
      }
      {
        /*
         * 27.32 — no schedule, no projection card.
         *
         * Every number in it is derived from the week: the projection is worked-plus-remaining and
         * remaining is nought, so it restates "worked so far" in bigger type; the bar is 0.0h of
         * 0.0h. A card of true zeroes is still a card asking to be read, and there is nothing in
         * it. What is left below — what has been worked, and which days it went on — is the whole
         * of what this screen knows before somebody sets their hours.
         */
      }
      {p.scheduleSet && (
        <div className="card">
          <div className="row between wrap" style={{ alignItems: "flex-end" }}>
            {/* 24.40 — the figure is unchanged: projected month total against the target. */}
            {
              /*
               * 27.31 — with a target the headline is the comparison; without one it is the
               * projection, which is the largest true thing this screen knows. Making the *absence*
               * the biggest words on the page says the screen is broken, when what is missing is one
               * number and the rest of it works.
               */
            }
            {paced
              ? (
                <div
                  className="huge"
                  style={{ color: paced.tone === "bad" ? "var(--bad)" : undefined }}
                >
                  {paced.text}
                </div>
              )
              : (
                <div className="stack" style={{ gap: 2 }}>
                  <div className="huge">{hours(p.projectedHours)}</div>
                  <div className="muted">
                    projected — no monthly target, so nothing to be ahead or behind of.{" "}
                    <button className="link" type="button" onClick={() => go("settings")}>
                      Set one
                    </button>
                  </div>
                </div>
              )}
            {/* Not repeated when it is already the headline. */}
            {paced && (
              <div style={{ textAlign: "right" }}>
                <div className="big tabular">{hours(p.projectedHours)}</div>
                <div className="muted">projected</div>
              </div>
            )}
          </div>

          {
            /*
          24.41 — the same comparison, as two bars.
          The top bar is how much of the month's *working* time has gone; the bottom is how much of
          the target has been done. Ahead or behind is the offset between them, which is a thing
          you can see without a number that has to open the month negative to make sense.
        */
          }
          <div className="bars" style={{ marginTop: 18 }}>
            <Bar
              label="Month elapsed"
              value={p.elapsedScheduledHours}
              of={p.capacityHours}
              hint="of the scheduled hours"
            />
            {
              /* No target, no second bar: a bar needs something to be a proportion *of*, and the
               month's capacity is already the bar above it. */
            }
            {p.monthlyTargetHours !== null && (
              <Bar
                label="Worked"
                value={p.workedHours}
                of={p.monthlyTargetHours}
                hint="of the target"
                tone={paced?.tone === "bad" ? "bad" : "good"}
              />
            )}
          </div>
        </div>
      )}

      <div
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
      >
        <Figure label="Worked so far" value={hours(p.workedHours)} />
        {/* 6.16, 6.17 — capacity and slack, so the target can be seen as achievable or not. */}
        {p.scheduleSet && (
          <Figure
            label="Capacity this month"
            value={hours(p.capacityHours)}
            hint="every scheduled hour"
          />
        )}
        {p.slackHours !== null && (
          <Figure
            label="Slack"
            value={hours(p.slackHours)}
            hint={p.slackHours >= 0 ? "room above the target" : "the target exceeds the month"}
            tone={p.slackHours >= 0 ? undefined : "bad"}
          />
        )}
      </div>

      <div className="card">
        {/* 24.24 — kept: the one thing on this screen nobody asked to change. */}
        <h3>Days</h3>
        <div className="daygrid" style={{ marginTop: 10 }}>
          {days.map(({ day: d, state }) => {
            return (
              <div
                key={d.date}
                className={`day ${state}`}
                title={`${d.date}: ${hours(d.actual)} worked${
                  d.holiday ? ` — ${d.holiday.name}` : ""
                }`}
              >
                <span className="n">{Number(d.date.slice(8))}</span>
              </div>
            );
          })}
        </div>
        {
          /*
           * 27.32 — only the states this month actually contains.
           *
           * A fixed list of five explains four things that are not on the grid. It reads worst in
           * the state this change created: with no working hours set, every square is the same
           * one, and a legend naming "scheduled, nothing recorded" and "still to come" describes a
           * screen somebody else is looking at.
           */
        }
        <div
          className="row wrap faint"
          style={{ gap: 12, marginTop: 12, fontSize: 12 }}
        >
          {LEGEND.filter(([state]) => present.has(state)).map(([state, said]) => (
            <span key={state}>
              <i className={`swatch ${state}`} /> {
                /* "Not a workday" is a claim about a week. Without one, all it can say is that
                  nothing is scheduled — which is the same square and a different fact. */
              }
              {state === "off" && !p.scheduleSet ? "nothing scheduled" : said}
            </span>
          ))}
        </div>

        {
          /*
           * 27.17, 6.37 — and which ones they were.
           *
           * The capacity on this screen is workdays minus holidays, and until now the holidays
           * were only a subtraction: no way to see whether the region is right, whether the day
           * you were thinking of is in the list, or why a month is short. A wrong region is the
           * most likely thing to be wrong here, and this is the one place it shows.
           */
        }
        {p.holidays.length > 0 && (
          <div className="holidaylist">
            {p.holidays.map((h) => (
              <div key={h.date} className="row" style={{ gap: 10 }}>
                <span className="tabular faint" style={{ minWidth: "6.5rem" }}>
                  {formatDay(h.date)}
                </span>
                <span>{h.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Figure(
  { label, value, hint, tone }: {
    label: string;
    value: string;
    hint?: string;
    tone?: "bad";
  },
) {
  return (
    <div className="card" style={{ margin: 0 }}>
      <h3>{label}</h3>
      <div
        className="big tabular"
        style={{ color: tone === "bad" ? "var(--bad)" : undefined }}
      >
        {value}
      </div>
      {hint && <div className="faint" style={{ fontSize: 12 }}>{hint}</div>}
    </div>
  );
}

/**
 * One progress bar (24.41).
 *
 * Deliberately not clamped in the label: going past the target is a real and good outcome, and a
 * bar reading "168h of 160h" while pinned at full width says that better than a bar that stops at
 * a hundred percent and a number that quietly stops counting. Only the *fill* is clamped, because
 * a div wider than its parent is not a design.
 */
function Bar(
  { label, value, of, hint, tone }: {
    label: string;
    value: number;
    of: number;
    hint: string;
    tone?: "good" | "bad";
  },
) {
  const fraction = of > 0 ? value / of : 0;
  return (
    <div className="barline">
      <span className="barlabel">{label}</span>
      <span className="bar">
        <span
          className={tone ?? ""}
          style={{ width: `${Math.min(100, Math.max(0, fraction * 100))}%` }}
        />
      </span>
      <span className="tabular figure">{hours(value)}</span>
      <span className="faint days">
        of {hours(of)} {hint}
      </span>
    </div>
  );
}
