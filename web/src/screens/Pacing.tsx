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
import { hours, monthName, pace, shortDate } from "../format.ts";
import { shiftMonth, today } from "@worklog/shared/dates";

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
        <div className="row">
          <button
            className="btn"
            type="button"
            onClick={() => setMonth(shiftMonth(month, -1))}
          >
            ‹
          </button>
          <strong style={{ minWidth: 150, textAlign: "center" }}>
            {monthName(month)}
          </strong>
          <button
            className="btn"
            type="button"
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            ›
          </button>
        </div>
      </div>

      {snapshot.holidayWarning && <div className="notice warn">{snapshot.holidayWarning}</div>}

      <div className="card">
        <h3>Projection</h3>
        <div
          className="row between wrap"
          style={{ alignItems: "flex-end", marginTop: 4 }}
        >
          <div>
            <div
              className="huge"
              style={{ color: paced.tone === "bad" ? "var(--bad)" : undefined }}
            >
              {paced.text}
            </div>
            <p className="muted" style={{ margin: "6px 0 0", maxWidth: 460 }}>
              Assuming you work the rest of today's scheduled hours and every remaining workday in
              full. It moves as the day passes, so sitting idle through a scheduled morning shows up
              now rather than at midnight.
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="big tabular">{hours(p.projectedHours)}</div>
            <div className="muted">
              projected, against {hours(p.monthlyTargetHours)}
            </div>
          </div>
        </div>
      </div>

      <div
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
      >
        <Figure label="Worked so far" value={hours(p.workedHours)} />
        <Figure label="Monthly target" value={hours(p.monthlyTargetHours)} />
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
        <h3>How the projection adds up</h3>
        <div className="scroll-x">
          <table>
            <tbody>
              <Term label="Worked before today" value={p.actualBeforeToday} />
              <Term
                label="Today: worked, plus the interval still ahead"
                value={p.todayContribution}
              />
              <Term
                label="Scheduled hours on the workdays still to come"
                value={p.remainingWorkdayHours}
              />
              {p.actualAfterToday > 0 && (
                <Term
                  label="Work already recorded on a future date"
                  value={p.actualAfterToday}
                />
              )}
              <tr>
                <td style={{ fontWeight: 700 }}>Projected</td>
                <td
                  className="tabular"
                  style={{ textAlign: "right", fontWeight: 700 }}
                >
                  {hours(p.projectedHours)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* 6.37 — the holidays this month's arithmetic used, so a wrong one is visible. */}
      <div className="card">
        <h3>Public holidays used</h3>
        {p.holidays.length === 0
          ? (
            <p className="muted" style={{ margin: "8px 0 0" }}>
              None in {monthName(month)} for {snapshot.pacingConfig.region}.
            </p>
          )
          : (
            <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              {p.holidays.map((h) => (
                <li key={`${h.date}-${h.name}`}>
                  <span className="tabular">{shortDate(h.date)}</span> — {h.name}
                </li>
              ))}
            </ul>
          )}
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

function Term({ label, value }: { label: string; value: number }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="tabular" style={{ textAlign: "right" }}>{hours(value)}</td>
    </tr>
  );
}
