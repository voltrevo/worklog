/**
 * Configuration, and About (sections 6, 9, 18, 20).
 *
 * **Payment details are write-only here** (20.1, 20.3). The server never sends them back, so the
 * field shows whether something is set and offers to replace it, and cannot show what it is. That
 * is not a display choice — the value is not in the response.
 */

import { useEffect, useState } from "react";
import { useStore } from "../state.tsx";
import { hours } from "../format.ts";
import { AlwaysOnTopCard } from "./AlwaysOnTop.tsx";
import { LocalAudioCard } from "./LocalAudio.tsx";
import { WEEKDAY_NAMES } from "@worklog/shared/schedule";
import type { DayInterval, PacingConfig, Weekday } from "@worklog/shared/types";

const REPO = "https://github.com/voltrevo/worklog";

/** Mirrors `publicInvoiceConfig` on the server: the payment block is not in it, by construction. */
interface PublicInvoiceConfig {
  fromName: string;
  fromAddress: string;
  fromEmail: string;
  fromAbn: string;
  fromPhone: string;
  clientName: string;
  clientAddress: string;
  currency: string;
  rateMinor: number;
  taxRate: number;
  taxLabel: string;
  approver: string;
  teamProject: string;
  bonusMinor: number;
  bonusTeamProject: string;
  note: string;
  paymentDetailsSet: boolean;
}

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

  const save = async (
    section: "pacing" | "invoice" | "prompt",
    value: Record<string, unknown>,
  ) => {
    await call({ t: "config-set", section, value });
    setCfg(await call<ConfigWire>({ t: "config-get" }));
    await refresh();
  };

  if (!cfg) return <p className="muted">Loading…</p>;

  return (
    <div className="stack" style={{ gap: 16 }}>
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
  const [target, setTarget] = useState(String(cfg.monthlyTargetHours));
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
            <div className="row" key={day}>
              <label className="row" style={{ width: 130, gap: 8 }}>
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
                  <>
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
                  </>
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
        <label className="field">
          Monthly target (hours)
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            disabled={!canWrite}
            style={{ width: 110 }}
          />
        </label>
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
            onClick={() =>
              void save("pacing", {
                schedule,
                monthlyTargetHours: Number(target) || 0,
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

  const missing = [
    !draft.fromName && "your name or trading name",
    !draft.clientName && "the client's name",
    draft.rateMinor <= 0 && "an hourly rate",
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
        <Text
          label="Hourly rate"
          value={(draft.rateMinor / 100).toFixed(2)}
          set={(v) => set("rateMinor", Math.round(Number(v) * 100) || 0)}
          can={canWrite}
        />
        <Text
          label="Tax label"
          value={draft.taxLabel}
          set={(v) => set("taxLabel", v)}
          can={canWrite}
        />
        <Text
          label="Tax rate (%)"
          value={String(Math.round(draft.taxRate * 1000) / 10)}
          set={(v) => set("taxRate", (Number(v) || 0) / 100)}
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
  const [minutes, setMinutes] = useState(
    String(Math.round(cfg.meanIntervalMs / 60_000)),
  );
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
        <label className="field">
          About every (minutes)
          <input
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            disabled={!canWrite}
            style={{ width: 90 }}
          />
        </label>
        {canWrite && (
          <button
            className="btn"
            type="button"
            onClick={() =>
              void save("prompt", {
                meanIntervalMs: (Number(minutes) || 45) * 60_000,
              })}
          >
            Save
          </button>
        )}
      </div>
    </div>
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
