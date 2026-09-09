/**
 * Device access and the server log (19.12, 19.13, sections 12 and 13).
 *
 * **The approve control asks for a role rather than accepting the one that was requested** (13.28).
 * A one-tap Approve next to "requested: admin" is a button that grants admin, and the request is
 * a string an unauthorized device chose. The role is picked here, by the person approving.
 */

import { useEffect, useState } from "react";
import { useStore } from "../state.tsx";
import { usePresentation } from "../App.tsx";
import { dateTime } from "../format.ts";
import type { AccessRole } from "@worklog/shared/auth";
import type { LogEntry, LogLevel } from "@worklog/shared/protocol";
import { Dialog } from "./Dialog.tsx";
import { Listing } from "./Listing.tsx";

interface PendingWire {
  publicKey: string;
  name: string;
  requestedRole: AccessRole;
  requestedAt: number;
  fingerprint: string;
}

interface DeviceWire {
  publicKey: string;
  name: string;
  role: AccessRole;
  authorizedAt: number;
  lastSeenAt?: number;
}

/**
 * 25.32 — approve or deny, and approving grants what was asked for.
 *
 * There used to be three buttons — read, write, admin — and a Deny, on the reasoning that the
 * requested role is a string an unauthorized device chose and so must not be honoured with one
 * tap. That reasoning survives: the role is still granted only by an admin pressing a button
 * (13.28). What did not survive is the shape. Four controls on every row makes the common case —
 * "yes, that one" — indistinguishable from the rare one, and puts *admin* one mis-aimed tap from
 * a stranger's request. A wrong request is denied, and asked again.
 *
 * One component, used by the stacked layout and the table both. They each had their own copy of
 * this and each would have had to be changed.
 */
function PendingActions(
  { pending, busy, act }: {
    pending: PendingWire;
    busy: boolean;
    act: (body: () => Promise<unknown>) => Promise<void>;
  },
) {
  const { call } = useStore();
  return (
    <>
      <button
        className="btn primary"
        type="button"
        disabled={busy}
        onClick={() =>
          void act(() =>
            call({
              t: "access-approve",
              publicKey: pending.publicKey,
              role: pending.requestedRole,
            })
          )}
      >
        Approve as {pending.requestedRole}
      </button>{" "}
      <button
        className="btn danger"
        type="button"
        disabled={busy}
        onClick={() => void act(() => call({ t: "access-deny", publicKey: pending.publicKey }))}
      >
        Deny
      </button>
    </>
  );
}

/**
 * 25.35 — revoking, and changing a role, ask first.
 *
 * Both were immediate. Revoking cuts a device off mid-session and cannot be undone by clicking
 * again — the device has to ask and be approved from scratch. And the role control was a bare
 * `<select>`, so a mis-scroll on a trackpad silently promoted a phone to admin with no moment at
 * which anything said so.
 */
function DeviceActions(
  { device, busy, act }: {
    device: DeviceWire;
    busy: boolean;
    act: (body: () => Promise<unknown>) => Promise<void>;
  },
) {
  const { call } = useStore();
  const [confirm, setConfirm] = useState<{ kind: "revoke" } | { kind: "role"; to: AccessRole }>();
  return (
    <>
      <select
        value={device.role}
        disabled={busy}
        aria-label={`Role for ${device.name}`}
        onChange={(e) => setConfirm({ kind: "role", to: e.target.value as AccessRole })}
      >
        <option value="read">read</option>
        <option value="write">write</option>
        <option value="admin">admin</option>
      </select>{" "}
      <button
        className="btn danger"
        type="button"
        disabled={busy}
        onClick={() => setConfirm({ kind: "revoke" })}
      >
        Revoke
      </button>

      {confirm?.kind === "revoke" && (
        <Dialog
          title={`Revoke ${device.name}?`}
          body={`That device loses access immediately, including any session it has open now. It can ask again, and would have to be approved again.`}
          confirmLabel="Revoke it"
          danger
          busy={busy}
          onConfirm={async () => {
            setConfirm(undefined);
            await act(() => call({ t: "access-revoke", publicKey: device.publicKey }));
          }}
          onCancel={() => setConfirm(undefined)}
        />
      )}
      {confirm?.kind === "role" && (
        <Dialog
          title={`Make ${device.name} ${confirm.to}?`}
          body={confirm.to === "admin"
            ? "An admin can approve other devices, change roles, and revoke this one. It is the role that can hand out its own role."
            : `That device can ${
              confirm.to === "read" ? "read everything and change nothing" : "record and edit work"
            } from now on.`}
          confirmLabel={`Make it ${confirm.to}`}
          danger={confirm.to === "admin"}
          busy={busy}
          onConfirm={async () => {
            const role = confirm.to;
            setConfirm(undefined);
            await act(() => call({ t: "access-set-role", publicKey: device.publicKey, role }));
          }}
          onCancel={() => setConfirm(undefined)}
        />
      )}
    </>
  );
}

export function Admin() {
  const [tab, setTab] = useState<"access" | "logs">("access");
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row between wrap">
        <h1>Admin</h1>
        <div className="row">
          <button
            className="btn"
            type="button"
            aria-pressed={tab === "access"}
            onClick={() => setTab("access")}
          >
            Device access
          </button>
          <button
            className="btn"
            type="button"
            aria-pressed={tab === "logs"}
            onClick={() => setTab("logs")}
          >
            Server logs
          </button>
        </div>
      </div>
      {tab === "access" ? <Access /> : <Logs />}
    </div>
  );
}

function Access() {
  const { call, snapshot } = useStore();
  // 23.2 — a phone gets a different layout, not a narrower one. These are the widest tables in the
  // app: on a 390px screen the desktop version pushes Revoke, and every one of the three grant
  // buttons, off the right-hand edge of a horizontal scroller. Reachable by scrolling is not the
  // same as reachable, and 23.6 asks for every capability to be *reachable* on a phone.
  const stacked = usePresentation() === "mobile";
  const [pending, setPending] = useState<PendingWire[]>();
  const [devices, setDevices] = useState<DeviceWire[]>();
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setPending(await call<PendingWire[]>({ t: "access-pending" }));
    setDevices(await call<DeviceWire[]>({ t: "access-devices" }));
  };

  /**
   * 13.25, 1.12 — reload whenever the store's snapshot is replaced, which is what the store does
   * for every event the server pushes.
   *
   * This screen used to load once, with an `if (pending === undefined) void load()`. So an admin
   * sitting on this very screen when a new device asked for access saw nothing: `access-request`
   * broadcasts, the store refreshes, and these two lists carried on showing what they had fetched
   * on mount. The request appeared only if you navigated away and back. "Show pending requests to
   * admins" is not much use if the showing happens before the request does.
   */
  useEffect(() => {
    void load();
    // `load` is redefined every render; depending on it would loop. The snapshot is the signal.
  }, [snapshot]);

  const act = async (body: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await body();
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card">
        <h3>Pending requests</h3>
        {
          /*
          25.1 — this said `pending?.length === 0`, which is *false* while `pending` is undefined,
          so a screen that had not loaded yet fell through to `(pending ?? []).map` and drew an
          empty card with no words in it. "Nothing waiting" would have been a lie; nothing at all
          was worse.
        */
        }
        <Listing items={pending} empty="Nothing waiting.">
          {(rows) =>
            stacked
              ? (
                <div className="entries">
                  {rows.map((p) => (
                    <div className="stacked-row" key={p.publicKey}>
                      <div className="what">
                        {/* 13.38 — a name is a display string. It is not evidence of anything. */}
                        <strong>{p.name}</strong>
                        <span className="faint mono">{p.fingerprint}</span>
                        <span className="faint">
                          asked for {p.requestedRole} · {dateTime(p.requestedAt)}
                        </span>
                      </div>
                      <div className="acts wrap">
                        <PendingActions pending={p} busy={busy} act={act} />
                      </div>
                    </div>
                  ))}
                </div>
              )
              : (
                <div className="scroll-x">
                  <table>
                    <thead>
                      <tr>
                        <th>Device name</th>
                        <th>Asked for</th>
                        <th>Key fingerprint</th>
                        <th>Requested</th>
                        <th>Grant</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((p) => (
                        <tr key={p.publicKey}>
                          {/* 13.38 — a name is a display string, not evidence of anything. */}
                          <td>{p.name}</td>
                          <td>
                            <span className="pill">{p.requestedRole}</span>
                          </td>
                          <td className="mono">{p.fingerprint}</td>
                          <td className="muted">{dateTime(p.requestedAt)}</td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            <PendingActions pending={p} busy={busy} act={act} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
        </Listing>
      </div>

      <div className="card">
        <h3>Authorised devices</h3>
        {/* 25.1 — the same fault as the pending list: undefined and empty drew the same nothing. */}
        <Listing items={devices} empty="No devices are authorised.">
          {(rows) => (
            <>
              {stacked && (
                <div className="entries">
                  {rows.map((d) => (
                    <div className="stacked-row" key={d.publicKey}>
                      <div className="what">
                        <strong>{d.name}</strong>
                        <span className="faint mono">{fingerprintOf(d.publicKey)}</span>
                        <span className="faint">
                          last seen {d.lastSeenAt ? dateTime(d.lastSeenAt) : "never"}
                        </span>
                      </div>
                      <div className="acts wrap">
                        <DeviceActions device={d} busy={busy} act={act} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!stacked && (
                <div className="scroll-x">
                  <table>
                    <thead>
                      <tr>
                        <th>Device name</th>
                        <th>Key fingerprint</th>
                        <th>Last seen</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((d) => (
                        <tr key={d.publicKey}>
                          <td>{d.name}</td>
                          <td className="mono">{fingerprintOf(d.publicKey)}</td>
                          <td className="muted">
                            {d.lastSeenAt ? dateTime(d.lastSeenAt) : "never"}
                          </td>
                          <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                            <DeviceActions device={d} busy={busy} act={act} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </Listing>
        <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>
          Revoking takes effect at once, including on a device that is connected right now.
        </p>
      </div>
    </>
  );
}

function fingerprintOf(base64: string): string {
  const raw = atob(base64);
  return [...raw.slice(0, 8)]
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join(":");
}

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

function Logs() {
  const { call } = useStore();
  const [entries, setEntries] = useState<LogEntry[]>();
  const [minLevel, setMinLevel] = useState<LogLevel>("info");
  const [sinceHours, setSinceHours] = useState(24);

  const [loadedAt, setLoadedAt] = useState<number>();

  const load = async (level: LogLevel, since: number) => {
    setEntries(
      await call<LogEntry[]>({
        t: "logs",
        minLevel: level,
        from: Date.now() - since * 3_600_000,
        limit: 300,
      }),
    );
    setLoadedAt(Date.now());
  };

  /**
   * Loaded once, and re-loaded on request — deliberately unlike the other screens.
   *
   * Everything else here follows the store's snapshot, but a log is appended to constantly and a
   * list that reorders itself while somebody is reading a line is worse than one that is a minute
   * stale. What it must not be is *silently* stale with no way out, which is what this was: no
   * refresh control existed at all, so the only way to see a newer line was to leave the screen and
   * come back. Hence the button, and hence saying when this was fetched.
   */
  useEffect(() => {
    void load(minLevel, sinceHours);
    // Mount only: the filters call `load` themselves, and the button is the other way in.
  }, []);

  return (
    <div className="card">
      <div className="row between wrap" style={{ marginBottom: 12 }}>
        <h3>Server logs</h3>
        {/* 12.12 */}
        <div className="row">
          <select
            value={minLevel}
            onChange={(e) => {
              const level = e.target.value as LogLevel;
              setMinLevel(level);
              void load(level, sinceHours);
            }}
          >
            {LEVELS.map((l) => <option key={l} value={l}>{l} and above</option>)}
          </select>
          <select
            value={sinceHours}
            onChange={(e) => {
              const since = Number(e.target.value);
              setSinceHours(since);
              void load(minLevel, since);
            }}
          >
            <option value={1}>Last hour</option>
            <option value={24}>Last 24 hours</option>
            <option value={168}>Last 7 days</option>
            <option value={720}>Last 30 days</option>
          </select>
          <button
            className="btn"
            type="button"
            onClick={() => void load(minLevel, sinceHours)}
          >
            Refresh
          </button>
        </div>
      </div>
      {loadedAt !== undefined && (
        <p className="faint" style={{ fontSize: 12, marginTop: -4 }}>
          As at {dateTime(loadedAt)}. This view does not follow along by itself.
        </p>
      )}
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Level</th>
              <th>Source</th>
              <th>Message</th>
              <th>Device</th>
            </tr>
          </thead>
          <tbody>
            {(entries ?? []).map((e) => (
              <tr key={e.id}>
                <td className="tabular muted" style={{ whiteSpace: "nowrap" }}>
                  {dateTime(e.at)}
                </td>
                <td>
                  <span
                    className={`pill ${
                      e.level === "error" ? "bad" : e.level === "warn" ? "warn" : ""
                    }`}
                  >
                    {e.level.toUpperCase()}
                  </span>
                </td>
                <td className="muted">{e.source}</td>
                <td>
                  {e.message}
                  {e.context && (
                    <div className="mono faint" style={{ marginTop: 2 }}>
                      {JSON.stringify(e.context)}
                    </div>
                  )}
                </td>
                <td className="mono faint">{e.deviceFingerprint ?? ""}</td>
              </tr>
            ))}
            {entries?.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">Nothing in this range.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
