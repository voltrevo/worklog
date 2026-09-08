/**
 * Device access and the server log (19.12, 19.13, sections 12 and 13).
 *
 * **The approve control asks for a role rather than accepting the one that was requested** (13.28).
 * A one-tap Approve next to "requested: admin" is a button that grants admin, and the request is
 * a string an unauthorized device chose. The role is picked here, by the person approving.
 */

import { useState } from "react";
import { useStore } from "../state.tsx";
import { dateTime } from "../format.ts";
import type { AccessRole } from "@worklog/shared/auth";
import type { LogEntry, LogLevel } from "@worklog/shared/protocol";

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
  const { call } = useStore();
  const [pending, setPending] = useState<PendingWire[]>();
  const [devices, setDevices] = useState<DeviceWire[]>();
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setPending(await call<PendingWire[]>({ t: "access-pending" }));
    setDevices(await call<DeviceWire[]>({ t: "access-devices" }));
  };
  if (pending === undefined) void load();

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
        {pending?.length === 0
          ? (
            <p className="muted" style={{ margin: "8px 0 0" }}>
              Nothing waiting.
            </p>
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
                  {(pending ?? []).map((p) => (
                    <tr key={p.publicKey}>
                      {/* 13.38 — a name is a display string. It is not evidence of anything. */}
                      <td>{p.name}</td>
                      <td>
                        <span className="pill">{p.requestedRole}</span>
                      </td>
                      <td className="mono">{p.fingerprint}</td>
                      <td className="muted">{dateTime(p.requestedAt)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {(["read", "write", "admin"] as AccessRole[]).map((
                          role,
                        ) => (
                          <button
                            key={role}
                            className="btn"
                            type="button"
                            disabled={busy}
                            style={{ marginRight: 4 }}
                            onClick={() =>
                              void act(() =>
                                call({
                                  t: "access-approve",
                                  publicKey: p.publicKey,
                                  role,
                                })
                              )}
                          >
                            {role}
                          </button>
                        ))}
                        <button
                          className="btn danger"
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void act(() => call({ t: "access-deny", publicKey: p.publicKey }))}
                        >
                          Deny
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>

      <div className="card">
        <h3>Authorised devices</h3>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Device name</th>
                <th>Role</th>
                <th>Key fingerprint</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(devices ?? []).map((d) => (
                <tr key={d.publicKey}>
                  <td>{d.name}</td>
                  <td>
                    <select
                      value={d.role}
                      disabled={busy}
                      onChange={(e) =>
                        void act(() =>
                          call({
                            t: "access-set-role",
                            publicKey: d.publicKey,
                            role: e.target.value as AccessRole,
                          })
                        )}
                    >
                      <option value="read">read</option>
                      <option value="write">write</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="mono">{fingerprintOf(d.publicKey)}</td>
                  <td className="muted">
                    {d.lastSeenAt ? dateTime(d.lastSeenAt) : "never"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn danger"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void act(() => call({ t: "access-revoke", publicKey: d.publicKey }))}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

  const load = async (level: LogLevel, since: number) => {
    setEntries(
      await call<LogEntry[]>({
        t: "logs",
        minLevel: level,
        from: Date.now() - since * 3_600_000,
        limit: 300,
      }),
    );
  };
  if (entries === undefined) void load(minLevel, sinceHours);

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
        </div>
      </div>
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
