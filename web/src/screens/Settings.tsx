/**
 * Configuration, and About (sections 6, 9, 18, 20).
 *
 * **Payment details are write-only here** (20.1, 20.3). The server never sends them back, so the
 * field shows whether something is set and offers to replace it, and cannot show what it is. That
 * is not a display choice — the value is not in the response.
 */

import { useEffect, useState } from "react";
import { today } from "@worklog/shared/dates";
import { useStore } from "../state.tsx";
import { hours, parseNumber } from "../format.ts";
import { AlwaysOnTopCard } from "./AlwaysOnTop.tsx";
import { LocalAudioCard } from "./LocalAudio.tsx";
import { WEEKDAY_NAMES } from "@worklog/shared/schedule";
import type { DayInterval, PacingConfig, Weekday } from "@worklog/shared/types";
import type { PublicInvoiceConfig } from "@worklog/shared/protocol";

const REPO = "https://github.com/voltrevo/worklog";

interface ConfigWire {
  pacing: PacingConfig;
  invoice: PublicInvoiceConfig;
  prompt: { meanIntervalMs: number; enabled: boolean };
}

export function Settings() {
  const { call, refresh, phase, forget } = useStore();
  const [cfg, setCfg] = useState<ConfigWire>();
  const canWrite = phase.k === "ready" && phase.role !== "read";

  /**
   * Loaded once, unlike History, Invoices and Admin, which follow the store's snapshot.
   *
   * This is the exception on purpose. Each card below seeds `useState` from what it is handed, so
   * re-fetching on every event would either leave the fields showing the old values while the
   * pills showed the new ones, or — if the cards were keyed to force a remount — throw away what
   * somebody was halfway through typing. An editing surface that is a minute stale is better than
   * one that overwrites the person using it.
   *
   * Saving reloads (see `save`), so this device is never wrong about its own edits.
   */
  useEffect(() => {
    void call<ConfigWire>({ t: "config-get" }).then(setCfg);
  }, [call]);

  const [problem, setProblem] = useState<string>();
  const [saved, setSaved] = useState(false);

  /**
   * 24.42 — a refusal has to be visible.
   *
   * The holiday region is now checked against the holiday source before it is stored, and a check
   * whose failure disappears into a promise is the free-text field it replaced. `clock` goes with
   * it so the year checked is the caller's, like every other dated request.
   */
  const save = async (
    section: "pacing" | "invoice" | "prompt",
    value: Record<string, unknown>,
  ) => {
    setProblem(undefined);
    setSaved(false);
    try {
      await call({
        t: "config-set",
        section,
        value,
        clock: { today: today() },
      });
      setCfg(await call<ConfigWire>({ t: "config-get" }));
      await refresh();
      setSaved(true);
    } catch (err) {
      setProblem((err as Error).message);
    }
  };

  if (!cfg) return <p className="muted">Loading…</p>;

  return (
    <div className="stack" style={{ gap: 16 }}>
      {problem && <div className="notice bad">{problem}</div>}
      {saved && !problem && <div className="notice good">Saved.</div>}
      <h1>Settings</h1>

      <ScheduleCard cfg={cfg.pacing} canWrite={canWrite} save={save} />
      <InvoiceCard cfg={cfg.invoice} canWrite={canWrite} save={save} />
      <PromptCard cfg={cfg.prompt} canWrite={canWrite} save={save} />
      {
        /* Section 14 — device-local, so it is not behind `canWrite`: a read-only device still gets
          to decide what its own speakers do. */
      }
      <LocalAudioCard />
      {/* 15.1, 15.5 — renders nothing outside the desktop window. */}
      <AlwaysOnTopCard />

      <div className="card">
        {/* 18.2, 18.3 */}
        <h3>About</h3>
        <div className="row between wrap" style={{ marginTop: 8 }}>
          <div>
            <h2>Worklog</h2>
            <p className="muted" style={{ margin: "4px 0 0" }}>
              Self-hosted work time tracking and invoicing.<br />
              {phase.k === "ready" && <>v{phase.version} · connected to {phase.address}</>}
            </p>
          </div>
          <div className="stack" style={{ gap: 6, alignItems: "flex-end" }}>
            {/* 18.4, 18.5 — build metadata, not invoice configuration (18.6). */}
            <a href={REPO} target="_blank" rel="noreferrer">View on GitHub</a>
            <a href={`${REPO}/issues/new`} target="_blank" rel="noreferrer">
              Report an issue
            </a>
          </div>
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          {/* 22.6 */}
          <button className="btn" type="button" onClick={forget}>
            Disconnect from this server
          </button>
        </div>
      </div>
    </div>
  );
}

function ScheduleCard(
  { cfg, canWrite, save }: {
    cfg: PacingConfig;
    canWrite: boolean;
    save: (s: "pacing", v: Record<string, unknown>) => Promise<void>;
  },
) {
  const [schedule, setSchedule] = useState(cfg.schedule);
  // The text is `Num`'s; what this holds is the number behind it, and `undefined` when the field
  // says something a number cannot be read out of (25.3).
  const [targetHours, setTargetHours] = useState<number | undefined>(
    cfg.monthlyTargetHours,
  );
  const target = String(targetHours ?? cfg.monthlyTargetHours);
  const [region, setRegion] = useState(cfg.region);

  const total = (Object.values(schedule) as DayInterval[]).reduce((t, i) => {
    if (!i) return t;
    const mins = (n: string) => Number(n.slice(0, 2)) * 60 + Number(n.slice(3, 5));
    return t + Math.max(0, mins(i.end) - mins(i.start)) / 60;
  }, 0);

  const setDay = (day: Weekday, interval: DayInterval) =>
    setSchedule({ ...schedule, [day]: interval });

  return (
    <div className="card">
      <h3>Working hours</h3>
      <p className="muted" style={{ margin: "4px 0 12px", maxWidth: 620 }}>
        One interval per weekday — an approximation, on purpose. It decides which days are workdays,
        how many hours each is worth, and how much of today is still ahead, which is what makes the
        pace on the timer screen move as the day goes rather than stepping at midnight.
      </p>

      <div className="stack" style={{ gap: 6 }}>
        {([1, 2, 3, 4, 5, 6, 7] as Weekday[]).map((day) => {
          const interval = schedule[day];
          return (
            <div className="dayrow" key={day}>
              <label className="row dayname">
                <input
                  type="checkbox"
                  checked={interval !== null}
                  disabled={!canWrite}
                  onChange={(e) =>
                    setDay(
                      day,
                      e.target.checked ? { start: "09:00", end: "17:00" } : null,
                    )}
                />
                {WEEKDAY_NAMES[day]}
              </label>
              {interval
                ? (
                  // One element holding the pair, rather than three loose grid children. Leaving
                  // them loose meant their placement depended on the parent's column count, which
                  // differs between the two presentations — and on a phone the second input landed
                  // on a row of its own.
                  <div className="daytimes">
                    <input
                      type="time"
                      value={interval.start}
                      disabled={!canWrite}
                      onChange={(e) => setDay(day, { ...interval, start: e.target.value })}
                    />
                    <span className="faint">to</span>
                    <input
                      type="time"
                      value={interval.end}
                      disabled={!canWrite}
                      onChange={(e) => setDay(day, { ...interval, end: e.target.value })}
                    />
                  </div>
                )
                : <span className="faint">not a workday</span>}
            </div>
          );
        })}
      </div>

      <div
        className="row wrap"
        style={{ marginTop: 16, alignItems: "flex-end" }}
      >
        <Num
          label="Monthly target (hours)"
          value={target}
          set={setTargetHours}
          can={canWrite}
          width={130}
        />
        <label className="field">
          Holiday region
          <input
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            disabled={!canWrite}
            style={{ width: 130 }}
          />
        </label>
        <div className="field">
          A full week
          <div className="big tabular" style={{ fontSize: 18 }}>
            {hours(total)}
          </div>
        </div>
        {canWrite && (
          <button
            className="btn primary"
            type="button"
            disabled={targetHours === undefined}
            title={targetHours === undefined ? "The monthly target is not a number." : undefined}
            onClick={() =>
              void save("pacing", {
                schedule,
                monthlyTargetHours: targetHours!,
                region: region.trim().toUpperCase(),
              })}
          >
            Save
          </button>
        )}
      </div>
      <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>
        The region is an ISO code like{" "}
        <span className="mono">AU-NSW</span>. Public holidays for it come from an updatable source,
        with a copy shipped in the build for when that is unreachable.
      </p>
    </div>
  );
}

function InvoiceCard(
  { cfg, canWrite, save }: {
    cfg: PublicInvoiceConfig;
    canWrite: boolean;
    save: (s: "invoice", v: Record<string, unknown>) => Promise<void>;
  },
) {
  const [draft, setDraft] = useState(cfg);
  const [pay, setPay] = useState({
    payMethod: "",
    payName: "",
    payBsb: "",
    payAccountNumber: "",
    payBank: "",
  });
  const set = <K extends keyof PublicInvoiceConfig>(
    k: K,
    v: PublicInvoiceConfig[K],
  ) => setDraft({ ...draft, [k]: v });

  // 25.3 — a field holding text that is not a number leaves the last good value in the draft, so
  // without this the Save button would happily write it back and the typo would vanish unnoticed.
  // Named rather than counted, because "one field is wrong" is not enough to go on.
  const [unreadable, setUnreadable] = useState<string[]>([]);
  const num = (
    name: string,
    n: number | undefined,
    apply: (v: number) => void,
  ) => {
    setUnreadable((prev) =>
      n === undefined
        ? (prev.includes(name) ? prev : [...prev, name])
        : prev.filter((x) => x !== name)
    );
    if (n !== undefined) apply(n);
  };

  const missing = [
    !draft.fromName && "your name or trading name",
    !draft.clientName && "the client's name",
    draft.rateMinor <= 0 && !unreadable.includes("the hourly rate") &&
    "an hourly rate",
    !cfg.paymentDetailsSet && !pay.payAccountNumber && "payment details",
  ].filter(Boolean) as string[];

  return (
    <div className="card">
      <h3>Invoice details</h3>
      {/* 20.9 — an unconfigured invoice says what it needs rather than printing something plausible. */}
      {missing.length > 0 && (
        <div className="notice warn" style={{ marginTop: 8 }}>
          An invoice still needs {missing.join(", ")}.
        </div>
      )}

      <div
        className="grid"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          marginTop: 12,
        }}
      >
        <Text
          label="Your name"
          value={draft.fromName}
          set={(v) => set("fromName", v)}
          can={canWrite}
        />
        <Text
          label="Your ABN"
          value={draft.fromAbn}
          set={(v) => set("fromAbn", v)}
          can={canWrite}
        />
        <Text
          label="Your email"
          value={draft.fromEmail}
          set={(v) => set("fromEmail", v)}
          can={canWrite}
        />
        <Text
          label="Your address"
          value={draft.fromAddress}
          set={(v) => set("fromAddress", v)}
          can={canWrite}
        />
        <Text
          label="Client name"
          value={draft.clientName}
          set={(v) => set("clientName", v)}
          can={canWrite}
        />
        <Text
          label="Client address"
          value={draft.clientAddress}
          set={(v) => set("clientAddress", v)}
          can={canWrite}
        />
        <Text
          label="Currency"
          value={draft.currency}
          set={(v) => set("currency", v)}
          can={canWrite}
        />
        <Num
          label="Hourly rate"
          value={(draft.rateMinor / 100).toFixed(2)}
          set={(n) => num("the hourly rate", n, (v) => set("rateMinor", Math.round(v * 100)))}
          can={canWrite}
        />
        <Text
          label="Tax label"
          value={draft.taxLabel}
          set={(v) => set("taxLabel", v)}
          can={canWrite}
        />
        <Num
          label="Tax rate (%)"
          value={String(Math.round(draft.taxRate * 1000) / 10)}
          set={(n) => num("the tax rate", n, (v) => set("taxRate", v / 100))}
          can={canWrite}
        />
        <Text
          label="Work approver"
          value={draft.approver}
          set={(v) => set("approver", v)}
          can={canWrite}
        />
        <Text
          label="Default Team / Project"
          value={draft.teamProject}
          set={(v) => set("teamProject", v)}
          can={canWrite}
        />
        <Text
          label="Team / Project for the bonus row"
          value={draft.bonusTeamProject}
          set={(v) => set("bonusTeamProject", v)}
          can={canWrite}
        />
        <Text
          label="Note under the totals"
          value={draft.note}
          set={(v) => set("note", v)}
          can={canWrite}
        />
      </div>

      {/* 8.30, 9.18 -- labelled fields, because the format renders them as labelled rows. */}
      <h3 style={{ marginTop: 20 }}>
        Method of payment {cfg.paymentDetailsSet && <span className="pill good">set</span>}
      </h3>
      <div
        className="grid"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          marginTop: 8,
        }}
      >
        <Text
          label="Payment method"
          value={pay.payMethod}
          set={(v) => setPay({ ...pay, payMethod: v })}
          can={canWrite}
        />
        <Text
          label="Account name"
          value={pay.payName}
          set={(v) => setPay({ ...pay, payName: v })}
          can={canWrite}
        />
        <Text
          label="BSB"
          value={pay.payBsb}
          set={(v) => setPay({ ...pay, payBsb: v })}
          can={canWrite}
        />
        <Text
          label="Account number"
          value={pay.payAccountNumber}
          set={(v) => setPay({ ...pay, payAccountNumber: v })}
          can={canWrite}
        />
        <Text
          label="Bank"
          value={pay.payBank}
          set={(v) => setPay({ ...pay, payBank: v })}
          can={canWrite}
        />
      </div>
      <p className="faint" style={{ fontSize: 12 }}>
        These go on the invoice PDF and nowhere else. The server never sends them back, so these
        boxes start empty even when details are already set — filling one in replaces it, and
        leaving them all blank changes nothing.
      </p>

      {canWrite && (
        <button
          className="btn primary"
          type="button"
          // 25.2 -- the button stays, and says why it will not go. Removing it would leave the
          // screen looking read-only for what is really one mistyped character.
          disabled={unreadable.length > 0}
          title={unreadable.length > 0 ? `Fix ${unreadable.join(" and ")} first.` : undefined}
          onClick={() =>
            void save("invoice", {
              ...draft,
              // Only send a payment field that was actually typed; an empty box means "leave it".
              ...Object.fromEntries(
                Object.entries(pay).filter(([, v]) => v !== ""),
              ),
              paymentDetailsSet: undefined,
            })}
        >
          Save invoice details
        </button>
      )}
      {unreadable.length > 0 && (
        <div className="notice bad" style={{ marginTop: 8 }}>
          {unreadable.join(" and ")} {unreadable.length > 1 ? "are" : "is"}{" "}
          not a number, so nothing here can be saved yet.
        </div>
      )}
    </div>
  );
}

function PromptCard(
  { cfg, canWrite, save }: {
    cfg: { meanIntervalMs: number; enabled: boolean };
    canWrite: boolean;
    save: (s: "prompt", v: Record<string, unknown>) => Promise<void>;
  },
) {
  const stored = Math.round(cfg.meanIntervalMs / 60_000);
  const [minutes, setMinutes] = useState<number | undefined>(stored);
  return (
    <div className="card">
      <h3>Work-detail prompts</h3>
      <p className="muted" style={{ margin: "4px 0 12px", maxWidth: 620 }}>
        While a timer is running the server can ask, at random, what you are working on. It is a
        genuine coin flip every ten seconds rather than a countdown, so the gaps vary and nothing is
        owed to you when the timer stops.
      </p>
      <div className="row wrap" style={{ alignItems: "flex-end" }}>
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={cfg.enabled}
            disabled={!canWrite}
            onChange={(e) => void save("prompt", { enabled: e.target.checked })}
          />
          Ask me sometimes
        </label>
        <Num
          label="About every (minutes)"
          value={String(minutes ?? stored)}
          set={setMinutes}
          can={canWrite}
          width={110}
        />
        {canWrite && (
          <button
            className="btn"
            type="button"
            // It used to fall back to 45 when this did not parse, which is a number nobody chose
            // arriving on the server as though they had.
            disabled={minutes === undefined}
            title={minutes === undefined ? "The interval is not a number." : undefined}
            onClick={() =>
              void save("prompt", {
                meanIntervalMs: minutes! * 60_000,
              })}
          >
            Save
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A number field that does not rewrite what you are typing (25.44), and does not quietly invent a
 * number you did not (25.3).
 *
 * The hourly rate was `value={(rateMinor / 100).toFixed(2)}` with the parse in `onChange`, so every
 * keystroke went out through the model and came back formatted. Typing `1` gave you `1.00` with the
 * caret past the end, and the only way to reach that `1` again was to select the whole field; `12`
 * had to be typed as `1`, select-all, `12`. It was unusable, and it looked like a bug in the
 * keyboard rather than in this file.
 *
 * The fix is that the text belongs to the field while you are in it. `typed` being set means the
 * field is yours; `undefined` means it follows the stored value, which is what lets a save from
 * another device land in a box you are not currently typing in. Leaving with something parseable
 * hands it back, and *that* is when the canonical formatting appears.
 *
 * Unparseable text is kept, said out loud, and reported upward as `undefined` so the card can
 * refuse to save. It is deliberately not snapped back to the last good value: silently discarding
 * what somebody typed is the other half of the same fault.
 */
function Num(
  { label, value, set, can, width, unit }: {
    label: string;
    /** The stored number as text — shown whenever the field is not being edited. */
    value: string;
    /** The parsed number, or `undefined` when the field does not hold one. */
    set: (n: number | undefined) => void;
    can: boolean;
    width?: number;
    unit?: string;
  },
) {
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const shown = typed ?? value;
  // Empty is not an error to shout about — it is a field you are half way through clearing, and
  // the card's own "still needs" notice covers a value that never arrives.
  const bad = typed !== undefined && typed.trim() !== "" &&
    parseNumber(typed) === undefined;

  return (
    <label className="field">
      {label}
      <input
        value={shown}
        disabled={!can}
        inputMode="decimal"
        aria-invalid={bad || undefined}
        className={bad ? "invalid" : undefined}
        style={width ? { width } : undefined}
        onChange={(e) => {
          setTyped(e.target.value);
          set(parseNumber(e.target.value));
        }}
        onBlur={() => {
          if (
            typed !== undefined && parseNumber(typed) !== undefined
          ) setTyped(undefined);
        }}
      />
      {bad
        ? <span className="field-note bad">not a number</span>
        : unit
        ? <span className="field-note faint">{unit}</span>
        : null}
    </label>
  );
}

function Text(
  { label, value, set, can }: {
    label: string;
    value: string;
    set: (v: string) => void;
    can: boolean;
  },
) {
  return (
    <label className="field">
      {label}
      <input
        value={value}
        disabled={!can}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );
}
