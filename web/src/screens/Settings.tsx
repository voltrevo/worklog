/**
 * Configuration, and About (sections 6, 9, 18, 20).
 *
 * **Payment details are write-only here** (20.1, 20.3). The server never sends them back, so the
 * field shows whether something is set and offers to replace it, and cannot show what it is. That
 * is not a display choice — the value is not in the response.
 */

import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { today } from "@worklog/shared/dates";
import { INVOICE_LABELS, invoiceCssVars } from "@worklog/shared/invoiceLook";
import { useStore } from "../state.tsx";
import { hours, parseNumber } from "../format.ts";
import { AlwaysOnTopCard } from "./AlwaysOnTop.tsx";
import { LocalAudioCard } from "./LocalAudio.tsx";
import { WEEKDAY_NAMES } from "@worklog/shared/schedule";
import type { DayInterval, PacingConfig, Weekday } from "@worklog/shared/types";
import type { PublicInvoiceConfig } from "@worklog/shared/protocol";
import { Dialog } from "./Dialog.tsx";

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

  /**
   * 25.41 — what happened, and to which card.
   *
   * Both used to be booleans rendered at the top of the page, above the `<h1>`. Saving the prompt
   * interval at the bottom of a long screen therefore confirmed itself somewhere you could not
   * see, and — worse — inserted a line that pushed every card down by its height, so the button
   * you had just pressed moved out from under the pointer at the moment it succeeded.
   *
   * Kept by section so each card answers for itself, beside its own button, in a slot that is
   * always there.
   */
  type Section = "pacing" | "invoice" | "prompt";
  const [result, setResult] = useState<{ section: Section; problem?: string }>();

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
    setResult(undefined);
    try {
      await call({
        t: "config-set",
        section,
        value,
        clock: { today: today() },
      });
      setCfg(await call<ConfigWire>({ t: "config-get" }));
      await refresh();
      setResult({ section });
    } catch (err) {
      setResult({ section, problem: (err as Error).message });
    }
  };

  if (!cfg) return <p className="muted">Loading…</p>;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <h1>Settings</h1>

      <ScheduleCard
        cfg={cfg.pacing}
        canWrite={canWrite}
        save={save}
        result={result?.section === "pacing" ? result : undefined}
      />
      <InvoiceCard
        cfg={cfg.invoice}
        canWrite={canWrite}
        save={save}
        result={result?.section === "invoice" ? result : undefined}
      />
      <PromptCard
        cfg={cfg.prompt}
        canWrite={canWrite}
        save={save}
        result={result?.section === "prompt" ? result : undefined}
      />
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
              {phase.k === "ready" && (
                <>
                  v{phase.version} · connected to {
                    /*
                    A KPS address is `<ip>:<port>:<certhash>` — forty-odd unbroken characters with
                    nowhere for a line break to go, so on a phone it pushed this card to 557px in a
                    390px viewport and took the whole screen sideways with it. It was never seen
                    because the About card is below the fold and the screenshot stops at the fold.
                  */
                  }
                  <span className="breakable">{phase.address}</span>
                </>
              )}
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

/**
 * 25.41 — "Saved", where you pressed Save, without moving anything.
 *
 * The slot is always in the layout and only its contents change, which is the whole requirement:
 * a message that appears *between* the button and the pointer is a message that arrives by moving
 * the thing you were about to press again. `aria-live` so it is announced rather than only seen.
 *
 * A failure is a longer sentence and gets the line below, where the only thing it can push is the
 * bottom of the card.
 */
function SaveResult({ result }: { result?: { problem?: string } }) {
  return (
    <span
      className="saveresult"
      aria-live="polite"
      style={{ visibility: result && !result.problem ? "visible" : "hidden" }}
    >
      Saved
    </span>
  );
}

function SaveProblem({ result }: { result?: { problem?: string } }) {
  if (!result?.problem) return null;
  return <div className="notice bad" style={{ marginTop: 10 }}>{result.problem}</div>;
}

function ScheduleCard(
  { cfg, canWrite, save, result }: {
    cfg: PacingConfig;
    canWrite: boolean;
    save: (s: "pacing", v: Record<string, unknown>) => Promise<void>;
    result?: { problem?: string };
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
                    {
                      /*
                      Named, because the day is on the checkbox's label two elements away and
                      these are not inside it. Read aloud, ten of these announced themselves as
                      "time" and nothing else — no day, no idea which end of the interval.
                    */
                    }
                    <input
                      type="time"
                      value={interval.start}
                      disabled={!canWrite}
                      aria-label={`${WEEKDAY_NAMES[day]} starts at`}
                      onChange={(e) => setDay(day, { ...interval, start: e.target.value })}
                    />
                    <span className="faint">to</span>
                    <input
                      type="time"
                      value={interval.end}
                      disabled={!canWrite}
                      aria-label={`${WEEKDAY_NAMES[day]} ends at`}
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
        <SaveResult result={result} />
      </div>
      <SaveProblem result={result} />
      <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>
        The region is an ISO code like{" "}
        <span className="mono">AU-NSW</span>. Public holidays for it come from an updatable source,
        with a copy shipped in the build for when that is unreachable.
      </p>
    </div>
  );
}

function InvoiceCard(
  { cfg, canWrite, save, result }: {
    cfg: PublicInvoiceConfig;
    canWrite: boolean;
    save: (s: "invoice", v: Record<string, unknown>) => Promise<void>;
    result?: { problem?: string };
  },
) {
  /**
   * 25.42 — the address is not in `cfg` any more, and it is still editable here.
   *
   * `undefined` means "whatever is stored, unchanged", and an empty string means "cleared and
   * being retyped". The save below only sends it when it is a string, so opening this screen and
   * saving something unrelated cannot blank an address nobody touched.
   */
  type Draft = PublicInvoiceConfig & { fromAddress?: string };
  const [draft, setDraft] = useState<Draft>(cfg);
  const [pay, setPay] = useState({
    payMethod: "",
    payName: "",
    payBsb: "",
    payAccountNumber: "",
    payBank: "",
  });
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });

  /**
   * 25.43 — which hidden groups have been cleared for re-entry, in this sitting.
   *
   * Local, and never sent: clearing here only makes the boxes typeable. Nothing is destroyed on
   * the server unless something is typed and saved, so unlocking and changing your mind costs
   * nothing — which is what makes the dialog safe to press.
   */
  const [cleared, setCleared] = useState({ payment: false, address: false });
  const [unlocking, setUnlocking] = useState<"payment" | "address">();

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

  const paymentHidden = cfg.paymentDetailsSet && !cleared.payment;
  const secret = (k: keyof typeof pay) => ({
    value: pay[k],
    set: (v: string) => setPay({ ...pay, [k]: v }),
    can: canWrite,
    hidden: paymentHidden,
    onUnlock: () => setUnlocking("payment"),
  });

  /** A caption and the thing it captions, as a pair of cells in one of the sheet's grids. */
  const pair = (label: string, control: ReactNode) => (
    <>
      <span className="invsheet-label">{label}</span>
      {control}
    </>
  );

  /** A value the document works out for itself, highlighted where the document highlights it. */
  const derived = (what: string, highlighted?: boolean) => (
    <span className={highlighted ? "invsheet-derived invsheet-hi" : "invsheet-derived"}>
      {what}
    </span>
  );

  const columns = INVOICE_LABELS.columns;

  return (
    <div className="card">
      <h3>Invoice details</h3>
      {/* 20.9 — an unconfigured invoice says what it needs rather than printing something plausible. */}
      {missing.length > 0 && (
        <div className="notice warn" style={{ marginTop: 8 }}>
          An invoice still needs {missing.join(", ")}.
        </div>
      )}

      <div className="invsheet" style={invoiceCssVars() as CSSProperties}>
        <div className="invsheet-title">{INVOICE_LABELS.title}</div>

        <div className="invsheet-head">
          <div className="invsheet-pairs">
            {pair(
              INVOICE_LABELS.from.fromName,
              <Bare
                aria={INVOICE_LABELS.from.fromName}
                value={draft.fromName}
                set={(v) => set("fromName", v)}
                can={canWrite}
              />,
            )}
            {pair(
              INVOICE_LABELS.from.fromAddress,
              <BareMasked
                aria={INVOICE_LABELS.from.fromAddress}
                value={draft.fromAddress ?? ""}
                set={(v) => set("fromAddress", v)}
                can={canWrite}
                hidden={cfg.addressSet && !cleared.address}
                onUnlock={() => setUnlocking("address")}
                // 26.16 — an address prints on several lines and used to be typed into one box,
                // which turned every stored newline into nothing the moment anything was saved.
                lines={3}
              />,
            )}
            {pair(
              INVOICE_LABELS.from.fromPhone,
              <Bare
                aria={INVOICE_LABELS.from.fromPhone}
                value={draft.fromPhone}
                set={(v) => set("fromPhone", v)}
                can={canWrite}
              />,
            )}
            {pair(
              INVOICE_LABELS.from.fromEmail,
              <Bare
                aria={INVOICE_LABELS.from.fromEmail}
                value={draft.fromEmail}
                set={(v) => set("fromEmail", v)}
                can={canWrite}
              />,
            )}
            {pair(
              INVOICE_LABELS.from.fromAbn,
              <Bare
                aria={INVOICE_LABELS.from.fromAbn}
                value={draft.fromAbn}
                set={(v) => set("fromAbn", v)}
                can={canWrite}
              />,
            )}
          </div>

          {/* Top right on the document, and derived rather than configured. */}
          <div className="invsheet-pairs invsheet-identity">
            {pair(INVOICE_LABELS.identity.number, derived("from the period", true))}
            {pair(INVOICE_LABELS.identity.date, derived("the day it is issued", true))}
          </div>
        </div>

        <h4 className="invsheet-heading">{INVOICE_LABELS.billTo}</h4>
        <div className="invsheet-billto">
          <div className="invsheet-name">
            <Bare
              aria="Client name"
              value={draft.clientName}
              set={(v) => set("clientName", v)}
              can={canWrite}
            />
          </div>
          <BareArea
            aria="Client address"
            value={draft.clientAddress}
            set={(v) => set("clientAddress", v)}
            can={canWrite}
            lines={3}
          />
        </div>

        <div className="invsheet-period">
          <span className="invsheet-label">{INVOICE_LABELS.period}</span>
          {derived("the month being invoiced", true)}
        </div>

        <h4 className="invsheet-heading">{INVOICE_LABELS.workHeading}</h4>

        {
          /*
          8.19 — the bonus is its own little table above the work, with its own subtotal, and the
          only thing set here is which Team/Project it is filed under. That was a field captioned
          "Team / Project for the bonus row" sitting on its own below the table, which is the
          sentence you write when the layout cannot say it.
        */
        }
        <div className="invsheet-table">
          <div className="invsheet-tr head">
            {columns.map((c, i) => (
              <span key={c} className={i >= 3 ? "invsheet-td num" : "invsheet-td"}>{c}</span>
            ))}
          </div>
          <div className="invsheet-tr bonus body">
            <span className="invsheet-td" data-col={columns[0]}>{derived("the period")}</span>
            <span className="invsheet-td" data-col={columns[1]}>{derived("the bonus line")}</span>
            <span className="invsheet-td" data-col={columns[2]}>
              <Bare
                aria="Team / Project for the bonus row"
                value={draft.bonusTeamProject}
                set={(v) => set("bonusTeamProject", v)}
                can={canWrite}
              />
            </span>
            <span className="invsheet-td num blank" data-col={columns[3]}>—</span>
            <span className="invsheet-td num blank" data-col={columns[4]}>—</span>
            <span className="invsheet-td num" data-col={columns[5]}>{derived("the bonus")}</span>
          </div>
          <div className="invsheet-tr sum">
            <span className="invsheet-td blank" />
            <span className="invsheet-td blank" />
            <span className="invsheet-td blank" />
            <span className="invsheet-td blank" />
            <span className="invsheet-td blank" />
            {/* Captioned for the phone, where the row above it is no longer overhead. */}
            <span className="invsheet-td num" data-col={columns[5]}>{derived("the bonus")}</span>
          </div>
        </div>

        <div className="invsheet-table" style={{ marginTop: 18 }}>
          <div className="invsheet-tr head">
            {columns.map((c, i) => (
              <span key={c} className={i >= 3 ? "invsheet-td num" : "invsheet-td"}>{c}</span>
            ))}
          </div>
          <div className="invsheet-tr body">
            <span className="invsheet-td" data-col={columns[0]}>{derived("each day worked")}</span>
            <span className="invsheet-td" data-col={columns[1]}>{derived("the billing tag")}</span>
            <span className="invsheet-td" data-col={columns[2]}>
              <Bare
                aria="Default Team / Project"
                value={draft.teamProject}
                set={(v) => set("teamProject", v)}
                can={canWrite}
              />
            </span>
            <span className="invsheet-td num" data-col={columns[3]}>
              {derived("from the entries")}
            </span>
            <span className="invsheet-td num" data-col={columns[4]}>
              <BareNum
                aria="Hourly rate"
                value={(draft.rateMinor / 100).toFixed(2)}
                set={(n) => num("the hourly rate", n, (v) => set("rateMinor", Math.round(v * 100)))}
                can={canWrite}
              />
            </span>
            <span className="invsheet-td num" data-col={columns[5]}>
              {derived("hours × rate")}
            </span>
          </div>
          <div className="invsheet-tr sum">
            <span className="invsheet-td blank" />
            <span className="invsheet-td blank" />
            <span className="invsheet-td">{INVOICE_LABELS.rowTotal}</span>
            <span className="invsheet-td num" data-col={columns[3]}>{derived("total hours")}</span>
            <span className="invsheet-td blank" />
            <span className="invsheet-td num" data-col={columns[5]}>{derived("the work")}</span>
          </div>
        </div>

        <div className="invsheet-foot">
          {/* 8.28 — bottom left on the page. */}
          <div className="invsheet-pairs">
            {pair(
              INVOICE_LABELS.aside.currency,
              <Bare
                aria="Hourly rate in"
                value={draft.currency}
                set={(v) => set("currency", v)}
                can={canWrite}
              />,
            )}
            {pair(
              INVOICE_LABELS.aside.approver,
              <Bare
                aria="Work Approver"
                value={draft.approver}
                set={(v) => set("approver", v)}
                can={canWrite}
              />,
            )}
          </div>

          {/* 8.29 — and the stack on the right, of which only the tax row is configurable. */}
          <div className="invsheet-totals">
            <div className="invsheet-total hi">
              <span>{INVOICE_LABELS.subtotal}</span>
              {derived("from the lines")}
            </div>
            <div className="invsheet-total">
              <div className="invsheet-tax">
                <Bare
                  aria="Tax label"
                  value={draft.taxLabel}
                  set={(v) => set("taxLabel", v)}
                  can={canWrite}
                />
                <BareNum
                  aria="Tax rate, per cent"
                  value={String(Math.round(draft.taxRate * 1000) / 10)}
                  set={(n) => num("the tax rate", n, (v) => set("taxRate", v / 100))}
                  can={canWrite}
                />
              </div>
              {derived("of the sub-total")}
            </div>
            <div className="invsheet-total hi grand">
              <span>{INVOICE_LABELS.grandTotal}</span>
              {derived("sub-total plus tax")}
            </div>
          </div>
        </div>

        <h4 className="invsheet-heading">{INVOICE_LABELS.paymentHeading}</h4>
        {/* 8.30, 9.18 — labelled rows, because the format renders them as labelled rows. */}
        <div className="invsheet-pay">
          <div className="invsheet-pairs">
            {pair(
              INVOICE_LABELS.paymentMethod,
              <BareMasked aria="Payment method" {...secret("payMethod")} />,
            )}
            {pair(
              INVOICE_LABELS.account.payName,
              <BareMasked aria="Account name" {...secret("payName")} />,
            )}
            {pair(INVOICE_LABELS.account.payBsb, <BareMasked aria="BSB" {...secret("payBsb")} />)}
            {pair(
              INVOICE_LABELS.account.payAccountNumber,
              <BareMasked aria="Account number" {...secret("payAccountNumber")} />,
            )}
            {pair(
              INVOICE_LABELS.account.payBank,
              <BareMasked aria="Bank" {...secret("payBank")} />,
            )}
          </div>
          {
            /*
            8.32 — the note, which prints here in italics and has no caption on the document.
            It has none here either, for the same reason; an empty box beside the bank details
            with nothing to say for itself is what a placeholder is for.
          */
          }
          <div className="invsheet-note">
            <BareArea
              aria="Note under the totals"
              placeholder="an optional note, printed here in italics"
              value={draft.note}
              set={(v) => set("note", v)}
              can={canWrite}
              lines={2}
            />
          </div>
        </div>

        <div className="invsheet-due">
          <span className="invsheet-label">{INVOICE_LABELS.due}</span>
          {derived("four weeks after it is issued, then forward to a Monday", true)}
        </div>

        <p className="invsheet-secret">
          The payment details go on the invoice PDF and nowhere else, and the server never sends
          them back.
        </p>
      </div>

      {canWrite && (
        <button
          className="btn primary"
          type="button"
          style={{ marginTop: 14 }}
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
              // `paymentDetailsSet` and `addressSet` used to be blanked here by hand, because they
              // are derived flags from the read path and `setConfig` merged whatever it was given.
              // The server drops unknown keys now, which is where that belonged: one place, rather
              // than every caller remembering.
            })}
        >
          Save invoice details
        </button>
      )}
      <SaveResult result={result} />
      <SaveProblem result={result} />

      {/* 25.43 — what a masked field says when it is pressed. */}
      {unlocking && (
        <Dialog
          title={unlocking === "payment" ? "Payment details are stored" : "Your address is stored"}
          body={unlocking === "payment"
            ? "They are on the server and used to render the invoice, and they are never sent back to any device — including this one — so there is nothing to show you. Clearing these boxes lets you type new details; nothing changes until you save."
            : "It is on the server and printed on the invoice, and it is not sent back to any device, so there is nothing to show you. Clearing the box lets you type a new one; nothing changes until you save."}
          confirmLabel={unlocking === "payment" ? "Clear and re-enter" : "Clear and retype"}
          busy={false}
          onConfirm={() => {
            setCleared({ ...cleared, [unlocking]: true });
            if (unlocking === "address") set("fromAddress", "");
            setUnlocking(undefined);
          }}
          onCancel={() => setUnlocking(undefined)}
        />
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
  { cfg, canWrite, save, result }: {
    cfg: { meanIntervalMs: number; enabled: boolean };
    canWrite: boolean;
    save: (s: "prompt", v: Record<string, unknown>) => Promise<void>;
    result?: { problem?: string };
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
        <label className="checkfield">
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
        <SaveResult result={result} />
      </div>
      <SaveProblem result={result} />
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
  { label, value, set, can, width, unit, aria }: {
    label: string;
    /** The stored number as text — shown whenever the field is not being edited. */
    value: string;
    /** The parsed number, or `undefined` when the field does not hold one. */
    set: (n: number | undefined) => void;
    can: boolean;
    width?: number;
    unit?: string;
    /** As `Text`: the name, when the visible label belongs to a column instead. */
    aria?: string;
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
        aria-label={aria}
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

/**
 * 25.42, 25.43 — a value that is stored and hidden.
 *
 * The payment block used to be five empty boxes with a small green "set" chip on the heading three
 * lines away, and a paragraph underneath explaining that the boxes start empty even when the
 * details exist. Every part of that is a workaround for the field not being able to say anything
 * about itself: an empty box means "there is nothing here", the chip is somewhere else and covers
 * five fields at once, and the paragraph is the sentence you write when the interface cannot.
 *
 * A mask says it directly. Clicking it explains that the value is stored, cannot be shown, and can
 * be replaced — and clearing is per *group*, because "retype your bank details because you moved
 * house" is how a field ends up left wrong.
 */
const MASK = "••••••••";

/**
 * The document's caption as a control's name.
 *
 * `Postal address:` is what the page prints, colon and all, and the caption beside the field says
 * exactly that — but a name is not typography. Left in, a screen reader says "Postal address colon
 * edit text", and the mask button ends up called "Postal address: — stored and hidden".
 */
function named(caption: string): string {
  return caption.replace(/:$/, "");
}

function Bare(
  { aria, value, set, can }: {
    aria: string;
    value: string;
    set: (v: string) => void;
    can: boolean;
  },
) {
  return (
    <input
      value={value}
      disabled={!can}
      aria-label={named(aria)}
      onChange={(e) => set(e.target.value)}
    />
  );
}

/** For a value that prints on more than one line, which is every address on the document. */
function BareArea(
  { aria, value, set, can, lines, placeholder }: {
    aria: string;
    value: string;
    set: (v: string) => void;
    can: boolean;
    lines: number;
    placeholder?: string;
  },
) {
  return (
    <textarea
      value={value}
      rows={lines}
      disabled={!can}
      aria-label={named(aria)}
      placeholder={placeholder}
      onChange={(e) => set(e.target.value)}
    />
  );
}

function BareNum(
  { aria, value, set, can }: {
    aria: string;
    /** The stored number as text — shown whenever the field is not being edited. */
    value: string;
    /** The parsed number, or `undefined` when the field does not hold one. */
    set: (n: number | undefined) => void;
    can: boolean;
  },
) {
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const shown = typed ?? value;
  const bad = typed !== undefined && typed.trim() !== "" && parseNumber(typed) === undefined;
  return (
    <input
      value={shown}
      disabled={!can}
      inputMode="decimal"
      aria-label={named(aria)}
      aria-invalid={bad || undefined}
      className={bad ? "invalid" : undefined}
      onChange={(e) => {
        setTyped(e.target.value);
        set(parseNumber(e.target.value));
      }}
      onBlur={() => {
        if (typed !== undefined && parseNumber(typed) !== undefined) setTyped(undefined);
      }}
    />
  );
}

function BareMasked(
  { aria, value, set, can, hidden, onUnlock, lines }: {
    aria: string;
    value: string;
    set: (v: string) => void;
    can: boolean;
    /** True while the stored value is still in place and nothing new has been typed. */
    hidden: boolean;
    onUnlock: () => void;
    lines?: number;
  },
) {
  if (!hidden) {
    return lines
      ? <BareArea aria={aria} value={value} set={set} can={can} lines={lines} />
      : <Bare aria={aria} value={value} set={set} can={can} />;
  }
  return (
    <button
      type="button"
      className="maskfield"
      disabled={!can}
      onClick={onUnlock}
      aria-label={`${named(aria)} — stored and hidden`}
    >
      {MASK}
    </button>
  );
}
