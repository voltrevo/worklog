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
import { MonthNav } from "./MonthNav.tsx";
import { today } from "@worklog/shared/dates";

export function Pacing() {
  const { snapshot, month, setMonth } = useStore();
  if (!snapshot) return <p className="muted">Loading…</p>;

  const p = snapshot.pacing;
  const paced = pace(p.paceHours);
  const now = today();

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row between wrap">
        <h1>Pacing</h1>
        <MonthNav month={month} setMonth={setMonth} />
      </div>

      {snapshot.holidayWarning && <div className="notice warn">{snapshot.holidayWarning}</div>}

      {
        /*
        24.17 — two figures, and nothing else.
        This card used to carry a heading saying "Projection" on the screen called Pacing, a
        paragraph explaining how the arithmetic works, and the target the projection was measured
        against. The heading and the target were noise; the paragraph is documentation and has gone
        to the README (24.18).
      */
      }
      <div className="card">
        <div className="row between wrap" style={{ alignItems: "flex-end" }}>
          <div
            className="huge"
            style={{ color: paced.tone === "bad" ? "var(--bad)" : undefined }}
          >
            {paced.text}
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="big tabular">{hours(p.projectedHours)}</div>
            <div className="muted">projected</div>
          </div>
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
          <Bar
            label="Worked"
            value={p.workedHours}
            of={p.monthlyTargetHours}
            hint="of the target"
            tone={paced.tone === "bad" ? "bad" : "good"}
          />
        </div>
      </div>

      <div
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
      >
        <Figure label="Worked so far" value={hours(p.workedHours)} />
        {/* 6.16, 6.17 — capacity and slack, so the target can be seen as achievable or not. */}
        <Figure
          label="Capacity this month"
          value={hours(p.capacityHours)}
          hint="every scheduled hour"
        />
        <Figure
          label="Slack"
          value={hours(p.slackHours)}
          hint={p.slackHours >= 0 ? "room above the target" : "the target exceeds the month"}
          tone={p.slackHours >= 0 ? undefined : "bad"}
        />
      </div>

      <div className="card">
        <h3>Days</h3>
        <div className="daygrid" style={{ marginTop: 10 }}>
          {p.days.map((d) => {
            const scheduled = d.remaining > 0 || d.actual > 0;
            const state = d.date > now
              ? "future"
              : d.actual > 0
              ? "worked"
              : scheduled
              ? "missed"
              : "off";
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
        <div
          className="row wrap faint"
          style={{ gap: 12, marginTop: 12, fontSize: 12 }}
        >
          <span>
            <i className="swatch worked" /> worked
          </span>
          <span>
            <i className="swatch missed" /> scheduled, nothing recorded
          </span>
          <span>
            <i className="swatch future" /> still to come
          </span>
          <span>
            <i className="swatch off" /> not a workday
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Pacing-day overrides (6.19, 6.20).
 *
 * **These are not work.** They live in their own table on the server precisely so that nothing
 * reporting or billing can pick them up, and the wording here says so: a day off changes what the
 * month is expected to hold, not what was done in it.
 *
 * An override outranks a public holiday, which is the point of "intentional weekend work" — a
 * holiday you have decided to work is the same case.
 */

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
